// One-click real sampled audio -> PCM/WebSocket -> actual model -> downloadable results.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
const errors=[],reports=[],controls=[],received=[];
let page;
try {
  page=await browser.newPage({viewport:{width:1440,height:1050}});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('websocket',socket=>{
    socket.on('framesent',frame=>{if(typeof frame.payload==='string')controls.push(JSON.parse(frame.payload));});
    socket.on('framereceived',frame=>{if(typeof frame.payload==='string')received.push(JSON.parse(frame.payload));});
  });
  await page.goto('http://localhost:8765/?auto=1#piano');
  await page.waitForFunction(()=>document.querySelector('#practice-status').textContent.includes('曲谱已就绪'));
  async function select(hand,start=1,end=2){
    await page.locator('#practice-hand').selectOption(hand);
    await page.locator('#practice-start-measure').fill(String(start));
    await page.locator('#practice-end-measure').fill(String(end));
    await page.locator('#practice-end-measure').dispatchEvent('change');
  }
  async function download(kind){
    const event=page.waitForEvent('download');await page.locator('#piano-auto-download').click();
    const file=await event,path=`test-evidence/piano-auto-${kind}.json`;await file.saveAs(path);
    const result=JSON.parse(await readFile(path,'utf8'));
    reports.push({kind,status:result.status,plannedGroups:result.plannedGroups,performedGroups:result.performedGroups,metrics:result.recognitionMetrics,totals:result.analysis.totals,follower:result.waitingFollower.completedSteps});
    return result;
  }
  async function complete(){
    await page.waitForFunction(()=>!document.querySelector('#piano-auto-result').hidden&&!document.querySelector('#piano-start').disabled,null,{timeout:40000});
    assert.equal(await page.locator('#notice.error:visible').count(),0);
    assert.equal(await page.locator('#piano-auto-stop').isDisabled(),true);
    const values=await page.locator('#piano-auto-accuracy').evaluate(node=>({text:node.textContent,evaluated:Number(node.dataset.evaluated),correct:Number(node.dataset.correctDecisions)}));
    assert.equal(values.text,values.evaluated?`${(values.correct/values.evaluated*100).toFixed(1)}%`:'—');
  }
  await select('both',1,8);
  // Starting an automatic run after manual input must finish the previous recording first.
  await page.locator('#piano-start').click();
  await page.waitForFunction(()=>document.querySelector('#piano-ready-status').dataset.phase==='ready',null,{timeout:20000});
  await page.locator('#simulator-target').click();
  await page.waitForTimeout(300);
  const previousStarts=controls.filter(message=>message.type==='start').length;
  await page.locator('#piano-auto-correct').click();
  await page.waitForFunction(()=>!document.querySelector('#piano-auto-stop').disabled,null,{timeout:20000});
  assert.equal(await page.locator('#simulator-target').isDisabled(),true);
  assert.equal(await page.locator('#piano-auto-random').isDisabled(),true);
  await page.waitForFunction(()=>Number(document.querySelector('#piano-auto-accuracy').dataset.evaluated)>0,null,{timeout:12000});
  const live=await page.locator('#piano-auto-accuracy').evaluate(node=>({text:node.textContent,evaluated:Number(node.dataset.evaluated),correct:Number(node.dataset.correctDecisions)}));
  assert.ok(live.evaluated<25);assert.equal(live.text,`${(live.correct/live.evaluated*100).toFixed(1)}%`);
  assert.equal(await page.locator('#piano-auto-download').isDisabled(),true);
  assert.match(await page.locator('#piano-auto-accuracy-label').textContent(),/实时/);
  await complete();
  const correct=await download('correct');
  assert.equal(controls.filter(message=>message.type==='start').length,previousStarts+1);
  assert.equal(correct.status,'completed');assert.equal(correct.performedGroups,correct.plannedGroups);
  assert.equal(correct.plannedGroups,25);
  assert.equal(correct.analysis.accuracy.evaluatedGroups,25);assert.equal(correct.analysis.totals.pendingGroups,0);
  assert.match(await page.locator('#piano-auto-accuracy-label').textContent(),/最终/);
  assert.equal(correct.analysis.accuracy.value,(correct.analysis.totals.correctPasses+correct.analysis.totals.detectedErrors)/25);
  assert.equal(correct.analysis.totals.injectedErrors,0);assert.ok(correct.modelEvents.length>0);
  for(const group of correct.analysis.rows)assert.deepEqual(group.pitches,group.expected);
  assert.ok(correct.actualTriggeredNotes.length>0);
  const chord=correct.analysis.rows.find(group=>group.expected.length>1);assert.ok(chord);
  const chordNotes=correct.actualTriggeredNotes.filter(note=>Math.abs(note.onsetSeconds-chord.audioOnsetSeconds)<.001);
  assert.deepEqual(chordNotes.map(note=>note.midi).sort((a,b)=>a-b),chord.pitches);
  assert.equal(correct.waitingFollower.completedSteps,Number((await page.locator('#follow-progress').textContent()).split('/')[0]));
  await page.locator('#simulator-controls').screenshot({path:'test-evidence/piano-auto-correct.png'});

  await select('both',1,2);await page.locator('#piano-auto-error-rate').selectOption('0.5');
  await page.locator('#piano-auto-random').click();await complete();
  const random=await download('random');
  assert.equal(random.status,'completed');assert.equal(random.performedGroups,random.plannedGroups);
  assert.equal(random.analysis.totals.injectedErrors,Math.round(random.plannedGroups*.5));
  for(const group of random.analysis.rows){if(group.error!=='none')assert.notDeepEqual(group.pitches,group.expected);}
  await page.locator('#simulator-controls').screenshot({path:'test-evidence/piano-auto-random.png'});

  // Also support clicking auto after manually starting a clean capture session.
  await select('left',1,8);await page.locator('#piano-start').click();
  await page.waitForFunction(()=>document.querySelector('#piano-ready-status').dataset.phase==='ready',null,{timeout:20000});
  const starts=controls.filter(message=>message.type==='start').length;
  await page.locator('#piano-auto-correct').click();await complete();
  const left=await download('left');assert.equal(left.plan.hand,'left');assert.equal(left.plannedGroups,8);
  assert.equal(left.analysis.accuracy.evaluatedGroups,8);
  assert.equal(controls.filter(message=>message.type==='start').length,starts); // Clean session was reused.

  await select('right',1,8);await page.locator('#piano-auto-correct').click();await complete();
  const right=await download('right');assert.equal(right.plan.hand,'right');assert.equal(right.plannedGroups,21);
  assert.equal(right.analysis.accuracy.evaluatedGroups,21);

  await select('both',1,8);await page.locator('#piano-auto-correct').click();
  await page.waitForFunction(()=>document.querySelector('#piano-auto-progress').textContent.includes('已演奏 1 /'),null,{timeout:20000});
  await page.waitForTimeout(350);
  await page.locator('#piano-auto-stop').click();await complete();
  const cancelled=await download('cancelled');assert.equal(cancelled.status,'cancelled');assert.ok(cancelled.performedGroups>=1&&cancelled.performedGroups<cancelled.plannedGroups);
  await page.setViewportSize({width:390,height:1000});
  assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth+1));
  await page.locator('#simulator-controls').screenshot({path:'test-evidence/piano-auto-390.png'});

  // A background/capture failure must release the automated player and expose a partial failed report.
  await page.setViewportSize({width:1440,height:1050});
  await page.locator('#piano-auto-correct').click();
  await page.waitForFunction(()=>document.querySelector('#piano-auto-progress').textContent.includes('已演奏 1 /'),null,{timeout:20000});
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>document.querySelector('#piano-auto-progress').textContent.includes('中断')&&!document.querySelector('#piano-auto-correct').disabled,null,{timeout:15000});
  const failed=await download('failed');assert.equal(failed.status,'failed');assert.equal(failed.final,false);
  assert.ok(controls.filter(message=>message.type==='start').length>=5);
  assert.ok(received.some(message=>message.type==='notes'&&message.events.length));
  for(const message of controls){assert.ok(!('expected' in message));assert.ok(!('pitches' in message));assert.ok(!('plan' in message));}
  assert.deepEqual(errors,[]);
  await writeFile('test-evidence/piano-auto-browser.json',JSON.stringify({errors,reports},null,2));
  console.log(JSON.stringify({errors,reports},null,2));
} catch(error){
  if(page){await page.screenshot({path:'test-evidence/piano-auto-failure.png',fullPage:true});console.error(JSON.stringify({errors,progress:await page.locator('#piano-auto-progress').textContent(),status:await page.locator('#practice-status').textContent(),notice:await page.locator('#notice').textContent(),received:received.slice(-3)},null,2));}
  throw error;
} finally{await browser.close();}
