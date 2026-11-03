import test from 'node:test';
import assert from 'node:assert/strict';
import {soundingPitches,audioScoreTime} from '../static/playback.js';
test('audition highlights chords, note releases and the selected hand from its playback clock',()=>{
  const notes=[{midi:48,onsetSeconds:1,durationSeconds:2,hand:'left'},
    {midi:64,onsetSeconds:1,durationSeconds:.5,hand:'right'},
    {midi:67,onsetSeconds:2,durationSeconds:1,hand:'right'}];
  assert.deepEqual([...soundingPitches(notes,.9)],[]);
  assert.deepEqual([...soundingPitches(notes,1.2)],[48,64]);
  assert.deepEqual([...soundingPitches(notes,2.2,'right')],[67]);
  assert.deepEqual([...soundingPitches(notes,3)],[]);
  assert.equal(audioScoreTime(2,3,1),0);
  assert.equal(audioScoreTime(5,3,.5),1);
});
