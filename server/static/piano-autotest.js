/** Test inputs and independent diagnostics. The waiting follower never reads these answers. */
import {makeSteps} from './follower.js';
const unique=(pitches)=>[...new Set(pitches)].sort((a,b)=>a-b);
const same=(a,b)=>a.length===b.length&&a.every((pitch,index)=>pitch===b[index]);
function randomGenerator(seed) {
  let state=seed>>>0;
  return ()=>{state=(state+0x6D2B79F5)|0;let value=Math.imul(state^state>>>15,1|state);value^=value+Math.imul(value^value>>>7,61|value);return ((value^value>>>14)>>>0)/4294967296;};
}

export function makeAutoPlan(notes,{hand='both',startSeconds=0,endSeconds,speed=1,mode='correct',errorRate=.3,seed=1}={}) {
  if(!['correct','random'].includes(mode)||!Number.isFinite(endSeconds)||endSeconds<=startSeconds||!Number.isFinite(speed)||speed<=0||!Number.isFinite(errorRate)||errorRate<0||errorRate>1)throw new Error('自动测试参数无效');
  const random=randomGenerator(seed);
  const steps=makeSteps(notes,{hand,startSeconds,endSeconds}).map((step,index)=>{
    const durations=step.pitches.map(pitch=>Math.max(...notes.filter(note=>note.midi===pitch&&Math.abs(note.onsetSeconds-step.onsetSeconds)<.002&&(hand==='both'||note.hand===hand)).map(note=>note.durationSeconds||.3)));
    return {index,scoreOnsetSeconds:step.onsetSeconds,offsetSeconds:Math.max(0,step.onsetSeconds-startSeconds)/speed,
      expected:[...step.pitches],pitches:[...step.pitches],durations:Object.fromEntries(step.pitches.map((pitch,i)=>[pitch,Math.max(.08,Math.min(endSeconds-step.onsetSeconds,durations[i])*.9/speed)])),
      durationSeconds:Math.max(.08,Math.min(endSeconds-step.onsetSeconds,Math.max(...durations))*.9/speed),error:'none'};
  });
  if(!steps.length)throw new Error('所选片段和声部没有可弹音符');
  if(mode==='random'&&errorRate>0){
    const indexes=steps.map((_,index)=>index);
    for(let i=indexes.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[indexes[i],indexes[j]]=[indexes[j],indexes[i]];}
    const count=Math.max(1,Math.round(steps.length*errorRate));
    for(const index of indexes.slice(0,count)){
      const step=steps[index],pitchIndex=Math.floor(random()*step.pitches.length);
      const kinds=step.pitches.length>1?['replace','extra','missing']:['replace','extra'];
      step.error=kinds[Math.floor(random()*kinds.length)];
      if(step.error==='missing')step.pitches.splice(pitchIndex,1);
      else {
        const pitch=step.pitches[pitchIndex];
        const candidates=unique([-12,-3,-2,-1,1,2,3,12].map(delta=>pitch+delta)).filter(value=>value>=21&&value<=108&&!step.expected.includes(value));
        const wrong=candidates[Math.floor(random()*candidates.length)];
        if(step.error==='extra')step.pitches.push(wrong);else step.pitches[pitchIndex]=wrong;
      }
      step.pitches=unique(step.pitches);
    }
  }
  return {mode,seed:seed>>>0,errorRate:mode==='random'?errorRate:0,hand,speed,startSeconds,endSeconds,durationSeconds:(endSeconds-startSeconds)/speed,steps};
}

