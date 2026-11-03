import assert from 'node:assert/strict';
import test from 'node:test';
import {latencySummary,recordAutomaticTiming,automaticPerformance} from '../static/performance.js';

test('quantiles exclude missing or invalid timing instead of reporting zero latency',()=>{
  assert.deepEqual(latencySummary([null,undefined,-1,NaN]),{count:0,p50Ms:null,p95Ms:null,maxMs:null});
  assert.deepEqual(latencySummary([100,300,200]),{count:3,p50Ms:200,p95Ms:290,maxMs:300});
});
test('decision latency closes the full attack window once, using the actual audio clock',()=>{
  const run={groups:[{audioOnsetSeconds:1},{audioOnsetSeconds:2}]};
  recordAutomaticTiming(run,{processedThroughSeconds:1.1,inferenceMs:45,clientTiming:{audioAtReceiptSeconds:1.5}});
  assert.equal(run.groups[0].decisionLatencyMs,undefined);
  recordAutomaticTiming(run,{processedThroughSeconds:1.3,inferenceMs:50,queueAndInferenceMs:55,clientTiming:{audioAtReceiptSeconds:1.6,rttMs:80}});
  assert.ok(Math.abs(run.groups[0].decisionLatencyMs-600)<1e-8);
  recordAutomaticTiming(run,{processedThroughSeconds:2.8,inferenceMs:50,tailPadded:true,clientTiming:{audioAtReceiptSeconds:4}});
  assert.equal(run.groups[1].decisionLatencyMs,undefined); // Never count EOF flush as low live latency.
  assert.equal(automaticPerformance(run).decisionLatency.count,1);
  assert.equal(automaticPerformance(run).networkRtt.p95Ms,80);
});

test('RTT samples count each ping once rather than counting a stale RTT every model frame',()=>{
  const run={groups:[]};
  for(let i=0;i<50;i++)recordAutomaticTiming(run,{processedThroughSeconds:0,clientTiming:{rttMs:100,rttSampleId:1}});
  recordAutomaticTiming(run,{processedThroughSeconds:0,clientTiming:{rttMs:20,rttSampleId:2}});
  const result=automaticPerformance(run).networkRtt;
  assert.equal(result.count,2);assert.equal(result.p50Ms,60);assert.equal(result.maxMs,100);
});
