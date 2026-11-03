// Integration only. Fixture is a synthesized score excerpt, not a student recording.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
const fixture=process.argv[2];if(!fixture)throw new Error('Pass a PCM16 WAV fixture');
const b=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${fixture}`]});
const errors=[];const reports=[];
try{
  const context=await b.newContext({permissions:['microphone'],viewport:{width:1440,height:1050}});
  const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));
  await p.goto('http://localhost:8765/#practice');
  await p.waitForFunction(()=>document.querySelector('#practice-status').textContent.includes('曲谱已就绪'),null,{timeout:25000});
  await p.locator('#practice-mode').selectOption('timed');
  assert.equal(await p.locator('#practice-score-render svg').count(),1);
  // Original assets and repeated ordinary edition load correctly.
  await p.locator('#practice-difficulty').selectOption('normal');
  await p.waitForFunction(()=>document.querySelector('#practice-score-meta').textContent.includes('69 小节'));
  await p.waitForFunction(()=>document.querySelector('#practice-status').textContent.startsWith('曲谱已就绪'));
  await p.locator('#practice-notation').selectOption('dual');
  await p.waitForFunction(()=>{const i=document.querySelector('#practice-score-image');return i.complete&&i.naturalWidth>0;});
  await p.locator('#practice-difficulty').selectOption('easy');
  await p.waitForFunction(()=>document.querySelector('#practice-score-meta').textContent.includes('37 小节'));
  await p.locator('#practice-notation').selectOption('staff');
  await p.waitForFunction(()=>document.querySelector('#practice-score-render svg'));
  await p.locator('#practice-end-measure').fill('4');
  await p.locator('#audio-upload').setInputFiles({name:'听妈妈的话-合成测试-非学生实弹.wav',mimeType:'audio/wav',buffer:await readFile(fixture)});
  await p.waitForFunction(()=>[...document.querySelector('#practice-recording').options].some(o=>o.textContent.includes('合成测试')),null,{timeout:15000});
  const recordId=await p.locator('#practice-recording option').evaluateAll(options=>options.find(o=>o.textContent.includes('合成测试')).value);
  await p.locator('#practice-recording').selectOption(recordId);
  // Test base and a real trained checkpoint separately without promoting it.
  const versions=await p.locator('#practice-model option').evaluateAll(options=>options.map(o=>o.value).filter(v=>v!=='active'));
  for(const version of versions.slice(0,2)){
    await p.locator('#practice-model').selectOption(version);
    await p.locator('#practice-analyze').click();
    const response=await p.waitForResponse(r=>r.url().endsWith('/practice/compare')&&r.request().method()==='POST',{timeout:30000});
    const report=await response.json();assert.ok(report.metrics.tp>0);assert.ok(report.observedNotes.length>0);
    reports.push({kind:'uploaded-synthesized-excerpt',version,...report});
    await p.waitForFunction(()=>document.querySelectorAll('.practice-metric').length===4);
  }
  await p.screenshot({path:'test-evidence/studio-practice-result.png',fullPage:true});
  // Real browser AudioWorklet -> WebSocket -> selected candidate -> comparison.
  await p.locator('#practice-mode').selectOption('follow');
  await p.locator('#practice-mic-start').click();
  await p.waitForFunction(()=>!document.querySelector('#practice-mic-stop').disabled,null,{timeout:15000});
  await p.waitForFunction(()=>document.querySelector('#practice-status').textContent.includes('已分析'),null,{timeout:20000});
  await p.locator('#practice-mic-stop').click();
  await p.waitForFunction(()=>document.querySelector('#practice-status').textContent.startsWith('已处理完成'),null,{timeout:20000});
  await p.waitForFunction(()=>document.querySelectorAll('.practice-metric').length===4);
  await p.waitForFunction(()=>!document.querySelector('#practice-review-recording').hidden);
  assert.ok(await p.locator('#practice-difference-body select').count()>0);
  await p.screenshot({path:'test-evidence/studio-follow-result.png',fullPage:true});
  reports.push({kind:'virtual-microphone-follow',progress:await p.locator('#follow-progress').textContent(),
    feedback:await p.locator('#follow-feedback').textContent(),savedRecording:true});
  await p.locator('#practice-review-recording').click();
  await p.waitForFunction(()=>document.querySelector('#record-title').textContent.includes('跟弹录音'));
  assert.ok(await p.locator('#audio-player').evaluate(a=>Boolean(a.src)));
  await p.locator('.nav-item[data-view="recordings"]').click();
  await p.locator('.record-item').filter({hasText:'合成测试'}).first().click();
  await p.waitForFunction(()=>document.querySelector('#record-title').textContent.includes('合成测试'));
  assert.equal(await p.locator('#audio-player').evaluate(a=>Boolean(a.src)),true);
  await p.screenshot({path:'test-evidence/studio-recording-editor.png',fullPage:true});
  await p.locator('.nav-item[data-view="training"]').click();
  await p.waitForFunction(()=>document.querySelector('#training-state').textContent==='已完成');
  await p.screenshot({path:'test-evidence/studio-training.png',fullPage:true});
  for(const width of [768,390]){
    await p.setViewportSize({width,height:900});
    await p.locator('.nav-item[data-view="practice"]').click();
    assert.ok(await p.evaluate(()=>document.body.scrollWidth<=innerWidth+1));
    await p.screenshot({path:`test-evidence/studio-practice-${width}.png`,fullPage:true});
  }
  assert.deepEqual(errors,[]);
  await writeFile('test-evidence/studio-browser.json',JSON.stringify({errors,fixture:'synthesized score excerpt, not student recording',reports},null,2));
  console.log(JSON.stringify({errors,reports:reports.map(r=>({kind:r.kind,version:r.version,metrics:r.metrics}))},null,2));
}finally{await b.close();}
