import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';

const base=process.env.PIANOVAL_TEST_BASE||'http://localhost:8765';
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
const errors=[],samples=[],versions=[];
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  // Test hooks stay in the browser route; the deployed application exposes none.
  await page.route('**/static/practice.js*',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:(await response.text())+'\nwindow.cursorProbe={get osmd(){return osmd},get score(){return score},paintPlayback,updateCursor};'});
  });
  await page.goto(base+'/#practice');
  if(new URL(page.url()).pathname.endsWith('/auth/login')){
    if(!process.env.PIANOVAL_TEST_USERNAME||!process.env.PIANOVAL_TEST_PASSWORD)throw new Error('Set PIANOVAL_TEST_USERNAME and PIANOVAL_TEST_PASSWORD');
    await page.locator('[name=username]').fill(process.env.PIANOVAL_TEST_USERNAME);
    await page.locator('[name=password]').fill(process.env.PIANOVAL_TEST_PASSWORD);
    await page.getByRole('button',{name:'登录',exact:true}).click();
  }
  const ready=()=>page.waitForFunction(()=>window.cursorProbe?.osmd&&document.querySelector('#practice-status').textContent.startsWith('曲谱已就绪'));
  await ready();
  async function choose(piece,version) {
    if(await page.locator('#practice-piece').inputValue()!==piece) {await page.locator('#practice-piece').selectOption(piece);await ready();}
    if(await page.locator('#practice-difficulty').inputValue()!==version) {await page.locator('#practice-difficulty').selectOption(version);await ready();}
  }
  async function sample(time) {
    return page.evaluate(time=>{
      const {osmd,paintPlayback,score}=window.cursorProbe;paintPlayback(time);
      const cursor=osmd.cursor,box=cursor.cursorElement.getBoundingClientRect();
      const noteheads=cursor.GNotesUnderCursor().filter(note=>!note.sourceNote.isRest())
        .flatMap(note=>note.getNoteheadSVGs()||[]).map(note=>{const rect=note.getBoundingClientRect();return rect.left+rect.width/2;});
      return {time,quarter:cursor.Iterator.CurrentSourceTimestamp.RealValue*4,
        printedMeasure:cursor.Iterator.CurrentMeasureIndex+1,
        position:document.querySelector('#practice-position').textContent,
        keys:[...document.querySelectorAll('.reference-playing')].map(key=>Number(key.dataset.midi)),
        cursorCenter:box.left+box.width/2,cursorWidth:box.width,noteheads,piece:score.id,difficulty:score.difficulty};
    },time);
  }
  // During a held note the cursor must not anticipate the next attack.
  for(const [time,quarter,keys]of [[.1,0,[48]],[.4,0,[48]],[.7,1,[48,64]],[1.2,1,[48,64]],
    [1.4,2,[48,62]],[1.9,2,[48,62]],[2,3,[48,65]],[.4,0,[48]],[25.9,40,[50,69]]]) {
    const value=await sample(time);assert.equal(value.quarter,quarter,JSON.stringify(value));
    assert.deepEqual(value.keys.sort((a,b)=>a-b),keys);
    for(const x of value.noteheads)assert.ok(Math.abs(x-value.cursorCenter)<value.cursorWidth/2+1,JSON.stringify(value));
    samples.push(value);
  }
  await choose('listen-to-mom','normal');
  for(const [index,expected]of [[35,36],[36,5],[37,6],[66,35],[67,37],[68,38]]) {
    const time=await page.evaluate(index=>window.cursorProbe.score.measureStartsSeconds[index]+.1,index);
    const value=await sample(time);assert.equal(value.printedMeasure,expected);samples.push(value);
  }
  await choose('piece-mvyyl7zaljt5','custom-jqb7526');
  for(const [index,expected]of [[31,32],[32,25],[37,30],[38,33],[40,35]]) {
    const time=await page.evaluate(index=>window.cursorProbe.score.measureStartsSeconds[index]+.05,index);
    const value=await sample(time);assert.equal(value.printedMeasure,expected);samples.push(value);
  }
  // Resizing OSMD can replace the iterator. The next frame must recover its position.
  await page.setViewportSize({width:1024,height:900});await page.waitForTimeout(300);
  const resized=await sample(1);assert.equal(resized.printedMeasure,1);
  const catalog=(await(await context.request.get(base+'/api/studio/practice/catalog')).json()).pieces;
  for(const piece of catalog)for(const version of piece.versions) {
    await choose(piece.id,version.id);
    const checks=await page.evaluate(()=>{
      const {score,osmd,updateCursor}=window.cursorProbe;
      return Array.from({length:score.bars},(_,index)=>{
        updateCursor(score.measureStartsSeconds[index]+.002);
        return {performance:index+1,expected:score.sourceMeasures[index],actual:osmd.cursor.Iterator.CurrentMeasureIndex+1};
      });
    });
    assert.ok(checks.every(check=>check.expected===check.actual),JSON.stringify({piece:piece.id,version:version.id,checks}));
    versions.push({piece:piece.id,version:version.id,measures:checks.length});
  }
  await choose('listen-to-mom','easy');await sample(66.6);
  await page.locator('#practice-sheet-scroll').scrollIntoViewIfNeeded();
  const layout=await page.evaluate(()=>{
    const sheet=document.querySelector('#practice-sheet-scroll').getBoundingClientRect(),svg=document.querySelector('#practice-score-render svg').getBoundingClientRect();
    return {height:sheet.height,svgHeight:svg.height,bottomGap:sheet.bottom-svg.bottom,
      keyboardGap:document.querySelector('#practice-keyboard').getBoundingClientRect().top-sheet.bottom};
  });
  assert.ok(layout.bottomGap<15);assert.ok(Math.abs(layout.keyboardGap)<1);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:'test-evidence/score-cursor-alignment.png'});
  await writeFile('test-evidence/score-cursor-alignment.json',JSON.stringify({base,errors,samples,versions,layout},null,2));
  console.log(JSON.stringify({base,errors,heldNoteSamples:samples.length,versions:versions.length,measures:versions.reduce((sum,v)=>sum+v.measures,0),layout}));
}finally{await browser.close();}