export function analyzeAutoTest(groups,observedNotes,toleranceSeconds=.12,processedThroughSeconds=Infinity) {
  const assigned=groups.map(()=>[]),unmatched=[];
  for(const note of observedNotes){
    let best=-1,distance=toleranceSeconds+1e-9;
    groups.forEach((group,index)=>{const delta=Math.abs(note.onsetSeconds-group.audioOnsetSeconds);if(delta<distance){distance=delta;best=index;}});
    if(best<0)unmatched.push(note);else assigned[best].push(note);
  }
  // A later model window can still add a note to an attack. Do not mark that
  // attack as a pass or a false block until its whole matching window is closed.
  const totals={groups:0,performedGroups:groups.length,pendingGroups:0,correctInputs:0,injectedErrors:0,correctPasses:0,detectedErrors:0,falseBlocks:0,falsePasses:0};
  const rows=groups.map((group,index)=>{
    const expected=unique(group.expected),played=unique(group.pitches),heard=unique(assigned[index].map(note=>note.midi));
    const inputCorrect=same(expected,played),modelAccepts=same(expected,heard);
    const evaluated=group.audioOnsetSeconds+toleranceSeconds<=processedThroughSeconds;
    const verdict=evaluated?(inputCorrect?(modelAccepts?'correctPasses':'falseBlocks'):(modelAccepts?'falsePasses':'detectedErrors')):'pending';
    if(evaluated){totals.groups++;totals[inputCorrect?'correctInputs':'injectedErrors']++;totals[verdict]++;}else totals.pendingGroups++;
    return {...group,heard,inputCorrect,modelAccepts,verdict,missing:played.filter(pitch=>!heard.includes(pitch)),extra:heard.filter(pitch=>!played.includes(pitch)),modelEvents:assigned[index]};
  });
  const correctDecisions=totals.correctPasses+totals.detectedErrors;
  return {totals,rows,accuracy:{value:totals.groups?correctDecisions/totals.groups:null,correctDecisions,evaluatedGroups:totals.groups,
    correctPassRate:totals.correctInputs?totals.correctPasses/totals.correctInputs:null,
    falseBlockRate:totals.correctInputs?totals.falseBlocks/totals.correctInputs:null,
    errorDetectionRate:totals.injectedErrors?totals.detectedErrors/totals.injectedErrors:null,
    falsePassRate:totals.injectedErrors?totals.falsePasses/totals.injectedErrors:null},unmatchedModelEvents:unmatched,toleranceSeconds,processedThroughSeconds:Number.isFinite(processedThroughSeconds)?processedThroughSeconds:null,
    interpretation:'Independent per-attack score comparison using known simulator input. Does not advance or reset the live waiting follower. Not real-student accuracy.'};
}

/** Schedule real audio against the AudioContext clock, independent of model responses. */
export class AutoPianoPlayer {
  constructor(sampler,plan,{velocity=80,tailSeconds=2.8,onStep=()=>{},onPaint=()=>{},onFinish=()=>{},onError=()=>{}}={}){
    Object.assign(this,{sampler,plan,velocity,tailSeconds,onStep,onPaint,onFinish,onError});
    this.index=0;this.voices=new Map();this.stopped=true;
  }
  get activePitches(){return unique([...this.voices.values()].map(voice=>voice.midi));}
  start(){this.startTime=this.sampler.context.currentTime+.15;this.stopped=false;this.timer=setInterval(()=>this.tick(),25);this.tick();}
  tick(){
    if(this.stopped)return;
    try{
      const now=this.sampler.context.currentTime;
      if(this.sampler.context.state!=='running')throw new Error('音频播放已暂停，自动测试已停止；请保持页面在前台。');
      let painted=false;
      for(const[id,voice]of this.voices)if(now>=voice.end){this.sampler.noteOff(id);this.voices.delete(id);painted=true;}
      while(this.index<this.plan.steps.length&&this.startTime+this.plan.steps[this.index].offsetSeconds<=now+.035){
        const step=this.plan.steps[this.index++],time=this.startTime+step.offsetSeconds;
        if(now-time>.2)throw new Error('页面调度延迟过大，自动测试已停止，请保持页面在前台后重试。');
        this.onStep({...step,audioOnsetSeconds:Number((time-this.sampler.origin).toFixed(6))});
        for(const midi of step.pitches){const id=this.sampler.noteOn(midi,this.velocity,time);if(!id)throw new Error('钢琴采样未能发声');this.voices.set(id,{midi,end:time+(step.durations[midi]||step.durationSeconds)});}
        painted=true;
      }
      if(painted)this.onPaint();
      if(this.index===this.plan.steps.length&&!this.voices.size&&now>=this.startTime+this.plan.durationSeconds+this.tailSeconds){this.stop();this.onFinish();}
    }catch(error){this.stop();this.onError(error);}
  }
  stop(){this.stopped=true;clearInterval(this.timer);for(const[id]of this.voices)this.sampler.release(id);this.voices.clear();this.onPaint();}
}
