import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
const errors=[];
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://localhost:8765/#practice');
  await page.waitForFunction(()=>document.querySelector('#practice-status').textContent.startsWith('曲谱已就绪'));
  await page.locator('#practice-reference').click();
  await page.waitForFunction(()=>document.querySelectorAll('.reference-playing').length>0);
  await page.waitForTimeout(1100);
  const midiPosition=await page.locator('#practice-position').textContent();
  assert.ok(!midiPosition.endsWith('0.0 秒'));
  await page.locator('#practice-reference').click();
  assert.equal(await page.locator('.reference-playing').count(),0);
  const notes=(await(await page.request.get('http://localhost:8765/api/studio/practice/easy')).json()).notes;
  const target=notes.find(n=>n.onsetSeconds>24&&n.durationSeconds>.3);
  await page.evaluate(async time=>{
    const audio=document.querySelector('#practice-accompaniment');audio.preload='auto';
    if(!audio.readyState)await new Promise((resolve,reject)=>{audio.addEventListener('loadedmetadata',resolve,{once:true});audio.addEventListener('error',reject,{once:true});audio.load();});
    audio.currentTime=time;await audio.play();
  },target.onsetSeconds+.03);
  await page.waitForFunction(()=>document.querySelectorAll('.reference-playing').length>0);
  await page.waitForFunction(()=>document.querySelector('#practice-sheet-scroll').scrollLeft>100);
  const playing={position:await page.locator('#practice-position').textContent(),scrollLeft:await page.locator('#practice-sheet-scroll').evaluate(e=>e.scrollLeft),keys:await page.locator('.reference-playing').count()};
  await page.evaluate(()=>document.querySelector('#practice-accompaniment').pause());
  assert.equal(await page.locator('.reference-playing').count(),0);
  const paused=await page.locator('#practice-position').textContent();
  await page.waitForTimeout(350);assert.equal(await page.locator('#practice-position').textContent(),paused);
  await page.evaluate(()=>{document.querySelector('#practice-accompaniment').currentTime=1;});
  await page.waitForFunction(()=>document.querySelector('#practice-sheet-scroll').scrollLeft<100);
  // Navigation to the teacher page restores microphone mode.
  await page.locator('.nav-item[data-view="piano"]').click();
  await page.locator('.nav-item[data-view="practice"]').click();
  assert.equal(await page.locator('#practice-input').inputValue(),'microphone');
  assert.equal(await page.locator('#practice-teacher-help').isVisible(),true);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:'test-evidence/playback-follow.png',fullPage:true});
  await writeFile('test-evidence/playback-follow.json',JSON.stringify({errors,midiPosition,playing,pauseAndSeek:true,teacherNavigation:true,mp3Alignment:'MIDI timeline; original audio requires offset/tempo calibration'},null,2));
  console.log(JSON.stringify({errors,midiPosition,playing}));
}finally{await browser.close();}
