// Real browser/model integration. Fake microphone exercises recording transport only.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';

const catalog=JSON.parse(await readFile('static/scores/catalog.json','utf8'));
const fixture=process.argv[2];
if(!fixture)throw new Error('Pass a PCM16 WAV fixture for the fake microphone transport test');
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${fixture}`]});
const errors=[],versions=[],runs=[],microphone=[];
let page;
try{
  const context=await browser.newContext({permissions:['microphone'],viewport:{width:1440,height:1100}});
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const waitReady=()=>page.waitForFunction(()=>document.querySelector('#practice-status').textContent.startsWith('曲谱已就绪'),null,{timeout:30000});
  const get=async path=>(await page.request.get(`http://localhost:8765/api/studio${path}`)).json();
  await page.goto('http://localhost:8765/?v=catalog-1#piano');await waitReady();
  assert.equal(await page.locator('#practice-piece option').count(),14);
  async function choose(piece,version){
    if(await page.locator('#practice-piece').inputValue()!==piece){await page.locator('#practice-piece').selectOption(piece);await waitReady();}
    if(await page.locator('#practice-difficulty').inputValue()!==version){await page.locator('#practice-difficulty').selectOption(version);await waitReady();}
  }
  for(const piece of catalog){
    for(const version of piece.versions){
      await choose(piece.id,version.id);
      assert.equal(await page.locator('#practice-title').textContent(),piece.title);
      assert.equal(Number(await page.locator('#practice-bpm').inputValue()),version.tempo);
      assert.ok(await page.locator('#practice-score-render svg').count()>0);
      const bounds=await page.evaluate(()=>({score:document.querySelector('#practice-sheet-scroll').getBoundingClientRect().bottom,
        keyboard:document.querySelector('#practice-keyboard').getBoundingClientRect().top}));
      assert.ok(Math.abs(bounds.keyboard-bounds.score)<1,JSON.stringify(bounds));
      for(const notation of ['jianpu','dual']){
        const disabled=await page.locator(`#practice-notation option[value="${notation}"]`).evaluate(option=>option.disabled);
        assert.equal(disabled,!version.assets[notation],`${piece.id}/${version.id}/${notation}`);
      }
      versions.push({pieceId:piece.id,title:piece.title,version:version.id,tempo:version.tempo,keyboardGap:bounds.keyboard-bounds.score});
    }
  }
  await page.locator('#practice-notation').selectOption('dual');
  await page.waitForFunction(()=>{const image=document.querySelector('#practice-score-image');return image.complete&&image.naturalWidth>0;});
  await page.locator('#practice-notation').selectOption('staff');
  await page.waitForFunction(()=>!document.querySelector('#practice-score-render').hidden);
  const before=await page.locator('#practice-piece').inputValue();
  await page.locator('#practice-random').click();await waitReady();
  assert.notEqual(await page.locator('#practice-piece').inputValue(),before);

  const cases=[
    ['piece-mvz3s8o8c7b5','custom-r6f5430',1,2],
    ['piece-mvz3d7esr5fg','custom-8z4u217',1,2],
    ['piece-mvyyjo93xk3t','custom-ii50777',1,2],
    ['piece-mvz2oen46nl1','custom-lemq170',1,2],
    ['piece-mvyyd3mk2zte','custom-br8y359',1,2],
    ['piece-mvyyl7zaljt5','custom-jqb7526',33,34],
  ];
  for(const [piece,version,start,end] of cases){
    await choose(piece,version);
    await page.locator('#practice-start-measure').fill(String(start));
    await page.locator('#practice-end-measure').fill(String(end));await page.locator('#practice-end-measure').dispatchEvent('change');
    const savedResponse=page.waitForResponse(response=>response.url().endsWith('/test-runs')&&response.request().method()==='POST',{timeout:60000});
    await page.locator('#piano-auto-correct').click();
    const response=await savedResponse;assert.equal(response.status(),200);
    const saved=await response.json(),report=await get(`/test-runs/${saved.id}`);
    await page.waitForFunction(()=>!document.querySelector('#piano-start').disabled,null,{timeout:20000});
    assert.equal(report.status,'completed');assert.equal(report.settings.pieceId,piece);
    assert.equal(report.performedGroups,report.plannedGroups);assert.ok(report.plannedGroups>0);
    assert.equal(report.analysis.accuracy.evaluatedGroups,report.plannedGroups);
    assert.ok(report.recordingId&&report.stream.windows.length);
    assert.equal(report.scope,'synthetic-piano-direct-pcm');
    assert.ok(!('expected' in report.stream.context));
    runs.push({id:saved.id,piece,version,start,end,groups:report.plannedGroups,
      accuracy:report.analysis.accuracy.value,performance:report.performance,recordingId:report.recordingId});
    console.log(JSON.stringify(runs.at(-1)));
  }
  // A random-piece run also saves an honest partial report when stopped.
  const prior=await page.locator('#practice-piece').inputValue();
  const partialResponse=page.waitForResponse(r=>r.url().endsWith('/test-runs')&&r.request().method()==='POST',{timeout:45000});
  await page.locator('#piano-auto-random-piece').click();
  await page.waitForFunction(()=>!document.querySelector('#piano-auto-stop').disabled,null,{timeout:25000});
  assert.notEqual(await page.locator('#practice-piece').inputValue(),prior);
  await page.waitForTimeout(1000);await page.locator('#piano-auto-stop').click();
  const partial=await partialResponse;assert.equal(partial.status(),200);
  await page.waitForFunction(()=>!document.querySelector('#piano-start').disabled);
  assert.equal((await get(`/test-runs/${(await partial.json()).id}`)).status,'cancelled');
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000});
    assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth+1));
    const gap=await page.evaluate(()=>document.querySelector('#practice-keyboard').getBoundingClientRect().top-document.querySelector('#practice-sheet-scroll').getBoundingClientRect().bottom);
    assert.ok(Math.abs(gap)<1);
    await page.locator('#practice-sheet-scroll').scrollIntoViewIfNeeded();
    await page.screenshot({path:`test-evidence/catalog-layout-${width}.png`});
  }
  await page.setViewportSize({width:1440,height:1100});
  await choose('listen-to-mom','easy');
  await page.locator('#practice-input').selectOption('microphone');
  const micResponse=page.waitForResponse(r=>r.url().endsWith('/test-runs')&&r.request().method()==='POST',{timeout:30000});
  await page.locator('#practice-mic-start').click();
  await page.waitForFunction(()=>!document.querySelector('#practice-mic-stop').disabled);
  await page.waitForFunction(()=>document.querySelector('#practice-status').textContent.includes('已分析'),null,{timeout:15000});
  await page.waitForTimeout(1000);await page.locator('#practice-mic-stop').click();
  const micSaved=await micResponse;assert.equal(micSaved.status(),200);
  const micId=(await micSaved.json()).id;
  const micReport=await get(`/test-runs/${micId}`);
  assert.equal(micReport.scope,'microphone-unreviewed');assert.equal(micReport.analysis.accuracy,null);
  assert.ok(micReport.recordingId&&micReport.stream.windows.length);
  microphone.push({id:micId,recordingId:micReport.recordingId,scope:micReport.scope,status:micReport.status,fixture:'fake microphone, not real student evidence'});
  await page.waitForFunction(()=>!document.querySelector('#practice-mic-start').disabled);
  const review=page.locator('#practice-difference-body select').first();
  if(await review.count()){
    const reviewedResponse=page.waitForResponse(r=>r.url().endsWith('/test-runs')&&r.request().method()==='POST');
    await review.selectOption('should-advance');await reviewedResponse;
    assert.equal((await get(`/test-runs/${micId}`)).teacherReview.count,1);
  }
  // Refresh while microphone is active: raw server log and partial audio survive without a client report.
  const readyPromise=new Promise(resolve=>page.once('websocket',socket=>socket.on('framereceived',frame=>{
    if(typeof frame.payload==='string'){const value=JSON.parse(frame.payload);if(value.type==='ready')resolve(value);}
  })));
  await page.locator('#practice-mic-start').click();const ready=await readyPromise;
  await page.waitForFunction(()=>document.querySelector('#practice-status').textContent.includes('已分析'),null,{timeout:15000});
  await page.waitForTimeout(500);await page.reload();await waitReady();
  let interrupted;
  for(let i=0;i<50;i++){
    interrupted=await get(`/test-runs/${ready.sessionId}`);
    if(interrupted.status==='interrupted'&&interrupted.recordingId)break;
    await page.waitForTimeout(100);
  }
  assert.equal(interrupted.status,'interrupted');assert.ok(interrupted.recordingId);
  microphone.push({id:ready.sessionId,status:interrupted.status,recordingId:interrupted.recordingId,fixture:'fake microphone, browser refresh'});
  const history=(await get('/test-runs')).runs;
  assert.ok(history.some(run=>run.id===micId));
  assert.ok(history.some(run=>(run.id===ready.sessionId||run.id===interrupted.testId)&&run.recordingId===interrupted.recordingId));
  await page.locator('#piano-test-history').scrollIntoViewIfNeeded();
  await page.screenshot({path:'test-evidence/teacher-test-history.png'});
  // The history opens the retained audio in the recording editor.
  await page.locator('#piano-test-history tr').first().getByRole('button',{name:'录音复核'}).click();
  await page.waitForFunction(()=>document.querySelector('#audio-player').src&&document.querySelector('#record-title').textContent.includes('中断'));
  assert.deepEqual(errors,[]);
  await writeFile('test-evidence/catalog-history-browser.json',JSON.stringify({errors,versions,runs,microphone,realStudentAccuracy:'unmeasured'},null,2));
  console.log(JSON.stringify({errors,versions:versions.length,runs:runs.length,microphone}));
}catch(error){
  if(page){await page.screenshot({path:'test-evidence/catalog-history-failure.png',fullPage:true});console.error(await page.locator('#notice').textContent());}
  throw error;
}finally{await browser.close();}
