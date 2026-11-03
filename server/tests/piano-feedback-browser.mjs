// Reproduce a real mouse press -> PCM -> WebSocket -> model, and explain a false block.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
const errors=[],notes=[];
let page;
try {
  page=await browser.newPage({viewport:{width:1440,height:1050}});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('websocket',socket=>socket.on('framereceived',frame=>{
    if(typeof frame.payload==='string')notes.push(...(JSON.parse(frame.payload).events||[]));
  }));
  await page.goto('http://localhost:8765/?guide=4#piano');
  await page.waitForFunction(()=>document.querySelector('#practice-status').textContent.includes('曲谱已就绪'));
  await page.locator('#practice-hand').selectOption('right');
  await page.locator('#practice-end-measure').fill('1');
  await page.locator('#practice-end-measure').dispatchEvent('change');
  await page.locator('#practice-save-recording').uncheck();
  await page.locator('#piano-start').click();
  await page.waitForFunction(()=>document.querySelector('#piano-ready-status').dataset.phase==='ready',null,{timeout:20000});
  const key=page.locator('#practice-keyboard [data-midi="64"]');
  await key.scrollIntoViewIfNeeded();
  // Check the current target before playing: a successful recognition moves the hint away.
  assert.equal(await key.evaluate(key=>{
    const hint=key.querySelector('.piano-key-target-hint b').getBoundingClientRect();
    const bounds=key.getBoundingClientRect();return hint.left>=bounds.left-1&&hint.right<=bounds.right+1;
  }),true);
  const box=await key.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height-15);
  await page.mouse.down();
  assert.equal(await page.locator('#piano-attempt-played').textContent(),'E4');
  assert.match(await page.locator('#piano-attempt-title').textContent(),/已收到你的按键/);
  await page.waitForTimeout(600);await page.mouse.up();
  await page.waitForFunction(()=>['model-mismatch','passed'].includes(document.querySelector('#piano-attempt-feedback').dataset.state),null,{timeout:15000});
  assert.ok(notes.some(note=>note.midi===64));
  const state=await page.locator('#piano-attempt-feedback').getAttribute('data-state');
  if(state==='model-mismatch'){
    assert.match(await page.locator('#piano-attempt-title').textContent(),/你已按对/);
    assert.doesNotMatch(await page.locator('#follow-feedback').textContent(),/请纠正后再试/);
    assert.match(await page.locator('#follow-progress').textContent(),/^0 \/ /);
  }else{
    assert.match(await page.locator('#follow-progress').textContent(),/^1 \/ /);
    assert.notEqual(await page.locator('#follow-target').textContent(),'E4');
  }
  const feedback=await page.locator('#piano-attempt-feedback').textContent();
  const progress=await page.locator('#follow-progress').textContent();
  await page.locator('.practice-score-card').screenshot({path:'test-evidence/piano-click-diagnosis.png'});
  await page.setViewportSize({width:390,height:1000});
  assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth+1));
  await page.locator('#piano-stop').click();
  await page.waitForFunction(()=>!document.querySelector('#piano-start').disabled,null,{timeout:20000});
  assert.deepEqual(errors,[]);
  const result={errors,input:'Actual mouse press E4, held 600 ms',state,feedback,progress,modelEvents:notes};
  await writeFile('test-evidence/piano-click-diagnosis.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} catch(error){
  if(page)console.error(JSON.stringify({errors,status:await page.locator('#practice-status').textContent(),feedback:await page.locator('#piano-attempt-feedback').textContent(),liveError:await page.locator('#error').textContent(),notes},null,2));
  throw error;
} finally {await browser.close();}
