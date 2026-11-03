import assert from 'node:assert/strict';
import test from 'node:test';
import {recordPianoAttempt, pianoAttemptFeedback} from '../static/piano-feedback.js';
import {WaitingFollower} from '../static/follower.js';
const event=(midi,onsetSeconds)=>({midi,onsetSeconds});
const attempt=()=>recordPianoAttempt(null,event(64,1),[64],0);

test('an actual correct key is acknowledged while audio analysis is still pending',()=>{
  const input=attempt();
  const result=pianoAttemptFeedback(input,[],.8,[]);
  assert.equal(result.state,'listening');assert.equal(result.played,'E4');
  assert.match(result.title,/已收到/);
});
test('a correct key blocked by a model octave error is displayed as a model mismatch',()=>{
  const input=attempt(), f=new WaitingFollower([{onsetSeconds:0,pitches:[64]}]);
  const notes=[event(64,1.01),event(76,1.034)];f.push(notes,1.4);
  const trace=JSON.stringify(f.trace);
  const result=pianoAttemptFeedback(input,notes,1.4,f.trace);
  assert.equal(result.state,'model-mismatch');assert.equal(result.played,'E4');assert.equal(result.heard,'E4 + E5');
  assert.match(result.detail,/额外识别出 E5/);assert.match(result.detail,/不是你点错/);
  assert.equal(f.index,0);assert.equal(JSON.stringify(f.trace),trace); // Display never changes the verdict.
});
test('no detected onset after analysis is different from a pending audio window',()=>{
  const result=pianoAttemptFeedback(attempt(),[],1.4,[]);
  assert.equal(result.state,'model-mismatch');assert.match(result.detail,/没有识别到 E4/);
});
test('a wrong physical key is not blamed on the model',()=>{
  const input=recordPianoAttempt(null,event(65,1),[64],0);
  const result=pianoAttemptFeedback(input,[event(65,1.02)],1.4,[]);
  assert.equal(result.state,'wrong-key');assert.equal(result.played,'F4');
});
test('simultaneous chord keys are grouped, retries and older model events are separate',()=>{
  let input=recordPianoAttempt(null,event(60,1),[60,76],0);
  input=recordPianoAttempt(input,event(76,1.04),[60,76],0);
  assert.deepEqual(input.played,[60,76]);
  const retry=recordPianoAttempt(input,event(60,2),[60,76],0);
  assert.deepEqual(retry.played,[60]);
  const f=new WaitingFollower([{onsetSeconds:0,pitches:[60,76]}]);
  const notes=[event(99,.4),event(60,1.01),event(76,1.05)];f.push(notes,1.4);
  const result=pianoAttemptFeedback(input,notes,1.4,f.trace);
  assert.equal(result.state,'passed');assert.equal(result.heard,'C4 + E5');
});
