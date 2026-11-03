// Complete browser audio -> actual WebSocket model, including visible lower-table alignment.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
const base=process.env.PIANOVAL_TEST_URL||'http://localhost:8765';
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
const errors=[],reports=[],controls=[];
let page;
try{
  page=await browser.newPage({viewport:{width:1440,height:1050}});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('websocket',socket=>socket.on('framesent',frame=>{if(typeof frame.payload==='string')controls.push(JSON.parse(frame.payload));}));
  await page.goto(`${base}/?acceptance=4#piano`);
  await page.waitForFunction(()=>document.querySelector('#practice-status').textContent.includes('曲谱已就绪'));
  for(const hand of ['both','left','right']){
    await page.locator('#practice-hand').selectOption(hand);
    await page.locator('#practice-end-measure').fill('12');await page.locator('#practice-end-measure').dispatchEvent('change');
    await page.locator('#piano-auto-correct').click();
    await page.waitForFunction(()=>Number(document.querySelector('#piano-auto-accuracy').dataset.evaluated)>0,null,{timeout:20000});
    assert.equal(await page.locator('#practice-result-view').inputValue(),'automatic');
    assert.match(await page.locator('#piano-auto-latency').textContent(),/判定延迟 P50/);
    await page.waitForFunction(()=>!document.querySelector('#piano-start').disabled,null,{timeout:50000});
    const download=page.waitForEvent('download');await page.locator('#piano-auto-download').click();
    const path=`test-evidence/accuracy-${hand}-browser.json`;await(await download).saveAs(path);
    const result=JSON.parse(await readFile(path,'utf8'));reports.push(result);
    assert.equal(result.status,'completed');assert.equal(result.performedGroups,result.plannedGroups);
    assert.equal(result.analysis.totals.pendingGroups,0);assert.ok(result.analysis.accuracy.value>=.95,`${hand} below 95%: ${result.analysis.accuracy.value}`);
    assert.ok(result.performance.decisionLatency.count>0);assert.ok(result.performance.networkRtt.count>0);
    assert.ok(result.performance.decisionLatency.p95Ms<1000,`${hand} P95 over one second`);
    const rows=page.locator('#practice-difference-body tr');assert.equal(await rows.count(),result.analysis.rows.length);
    for(let index=0;index<result.analysis.rows.length;index++){
      const row=result.analysis.rows[index];assert.match(await rows.nth(index).locator('td').nth(1).textContent(),new RegExp(`第 ${index+1} 组`));
      assert.equal(await rows.nth(index).locator('td').nth(3).textContent(),row.heard.map(m=>['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'][m%12]+(Math.floor(m/12)-1)).join(' + ')||'—');
    }
    await page.locator('#practice-result-view').selectOption('follower');
    assert.equal(await page.locator('#practice-difference-body tr').count(),result.waitingFollower.decisions.length);
    await page.locator('#practice-result-view').selectOption('automatic');
    await page.locator('#simulator-controls').screenshot({path:`test-evidence/accuracy-${hand}-browser.png`});
    console.log(JSON.stringify({hand,accuracy:result.analysis.accuracy,performance:result.performance,follower:result.waitingFollower.completedSteps,groups:result.plannedGroups}));
  }
  await page.setViewportSize({width:390,height:1000});
  assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth+1));
  await page.locator('#simulator-controls').screenshot({path:'test-evidence/accuracy-390.png'});
  for(const control of controls){assert.ok(!('expected'in control));assert.ok(!('pitches'in control));assert.ok(!('plan'in control));}
  assert.deepEqual(errors,[]);
  await writeFile('test-evidence/accuracy-browser-summary.json',JSON.stringify({errors,reports:reports.map(r=>({hand:r.settings.hand,accuracy:r.analysis.accuracy,performance:r.performance,follower:r.waitingFollower.completedSteps,groups:r.plannedGroups}))},null,2));
}catch(error){
  if(page){await page.screenshot({path:'test-evidence/accuracy-failure.png',fullPage:true});console.error({errors,status:await page.locator('#practice-status').textContent(),notice:await page.locator('#notice').textContent()});}
  throw error;
}finally{await browser.close();}
