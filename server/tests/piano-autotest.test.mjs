import assert from 'node:assert/strict';
import test from 'node:test';
import {makeAutoPlan,analyzeAutoTest,AutoPianoPlayer} from '../static/piano-autotest.js';
const notes=[{midi:48,onsetSeconds:0,durationSeconds:2,hand:'left'},{midi:64,onsetSeconds:0,durationSeconds:.4,hand:'right'},{midi:65,onsetSeconds:1,durationSeconds:.5,hand:'right'},{midi:67,onsetSeconds:2,durationSeconds:.5,hand:'right'}];
test('correct automatic input respects hand, tempo, chords and each key duration',()=>{
  const plan=makeAutoPlan(notes,{endSeconds:3,speed:2});
  assert.deepEqual(plan.steps.map(step=>step.pitches),[[48,64],[65],[67]]);
  assert.deepEqual(plan.steps.map(step=>step.offsetSeconds),[0,.5,1]);
  assert.equal(plan.steps[0].durations[48],.9);assert.ok(Math.abs(plan.steps[0].durations[64]-.18)<1e-9);
  assert.deepEqual(makeAutoPlan(notes,{hand:'right',startSeconds:1,endSeconds:3}).steps.map(step=>step.pitches),[[65],[67]]);
});
test('random errors are reproducible, genuinely different and inside the piano range',()=>{
  for(let seed=1;seed<=100;seed++){
    const plan=makeAutoPlan(notes,{endSeconds:3,mode:'random',errorRate:.3,seed});
    assert.deepEqual(plan,makeAutoPlan(notes,{endSeconds:3,mode:'random',errorRate:.3,seed}));
    assert.equal(plan.steps.filter(step=>step.error!=='none').length,1);
    for(const step of plan.steps){assert.ok(step.pitches.length);assert.ok(step.pitches.every(pitch=>Number.isInteger(pitch)&&pitch>=21&&pitch<=108));if(step.error!=='none')assert.notDeepEqual(step.pitches,step.expected);}
  }
  assert.equal(makeAutoPlan(notes,{endSeconds:3,mode:'random',errorRate:1}).steps.filter(step=>step.error!=='none').length,3);
  assert.throws(()=>makeAutoPlan(notes,{hand:'left',startSeconds:1,endSeconds:2}),/没有可弹/);
});
test('diagnostics distinguish actual errors from octave false blocks and false passes',()=>{
  const groups=[{index:0,expected:[64],pitches:[64],audioOnsetSeconds:1},{index:1,expected:[65],pitches:[66],audioOnsetSeconds:2},{index:2,expected:[67],pitches:[68],audioOnsetSeconds:3}];
  const result=analyzeAutoTest(groups,[{midi:64,onsetSeconds:1.01},{midi:76,onsetSeconds:1.02},{midi:66,onsetSeconds:2.01},{midi:67,onsetSeconds:3.01},{midi:99,onsetSeconds:5}]);
  assert.deepEqual(result.rows.map(group=>group.verdict),['falseBlocks','detectedErrors','falsePasses']);
  assert.equal(result.totals.falseBlocks,1);assert.equal(result.totals.detectedErrors,1);assert.equal(result.totals.falsePasses,1);
  assert.equal(result.unmatchedModelEvents.length,1);
  assert.deepEqual(groups[0].pitches,[64]);
});
test('nearby attacks own their closest model events rather than counting them twice',()=>{
  const result=analyzeAutoTest([{expected:[60],pitches:[60],audioOnsetSeconds:1},{expected:[62],pitches:[62],audioOnsetSeconds:1.2}],[{midi:62,onsetSeconds:1.11}]);
  assert.deepEqual(result.rows[0].heard,[]);assert.deepEqual(result.rows[1].heard,[62]);
});
test('live accuracy waits for the model watermark instead of calling pending attacks errors',()=>{
  const groups=[{expected:[60],pitches:[60],audioOnsetSeconds:1},{expected:[64],pitches:[64],audioOnsetSeconds:2}];
  const events=[{midi:60,onsetSeconds:1.01},{midi:64,onsetSeconds:2.01}];
  const waiting=analyzeAutoTest(groups,events,.12,.9);
  assert.equal(waiting.accuracy.value,null);assert.equal(waiting.totals.pendingGroups,2);assert.equal(waiting.totals.falseBlocks,0);
  const partial=analyzeAutoTest(groups,events,.12,2.05);
  assert.equal(partial.accuracy.value,1);assert.equal(partial.accuracy.evaluatedGroups,1);assert.equal(partial.totals.pendingGroups,1);
  assert.deepEqual(partial.rows.map(row=>row.verdict),['correctPasses','pending']);
  // The octave arrives in a subsequent window. Only then is group 2 evaluated.
  const completed=analyzeAutoTest(groups,[...events,{midi:76,onsetSeconds:2.1}],.12,2.8);
  assert.equal(completed.accuracy.value,.5);assert.equal(completed.totals.falseBlocks,1);assert.equal(completed.totals.pendingGroups,0);
});
test('25 correct groups with 10 false blocks mean 60 percent group accuracy, not note F1',()=>{
  const groups=Array.from({length:25},(_,index)=>({expected:[60],pitches:[60],audioOnsetSeconds:index}));
  const events=groups.flatMap((group,index)=>[{midi:60,onsetSeconds:index},...(index<10?[{midi:72,onsetSeconds:index}]:[])]);
  const result=analyzeAutoTest(groups,events);
  assert.equal(result.accuracy.value,.6);assert.equal(result.accuracy.correctDecisions,15);assert.equal(result.accuracy.evaluatedGroups,25);
  assert.equal(result.accuracy.falseBlockRate,.4);assert.equal(result.accuracy.errorDetectionRate,null);
});
test('wrong inputs correctly blocked count as correct decisions without concealing transcription errors',()=>{
  const result=analyzeAutoTest([{expected:[60],pitches:[61],audioOnsetSeconds:1},{expected:[62],pitches:[63],audioOnsetSeconds:2}],
    [{midi:61,onsetSeconds:1},{midi:73,onsetSeconds:1},{midi:62,onsetSeconds:2}]);
  assert.equal(result.accuracy.value,.5);assert.equal(result.totals.detectedErrors,1);assert.equal(result.totals.falsePasses,1);
  assert.deepEqual(result.rows[0].extra,[73]);assert.equal(result.accuracy.correctPassRate,null);
});
test('audio scheduler plays every group without model feedback and stops scheduling on cancellation',()=>{
  const played=[],steps=[],released=[];let complete=false;
  const sampler={context:{currentTime:0,state:'running'},origin:0,noteOn:(midi,velocity,time)=>{played.push({midi,velocity,time});return Symbol(midi);},noteOff:id=>released.push(id),release:id=>released.push(id)};
  const player=new AutoPianoPlayer(sampler,makeAutoPlan(notes,{endSeconds:3}),{tailSeconds:.3,onStep:group=>steps.push(group),onFinish:()=>complete=true});
  player.start();
  try{
    sampler.context.currentTime=.14;player.tick();assert.deepEqual(played.map(note=>note.midi),[48,64]);
    sampler.context.currentTime=1.14;player.tick();assert.deepEqual(played.map(note=>note.midi),[48,64,65]);
    player.stop();sampler.context.currentTime=5;player.tick();assert.equal(played.length,3);assert.equal(complete,false);assert.equal(player.activePitches.length,0);
  }finally{player.stop();}
});
test('paused audio aborts instead of producing a fake completed result',()=>{
  let error;
  const sampler={context:{currentTime:0,state:'suspended'},origin:0,noteOn:()=>assert.fail('must not play'),release:()=>{}};
  const player=new AutoPianoPlayer(sampler,makeAutoPlan(notes,{endSeconds:3}),{onError:value=>error=value});
  player.start();assert.match(error.message,/暂停/);assert.equal(player.stopped,true);
});
