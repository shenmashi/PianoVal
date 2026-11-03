// Real sampled audio -> AudioWorklet PCM -> WebSocket -> actual pretrained model.
// The UI sends no expected MIDI to the model or follower.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';

const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
const errors=[],reports=[];
let page;
const received=[];
try {
  page=await browser.newPage({viewport:{width:1440,height:1050}});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('websocket',socket=>socket.on('framereceived',frame=>{
    if(typeof frame.payload==='string')received.push(JSON.parse(frame.payload));
  }));
  await page.goto('http://localhost:8765/#piano');
  await page.waitForFunction(()=>document.querySelector('#practice-status').textContent.includes('曲谱已就绪'));
  assert.equal(await page.locator('#practice-input').inputValue(),'piano');
  assert.equal(await page.locator('#practice-keyboard [data-midi]').count(),88);
  async function guidance(pitches) {
    assert.deepEqual(await page.locator('#practice-keyboard .piano-key.target').evaluateAll(keys=>keys.map(key=>Number(key.dataset.midi)).sort((a,b)=>a-b)),pitches);
    assert.equal(await page.locator('#piano-target-keys button').count(),pitches.length);
    for(const pitch of pitches)assert.equal(await page.locator(`#practice-keyboard [data-midi="${pitch}"] .piano-key-target-hint`).isVisible(),true);
  }
  await guidance([48]);
  assert.match(await page.locator('#piano-target-keys').textContent(),/C3Z/);
  assert.equal(await page.locator('#piano-ready-status').textContent(),'尚未开始');
  assert.equal(await page.locator('#piano-play-guided').isDisabled(),true);
  assert.equal(await page.locator('#practice-keyboard .target .piano-key-tap').textContent(),'点这里');

  async function start(hand,bar=1) {
    await page.locator('#practice-hand').selectOption(hand);
    await page.locator('#practice-start-measure').fill(String(bar));
    await page.locator('#practice-end-measure').fill(String(bar));
    await page.locator('#practice-end-measure').dispatchEvent('change');
    assert.equal(await page.locator('#notice.error:visible').count(),0);
    await page.locator('#piano-start').click();
    await page.waitForFunction(()=>document.querySelector('#practice-status').textContent.includes('模拟钢琴已就绪'),null,{timeout:20000});
    assert.equal(await page.locator('#piano-ready-status').textContent(),'可以弹了');
    assert.equal(await page.locator('#piano-play-guided').isEnabled(),true);
  }
  async function waitDecision(count) {
    await page.waitForFunction(count=>document.querySelectorAll('#practice-difference-body select').length>=count,count,{timeout:15000});
  }
  async function stop(kind) {
    await page.locator('#piano-stop').click();
    await page.waitForFunction(()=>!document.querySelector('#practice-mic-start').disabled,null,{timeout:20000});
    assert.equal(await page.locator('#practice-review-recording').isVisible(),true);
    const metrics=await page.locator('#simulator-evaluation').textContent();
    assert.match(metrics,/正确匹配/);
    reports.push({kind,metrics,progress:await page.locator('#follow-progress').textContent(),
      feedback:await page.locator('#piano-attempt-feedback').textContent(),
      decisions:await page.locator('#practice-difference-body tr').allTextContents()});
  }

  // Right hand: a wrong pitch must wait, then an actual E4 key advances.
  await start('right');
  assert.equal(await page.locator('#follow-target').textContent(),'E4');
  await guidance([64]);
  await page.locator('#simulator-wrong').click();
  await waitDecision(1);
  assert.match(await page.locator('#follow-progress').textContent(),/^0 \/ /);
  await guidance([64]);
  await page.locator('#practice-keyboard [data-midi="64"]').dispatchEvent('keydown',{code:'Enter'});
  await page.waitForTimeout(600);
  await page.locator('#practice-keyboard [data-midi="64"]').dispatchEvent('keyup',{code:'Enter'});
  await waitDecision(2);
  // A real model may hear an extra octave. Preserve and report this false block;
  // the test must not filter observations to make the correct key appear to pass.
  assert.ok(received.some(message=>message.events?.some(note=>note.midi===64)));
  assert.equal(await page.locator('#piano-attempt-played').textContent(),'E4');
  if(await page.locator('#piano-attempt-heard').textContent()==='E4 + E5'){
    assert.match(await page.locator('#piano-attempt-title').textContent(),/你已按对，模型识别出现偏差/);
    assert.match(await page.locator('#piano-attempt-detail').textContent(),/不是你点错/);
    assert.match(await page.locator('#follow-progress').textContent(),/^0 \/ /);
  }
  await page.screenshot({path:'test-evidence/piano-right-follow.png',fullPage:true});
  await stop('right-wrong-then-correct');

  // Left hand via the real computer keyboard mapping: C3 = Z at the default octave.
  await start('left');
  assert.equal(await page.locator('#follow-target').textContent(),'C3');
  await guidance([48]);
  await page.locator('#follow-target').click();
  await page.keyboard.down('z');await page.waitForTimeout(600);await page.keyboard.up('z');
  await waitDecision(1);
  assert.ok(received.some(message=>message.events?.some(note=>note.midi===48)));
  assert.match(await page.locator('#follow-progress').textContent(),/^1 \/ /);
  await guidance([]);
  assert.match(await page.locator('#piano-guidance-title').textContent(),/已完成/);
  await stop('left-computer-key');

  // Two hands, bar 5: only C4 is incomplete; C4+E5 together should advance.
  await start('both',5);
  assert.equal(await page.locator('#follow-target').textContent(),'C4 + E5');
  await guidance([60,76]);
  assert.match(await page.locator('#piano-guidance-title').textContent(),/同时按下 2 个/);
  const key=page.locator('#practice-keyboard [data-midi="60"]');
  await key.scrollIntoViewIfNeeded();
  const box=await key.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height-25);
  await page.mouse.down();await page.waitForTimeout(600);await page.mouse.up();
  await waitDecision(1);
  assert.match(await page.locator('#follow-progress').textContent(),/^0 \/ /);
  await page.locator('#piano-play-guided').click();
  await waitDecision(2);
  assert.ok(received.some(message=>message.events?.some(note=>note.midi===76)));
  await page.screenshot({path:'test-evidence/piano-both-follow.png',fullPage:true});
  await stop('both-incomplete-then-complete-chord');

  for(const width of [768,390]) {
    await page.setViewportSize({width,height:1000});
    assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth+1));
    await page.waitForFunction(()=>{
      const viewport=document.querySelector('#practice-keyboard').getBoundingClientRect();
      return [...document.querySelectorAll('#practice-keyboard .target')].every(key=>{
        const bounds=key.getBoundingClientRect();return bounds.left>=viewport.left&&bounds.right<=viewport.right;
      });
    });
    await page.screenshot({path:`test-evidence/piano-${width}.png`,fullPage:true});
  }
  await page.locator('#simulator-octave').selectOption('60');
  assert.match(await page.locator('#piano-target-keys').textContent(),/C4Z/);
  await page.locator('#practice-mode').selectOption('timed');
  assert.equal(await page.locator('#piano-key-guidance').isVisible(),true);
  assert.equal(await page.locator('#piano-enable-guidance').isVisible(),true);
  await guidance([]);
  await page.locator('#piano-enable-guidance').click();
  assert.equal(await page.locator('#practice-mode').inputValue(),'follow');
  await guidance([60,76]);
  await page.locator('#practice-input').selectOption('microphone');
  assert.equal(await page.locator('#piano-key-guidance').isVisible(),false);
  await guidance([]);
  await page.locator('[data-view="guide"]').first().click();
  assert.equal(await page.locator('#view-guide').isVisible(),true);
  const response=await page.request.get('http://localhost:8765/static/operator-guide.md');
  assert.equal(response.status(),200);
  assert.match(await response.text(),/虚拟钢琴/);
  assert.deepEqual(errors,[]);
  await writeFile('test-evidence/piano-browser.json',JSON.stringify({errors,reports},null,2));
  console.log(JSON.stringify({errors,reports},null,2));
} catch(error) {
  if(page){
    await page.screenshot({path:'test-evidence/piano-failure.png',fullPage:true});
    console.error(JSON.stringify({received,status:await page.locator('#practice-status').textContent(),
      triggered:await page.locator('#simulator-triggered').textContent(),decisions:await page.locator('#practice-difference-body').textContent()},null,2));
  }
  throw error;
} finally {await browser.close();}
