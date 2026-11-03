/** Monotonic browser audio time avoids mixing server and browser wall clocks. */
export function latencySummary(values) {
  const sorted=values.filter(value=>Number.isFinite(value)&&value>=0).sort((a,b)=>a-b);
  if(!sorted.length)return {count:0,p50Ms:null,p95Ms:null,maxMs:null};
  const quantile=q=>{const index=(sorted.length-1)*q,lower=Math.floor(index),part=index-lower;return sorted[lower]+part*(sorted[Math.ceil(index)]-sorted[lower]);};
  return {count:sorted.length,p50Ms:quantile(.5),p95Ms:quantile(.95),maxMs:sorted.at(-1)};
}

export function recordAutomaticTiming(run,message) {
  run.telemetry??=[];
  const receipt=message.clientTiming?.audioAtReceiptSeconds;
  run.telemetry.push({windowId:message.windowId,processedThroughSeconds:message.processedThroughSeconds,
    receivedAudioSeconds:message.receivedAudioSeconds,tailPadded:message.tailPadded,
    serverTiming:message.serverTiming,clientTiming:message.clientTiming,
    inferenceMs:message.inferenceMs,queueAndInferenceMs:message.queueAndInferenceMs,rttMs:message.clientTiming?.rttMs,rttSampleId:message.clientTiming?.rttSampleId});
  if(message.tailPadded||!Number.isFinite(receipt))return;
  for(const group of run.groups){
    if(group.decisionLatencyMs===undefined&&group.audioOnsetSeconds+.12<=message.processedThroughSeconds){
      group.decisionLatencyMs=Math.max(0,(receipt-group.audioOnsetSeconds)*1000);
    }
  }
}

export function recordFollowDecisionTiming(run,decisions,message){
  const receipt=message.clientTiming?.audioAtReceiptSeconds;
  for(const decision of decisions){
    const elapsed=Number.isFinite(message.clientTiming?.receivedAtPerformanceMs)?performance.now()-message.clientTiming.receivedAtPerformanceMs:0;
    decision.decisionLatencyMs=message.tailPadded||!Number.isFinite(receipt)?null:Math.max(0,(receipt-decision.audioOnsetSeconds)*1000+elapsed);
    decision.latencyBasis='Model-detected onset on browser audio clock to follow decision; not physical key-contact timing';
    decision.windowId=message.windowId;
    run.groups.push({audioOnsetSeconds:decision.audioOnsetSeconds,decisionLatencyMs:decision.decisionLatencyMs,action:decision.action});
  }
  if(message.clientTiming){
    message.clientTiming.decisionCount=decisions.length;
    message.clientTiming.lastDecisionLatencyMs=decisions.at(-1)?.decisionLatencyMs??null;
  }
}

export function automaticPerformance(run) {
  const samples=run.telemetry||[];
  const pings=[...new Map(samples.filter(sample=>Number.isFinite(sample.rttMs)).map((sample,index)=>[sample.rttSampleId??index,sample.rttMs])).values()];
  return {method:'AudioContext capture time to browser receipt of a complete attack window; EOF-flushed groups excluded',
    decisionLatency:latencySummary(run.groups.map(group=>group.decisionLatencyMs)),
    inference:latencySummary(samples.map(sample=>sample.inferenceMs)),
    queueAndInference:latencySummary(samples.map(sample=>sample.queueAndInferenceMs)),
    networkRtt:latencySummary(pings),
    networkRttMeaning:'Application ping over the same audio WebSocket; includes server receive backlog, not pure network RTT',
    analysisLag:latencySummary(samples.map(sample=>sample.clientTiming?.analysisLagMs)),
    browserHandler:latencySummary(samples.map(sample=>sample.clientTiming?.handlerMs)),
    browserSendBufferedBytes:latencySummary(samples.map(sample=>sample.clientTiming?.browserBufferedBytes)),
    executorWaitAndOverhead:latencySummary(samples.map(sample=>sample.serverTiming?.executorWaitAndOverheadMs)),
    windowLogs:samples};
}
