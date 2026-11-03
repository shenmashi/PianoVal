import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {webkit} from '@playwright/test';

const base=(process.env.PIANOVAL_TEST_URL||'http://localhost:8765/').replace(/\/?$/,'/');
const username=process.env.PIANOVAL_TEST_USERNAME,password=process.env.PIANOVAL_TEST_PASSWORD;
if(!username||!password)throw new Error('Set PIANOVAL_TEST_USERNAME and PIANOVAL_TEST_PASSWORD for your test instance');
const browser=await webkit.launch();
try{
  const context=await browser.newContext({viewport:{width:1180,height:900},hasTouch:true});
  const page=await context.newPage(),errors=[],saved=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{
    if(response.request().method()==='POST'&&response.url().endsWith('/api/studio/test-runs')&&response.ok())saved.push(response.request().postDataJSON());
  });
  await page.goto(base+'#piano');
  await page.locator('[name=username]').fill(username);await page.locator('[name=password]').fill(password);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.locator('#logout').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#practice-status').textContent.startsWith('曲谱已就绪'),null,{timeout:60000});
  await page.locator('#practice-piece').selectOption('piece-mvz3s8o8c7b5');
  await page.waitForFunction(()=>document.querySelector('#practice-status').textContent.startsWith('曲谱已就绪')&&document.querySelector('#practice-bpm').value==='70',null,{timeout:30000});
  assert.equal(await page.locator('#follow-release').isEnabled(),false);
  await page.locator('#piano-start').click();
  await page.waitForFunction(()=>document.querySelector('#piano-ready-status').dataset.phase==='ready',null,{timeout:45000});
  assert.equal(await page.locator('#follow-release').isEnabled(),true);
  await page.locator('#simulator-wrong').click();
  await page.waitForFunction(()=>document.querySelector('#practice-difference-body').textContent.includes('等待，不前进'),null,{timeout:20000});
  assert.match(await page.locator('#follow-progress').textContent(),/^0 \/ /);
  await page.locator('#follow-release').click();
  assert.match(await page.locator('#follow-progress').textContent(),/^1 \/ .*人工放行 1/);
  assert.match(await page.locator('#practice-difference-body').textContent(),/老师人工放行/);
  await page.locator('#follow-next-measure').click();
  assert.match(await page.locator('#follow-recovery-position').textContent(),/第 2 小节/);
  await page.screenshot({path:'test-evidence/follow-recovery-webkit.png',fullPage:true});
  // Resume to the end without ending the capture connection or pretending recognition passed.
  for(let count=0;count<10&&await page.locator('#follow-next-measure').isEnabled();count++)await page.locator('#follow-next-measure').click();
  assert.match(await page.locator('#follow-target').textContent(),/片段已完成/);
  assert.match(await page.locator('#follow-feedback').textContent(),/模型匹配 0 组/);
  await page.locator('#piano-stop').click();
  await page.waitForFunction(()=>!document.querySelector('#piano-start').disabled,null,{timeout:45000});
  assert.equal(await page.locator('#follow-release').isEnabled(),false);
  const report=saved.at(-1);assert.ok(report?.manualOverrides.length);
  const stored=await(await context.request.get(base+'api/studio/test-runs/'+report.id)).json();
  assert.equal(stored.manuallyReleasedSteps,stored.steps.length);assert.equal(stored.recognizedSteps,0);
  assert.ok(stored.manualOverrides.every(row=>row.excludedFromRecognitionAccuracy));
  assert.equal(stored.decisions.filter(row=>row.action==='advance').length,0);
  assert.deepEqual(errors,[]);
  await writeFile('test-evidence/follow-recovery-webkit.json',JSON.stringify({base,browser:'WebKit',reportId:report.id,
    wrongNoteStillWaits:true,manualReleaseWorks:true,nextBarWorks:true,completeWithoutReconnect:true,
    totalSteps:stored.steps.length,recognizedSteps:stored.recognizedSteps,manuallyReleasedSteps:stored.manuallyReleasedSteps,
    persistedOverrides:stored.manualOverrides.length,errors},null,2));
  console.log(JSON.stringify({base,steps:stored.steps.length,manual:stored.manuallyReleasedSteps,errors}));
  await context.close();
}finally{await browser.close();}
