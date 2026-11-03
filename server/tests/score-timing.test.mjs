import test from 'node:test';
import assert from 'node:assert/strict';
import {measureStart,measureAt,quarterSeconds,printedPosition} from '../static/score-timing.js';

test('pickups and changing meters use actual bar boundaries rather than four beats',()=>{
  const score={bars:3,measureStartsSeconds:[0,1,4,6],measureQuarters:[0,1,4,6]};
  assert.equal(measureStart(score,2),1);
  assert.equal(measureAt(score,3.99),2);
  assert.equal(measureAt(score,4),3);
  assert.equal(quarterSeconds(score,2.5),2.5);
  assert.equal(measureAt(score,100),3);
});
test('rendered quarter positions follow the selected score tempo',()=>{
  const score={bars:2,measureStartsSeconds:[0,2.25,4.5],measureQuarters:[0,3,6]};
  assert.equal(quarterSeconds(score,4),3);
  assert.equal(measureAt(score,2.25),2);
});
test('repeat and second ending return to the printed source measure',()=>{
  const score={bars:5,measureStartsSeconds:[0,2,4,6,8,10],measureQuarters:[0,4,8,12,16,20],
    sourceMeasureQuarters:[0,4,8,12,16],sourceMeasures:[1,2,3,2,4]};
  assert.deepEqual(printedPosition(score,6.5),{measure:4,sourceMeasure:2,quarter:5});
  assert.deepEqual(printedPosition(score,8),{measure:5,sourceMeasure:4,quarter:12});
  assert.deepEqual(printedPosition(score,100),{measure:5,sourceMeasure:4,quarter:16});
});
