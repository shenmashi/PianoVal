import assert from 'node:assert/strict';
import test from 'node:test';
import {makeSteps, WaitingFollower} from '../static/follower.js';
const event = (midi, onsetSeconds) => ({midi, onsetSeconds});
const steps = [{onsetSeconds:0,pitches:[60]},{onsetSeconds:1,pitches:[64,67]}];

test('wrong pitches, extra pitches, and partial chords wait for the current step', () => {
  const f = new WaitingFollower(steps);
  assert.equal(f.push([event(61,0)],1)[0].action,'wait'); assert.equal(f.index,0);
  assert.equal(f.push([event(60,1),event(62,1.02)],2)[0].action,'wait'); assert.equal(f.index,0);
  assert.equal(f.push([event(60,2)],3)[0].action,'advance'); assert.equal(f.index,1);
  assert.equal(f.push([event(64,3)],4)[0].action,'wait'); assert.equal(f.index,1);
  assert.equal(f.push([event(64,4),event(67,4.04)],5)[0].action,'advance'); assert.ok(f.complete);
});
test('passing time and later score notes never skip an unresolved target', () => {
  const f = new WaitingFollower(steps);
  f.push([],100); assert.equal(f.index,0);
  f.push([event(64,101),event(67,101.01)],102); assert.equal(f.index,0);
});
test('chords crossing network/model windows produce the same decision as one batch', () => {
  const target = [{onsetSeconds:0,pitches:[60,64]}];
  const a = new WaitingFollower(target); const b = new WaitingFollower(target);
  assert.deepEqual(a.push([event(60,0.70)],0.72),[]);
  a.push([event(64,0.75)],1.44);
  b.push([event(60,0.70),event(64,0.75)],1.44);
  assert.deepEqual(a.trace,b.trace); assert.ok(a.complete);
});
test('EOF flush evaluates the last partial observation interval', () => {
  const f = new WaitingFollower([{onsetSeconds:0,pitches:[60]}]);
  assert.deepEqual(f.push([event(60,1)],1.02),[]);
  assert.equal(f.push([],1.02,true)[0].action,'advance');
});
test('both hands on one physical key form one target; MIDI timing forms ordered targets', () => {
  const notes=[{...event(60,0),hand:'left'},{...event(60,0),hand:'right'},
    {...event(64,0),hand:'right'},{...event(67,1),hand:'right'}];
  assert.deepEqual(makeSteps(notes),[{onsetSeconds:0,pitches:[60,64]},{onsetSeconds:1,pitches:[67]}]);
  assert.deepEqual(makeSteps(notes,{hand:'left'}),[{onsetSeconds:0,pitches:[60]}]);
});
test('rounded MIDI tempo preserves the first chord and excludes the next bar',()=>{
  const notes=[{...event(60,10.322576),hand:'left'},{...event(76,10.322576),hand:'right'},
    {...event(62,12.903220),hand:'right'}];
  assert.deepEqual(makeSteps(notes,{startSeconds:16*60/93,endSeconds:20*60/93}),[
    {onsetSeconds:10.322576,pitches:[60,76]},
  ]);
});

test('teacher can release a blocked chord; late pre-release audio cannot affect the next target',()=>{
  const f=new WaitingFollower(steps);
  f.push([event(61,1)],2);
  const decision=f.manualAdvance({audioOnsetSeconds:5});
  assert.equal(decision.action,'manual-advance');assert.deepEqual(decision.observed,[61]);
  assert.equal(decision.excludedFromRecognitionAccuracy,true);
  assert.equal(f.index,1);assert.equal(f.manualSteps,1);
  assert.deepEqual(f.push([event(64,4),event(67,4.01)],6),[]);
  assert.equal(f.index,1);
  assert.equal(f.push([event(64,6)],7)[0].action,'wait');
  assert.equal(f.push([event(64,8),event(67,8.03)],9)[0].action,'advance');
  assert.ok(f.complete);assert.equal(f.manualSteps,1);
});
test('teacher resync to next bar clears pending observations and records all skipped groups',()=>{
  const f=new WaitingFollower([{onsetSeconds:0,pitches:[60]},{onsetSeconds:1,pitches:[62]},
    {onsetSeconds:4,pitches:[64]},{onsetSeconds:5,pitches:[65]}]);
  f.push([event(60,1)],1.01);
  const decision=f.manualAdvance({audioOnsetSeconds:2,toScoreSeconds:4,reason:'next-measure'});
  assert.equal(decision.skippedSteps,2);assert.equal(decision.nextStep,3);
  assert.equal(f.pending.length,0);assert.equal(f.current.onsetSeconds,4);
  assert.equal(f.push([event(64,1.9)],2.5).length,0);
  assert.equal(f.push([event(64,3)],4)[0].action,'advance');
  f.manualAdvance({audioOnsetSeconds:5,toScoreSeconds:8,reason:'next-measure'});
  assert.ok(f.complete);assert.equal(f.manualSteps,3);
  assert.equal(f.manualAdvance({audioOnsetSeconds:6}),null);
});
test('invalid override clocks never change score position or log non-finite values',()=>{
  const f=new WaitingFollower(steps);
  for(const value of [undefined,null,NaN,Infinity,-1])assert.throws(()=>f.manualAdvance({audioOnsetSeconds:value}));
  assert.throws(()=>f.manualAdvance({audioOnsetSeconds:1,toScoreSeconds:Infinity}));
  assert.equal(f.index,0);assert.equal(f.trace.length,0);
});
