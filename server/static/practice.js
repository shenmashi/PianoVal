import {api, notify, refresh, showView, selectRecord} from './studio.js';
import {startLive, stopLive, liveAudioSeconds} from './client.js';
import {makeSteps, WaitingFollower} from './follower.js';
import {PianoSampler} from './piano-sampler.js';
import {recordPianoAttempt, pianoAttemptFeedback} from './piano-feedback.js';
import {makeAutoPlan,analyzeAutoTest,AutoPianoPlayer} from './piano-autotest.js';
import {recordAutomaticTiming,recordFollowDecisionTiming,automaticPerformance} from './performance.js';
import {measureStart,measureAt,printedPosition} from './score-timing.js';
import {ScoreCursor} from './score-cursor.js';
import {appPath} from './paths.js';
import {soundingPitches,audioScoreTime} from './playback.js';
const $ = (id) => document.getElementById(id);
const latencyDetails=document.createElement('details');
latencyDetails.innerHTML='<summary>实时延时日志（最近 20 窗）</summary><pre style="max-height:260px;overflow:auto;white-space:pre-wrap;font-size:10px" id="practice-latency-log">开始听琴后记录；完整日志随测试报告保存。</pre>';
$('practice-latency').after(latencyDetails);
const latencyLines=[];
const percent = (value) => `${(value * 100).toFixed(1)}%`;
const midiName = (midi) => ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'][midi % 12] + (Math.floor(midi / 12) - 1);
let score = null;
let catalog = [];
let osmd = null;
let scoreCursor = null;
let initialized = false;
let loadingScore = 0;
let recording = false;
let reference = null;
let playbackFrame = null;
let source = null;
let lastReport = null;
let pendingJob = null;
let comparing = false;
let pulseTimer;
let liveNotes = [];
let liveConfig = null;
let throughSeconds = 0;
let comparisonSerial = 0;
let follower = null;
let savedRecordingId = null;
let sampler = null;
let chordMode = false;
let guidanceSignature = '';
let guidanceTargetSignature = '';
let pianoPhase = 'idle';
let pianoAttempt = null;
let autoTest = null;
let autoStarting = false;
const pendingReportWrites=new Set();
let reportSaveError=null;
function trackReportWrite(task){
  pendingReportWrites.add(task);
  task.then(()=>pendingReportWrites.delete(task),error=>{pendingReportWrites.delete(task);reportSaveError=error;});
  return task;
}
async function waitForReportWrites(){
  while(pendingReportWrites.size)await Promise.all([...pendingReportWrites]);
  if(reportSaveError)throw new Error('测试报告保存失败，请先重试保存或下载完整日志，再退出登录');
}
const automaticRunning=()=>Boolean(autoTest&&['preparing','playing','processing'].includes(autoTest.status));
const armedPitches = new Set();
const heldKeys = new Map();
const isFollow = () => $('practice-mode').value === 'follow';
const recovery=document.createElement('div');
recovery.id='follow-recovery';recovery.className='follow-recovery';recovery.hidden=true;
recovery.innerHTML='<div><strong>识别卡住？老师可放行后继续弹奏</strong><span id="follow-recovery-position"></span></div><div class="follow-recovery-buttons"><button id="follow-release" class="button small" disabled>放行当前音组</button><button id="follow-next-measure" class="button small" disabled>从下一小节继续</button></div><p id="follow-recovery-note" role="status">人工放行会单独留痕，不计为模型识别正确；放行后从提示位置重新弹奏。</p>';
$('practice-sheet-scroll').before(recovery);
function updateRecovery(){
  recovery.hidden=!isFollow();
  const active=recording&&liveAudioSeconds()!==null&&!follower?.complete&&!automaticRunning();
  $('follow-release').disabled=!active;
  $('follow-next-measure').disabled=!active;
  $('follow-release-panel').disabled=!active;
  $('follow-recovery-position').textContent=follower?.current?`当前第 ${measureAt(score,follower.current.onsetSeconds)} 小节 · ${follower.current.pitches.map(midiName).join(' + ')}`:follower?.complete?'所选片段已结束':'';
}
const releaseInPanel=document.createElement('button');releaseInPanel.id='follow-release-panel';
releaseInPanel.className='button small';releaseInPanel.textContent='误拦？放行当前音组';releaseInPanel.disabled=true;
$('follow-reset').before(releaseInPanel);

function config() {
  const startMeasure = Number($('practice-start-measure').value);
  const endMeasure = Number($('practice-end-measure').value);
  const bpm = Number($('practice-bpm').value);
  const offsetSeconds = Number($('practice-offset').value);
  if (!score || !Number.isInteger(startMeasure) || !Number.isInteger(endMeasure) || startMeasure < 1 || endMeasure > score.bars || endMeasure < startMeasure) throw new Error('请设置有效的小节范围');
  if (!Number.isFinite(bpm) || bpm < score.tempo * .5 || bpm > score.tempo * 1.5 || !Number.isFinite(offsetSeconds)) throw new Error('请检查速度和录音偏移');
  return {pieceId:score.id,difficulty:score.difficulty, hand:$('practice-hand').value, startMeasure, endMeasure, speed:bpm / score.tempo,
    offsetSeconds, toleranceSeconds:Number($('practice-tolerance').value)};
}
function startTime(settings) { return measureStart(score,settings.startMeasure); }
function endTime(settings) { return measureStart(score,settings.endMeasure+1); }
function resetFollower(settings = config()) {
  follower = new WaitingFollower(makeSteps(score.notes, {
    hand:settings.hand, startSeconds:startTime(settings), endSeconds:endTime(settings),
  }));
  $('follow-recovery-note').textContent='人工放行会单独留痕，不计为模型识别正确；放行后从提示位置重新弹奏。';
  showFollower();
}
function followReport(final) {
  lastReport = {
    id:source?.metadata.testRunId||crypto.randomUUID(),mode:'waiting-follow', status:final?'completed':'failed', final, analysis:{}, model:source?.metadata.model||null,performance:source?.statistics?automaticPerformance(source.statistics):null,sessionId:source?.metadata.sessionId||null,score:{id:score.id,title:score.title, difficulty:score.difficulty},
    settings:liveConfig || config(), source:source?.metadata || null, modelId:source?.modelId || null,
    recordingId:savedRecordingId, steps:follower.steps, completedSteps:follower.index,
    recognizedSteps:follower.index-follower.manualSteps,manuallyReleasedSteps:follower.manualSteps,
    manualOverrides:follower.trace.filter(row=>row.action==='manual-advance'),
    decisions:follower.trace, observedNotes:source?.notes || [], createdAt:new Date().toISOString(),
    limitation:'Decisions follow recognized attacks. Teacher review and actual performance annotations are required to measure recognition accuracy.',
  };
  $('practice-report-download').disabled = false;
  if(final&&source?.metadata.kind==='microphone')void persistPracticeReport(lastReport);
}
function showFollower() {
  if (!follower) return;
  const panel = $('practice-follow-panel');
  const last = follower.trace.at(-1);
  updateRecovery();
  $('follow-progress').textContent = `${follower.index} / ${follower.steps.length} 组已完成 · 模型通过 ${follower.index-follower.manualSteps} · 人工放行 ${follower.manualSteps}`;
  $('follow-target').textContent = follower.complete ? '片段已完成 ✓' : follower.current.pitches.map(midiName).join(' + ');
  $('piano-current-target').textContent=`当前目标：${$('follow-target').textContent} · ${follower.index}/${follower.steps.length}`;
  updatePianoGuidance();
  $('follow-observed').textContent = last ? last.observed.map(midiName).join(' + ') : '—';
  panel.classList.toggle('waiting', last?.action === 'wait');
  panel.classList.toggle('passed', follower.complete);
  $('follow-feedback').textContent = follower.complete ? `所选片段已结束：模型匹配 ${follower.index-follower.manualSteps} 组，人工放行 ${follower.manualSteps} 组。` : !last ? '等待当前音符，静音和时间流逝都不会推进。'
    : last.action === 'manual-advance' ? '老师已放行。请从新的当前目标继续弹奏；放行前的延迟识别结果不会再次影响位置。'
    : last.action === 'advance' ? '上一组已匹配，等待下一组。'
    : automaticRunning() ? '跟弹停在当前组；自动演奏会继续收集整段声音，结束后查看逐组识别差异。'
    : $('practice-input').value==='piano'&&$('piano-attempt-feedback').dataset.state==='model-mismatch' ? '按键与目标一致，但模型多报或漏报了音符。这次不是你点错，请查看琴键旁的识别差异。'
    : `停在当前组。${last.missing.length ? `缺少 ${last.missing.map(midiName).join('、')}。` : ''}${last.extra.length ? `多出 ${last.extra.map(midiName).join('、')}。` : ''}请纠正后再试。`;
  const target = follower.current || follower.steps.at(-1);
  if (target) updateCursor(target.onsetSeconds);
  if(autoTest&&$('practice-result-view').value==='automatic'){
    renderAutomaticDecisions(autoTest.result||automaticSnapshot(autoTest));return;
  }
  $('practice-detail-heading').textContent='实际跟弹轨迹（错音停留）';
  $('practice-detail-thead').innerHTML='<tr><th>录音时间</th><th>当前等待目标</th><th>模型识别</th><th>判定</th><th>说明</th><th>老师复核</th></tr>';
  const waits = follower.trace.filter((decision) => decision.action === 'wait').length;
  const reviewed = follower.trace.filter((decision) => decision.action!=='manual-advance'&&decision.teacherReview);
  const falseBlock = reviewed.filter((decision) => decision.action === 'wait' && decision.teacherReview === 'should-advance').length;
  const falsePass = reviewed.filter((decision) => decision.action === 'advance' && decision.teacherReview === 'should-wait').length;
  $('practice-comparison').replaceChildren();
  for (const [label,value] of [['模型通过音符组',follower.index-follower.manualSteps],['人工放行音符组',follower.manualSteps],['等待次数',waits],['老师确认误拦',falseBlock],['老师确认误放行',falsePass],['老师复核判对率',reviewed.length?percent((reviewed.length-falseBlock-falsePass)/reviewed.length):'待复核']]) {
    const card=document.createElement('div');card.className='practice-metric';
    const strong=document.createElement('strong');strong.textContent=value;card.append(strong,document.createTextNode(label));$('practice-comparison').append(card);
  }
  $('practice-event-count').textContent=`进度 ${follower.index}/${follower.steps.length} 组 · 模型通过 ${follower.index-follower.manualSteps} · 人工放行 ${follower.manualSteps} · ${waits} 次等待 · 老师已复核 ${reviewed.length} 次`;
  const body=$('practice-difference-body');body.replaceChildren();
  for (const decision of follower.trace.slice(-300)) {
    const row=body.insertRow();row.insertCell().textContent=`${decision.audioOnsetSeconds.toFixed(3)} s`;
    row.insertCell().textContent=`第 ${decision.step} 组：${decision.expected.map(midiName).join(' + ')}`;
    row.insertCell().textContent=decision.observed.map(midiName).join(' + ');
    const tag=document.createElement('span');tag.className=`diff-tag ${decision.action}`;tag.textContent=decision.action==='manual-advance'?'老师人工放行':decision.action==='advance'?'通过，前进':'等待，不前进';row.insertCell().append(tag);
    if(decision.action==='manual-advance'){
      row.insertCell().textContent=`人工放行 ${decision.skippedSteps} 组${decision.reason==='next-measure'?'，从下一小节继续':''}；不计入模型准确率`;
      row.insertCell().textContent='人工操作，已留痕';continue;
    }
    row.insertCell().textContent=decision.action==='advance'?'音高集合匹配':`${decision.missing.length ? `缺少 ${decision.missing.map(midiName).join('、')}` : ''}${decision.extra.length ? ` 多出 ${decision.extra.map(midiName).join('、')}` : ''}`;
    const review=document.createElement('select');review.setAttribute('aria-label',`第 ${decision.step} 组老师复核`);
    for(const [label,value]of[['未复核',''],['实际弹对，应通过','should-advance'],['实际有错，应等待','should-wait']])review.add(new Option(label,value));
    review.value=decision.teacherReview||'';
    review.onchange=()=>{decision.teacherReview=review.value;showFollower();if(source)followReport(!recording);};
    row.insertCell().append(review);
  }
  if (!follower.trace.length) {const cell=body.insertRow().insertCell();cell.colSpan=6;cell.textContent='等待识别到音符。弹错会停在当前组，之后的谱面音符不会让它跳步。';}
}
function renderAutomaticDecisions(result) {
  if($('practice-result-view').value!=='automatic')return;
  $('practice-detail-heading').textContent='自动测试逐组判定';
  $('practice-detail-thead').innerHTML='<tr><th>录音时间</th><th>谱面应弹</th><th>实际自动弹</th><th>模型识别</th><th>判定</th><th>识别差异</th></tr>';
  const totals=result.analysis.totals;
  $('practice-event-count').textContent=`独立评测 ${totals.groups}/${result.plannedGroups} 组 · 误拦 ${totals.falseBlocks} · 误放行 ${totals.falsePasses}；实际跟弹 ${result.waitingFollower.completedSteps}/${result.waitingFollower.totalSteps}`;
  const body=$('practice-difference-body');body.replaceChildren();
  const verdicts={pending:'等待模型',correctPasses:'正确弹奏放行',falseBlocks:'已弹对，模型误拦',detectedErrors:'实际错音已拦截',falsePasses:'错音被误放行'};
  for(const group of result.analysis.rows){
    const row=body.insertRow();row.dataset.verdict=group.verdict;
    const differences=[group.missing.length?`漏识别 ${group.missing.map(midiName).join('、')}`:'',group.extra.length?`多识别 ${group.extra.map(midiName).join('、')}`:''].filter(Boolean).join('；');
    for(const value of [`${group.audioOnsetSeconds.toFixed(3)} s`,`第 ${group.index+1} 组：${group.expected.map(midiName).join(' + ')}`,group.pitches.map(midiName).join(' + '),group.heard.map(midiName).join(' + ')||'—',verdicts[group.verdict],group.verdict==='pending'?'正在识别':differences||'实际声音与识别相符'])row.insertCell().textContent=value;
  }
  if(!result.analysis.rows.length){const cell=body.insertRow().insertCell();cell.colSpan=6;cell.textContent='开始自动弹奏后，这里逐组对齐谱面、实际输入和模型输出。';}
}
$('practice-result-view').onchange=()=>showFollower();
function applyMode() {
  const follow=isFollow();
  for(const element of document.querySelectorAll('[data-timed-control]'))element.hidden=follow;
  $('practice-follow-panel').hidden=!follow;
  updateRecovery();
  $('piano-current-target').hidden=!follow;
  $('practice-detail-heading').textContent=follow?'跟弹判定明细':'固定节拍对照明细';
  $('practice-detail-thead').innerHTML=follow?'<tr><th>录音时间</th><th>等待目标</th><th>实际识别</th><th>判定</th><th>说明</th><th>老师复核</th></tr>':'<tr><th>时间</th><th>音符</th><th>MIDI</th><th>对照结果</th><th>说明</th></tr>';
  $('practice-mode-help').textContent=follow?'默认弹对当前音符 / 和弦才继续；错音、多音或缺音时等待。疑似误拦可点击谱面上方“放行当前音组”，或从下一小节继续。':'按指定 BPM 与录音偏移进行固定节拍对照，分析完整片段的差异。';
  $('practice-policy-note').textContent=follow?'默认由模型识别推进；缺音或多音时等待。老师可手动放行当前组或定位下一小节，人工放行另行记录，不计入模型准确率。自动测试期间禁用人工放行；识别准确率和延迟以完整报告为准。':'与谱一致率用于练习对照，不是模型识别准确率。此模式使用固定速度与手动起点偏移。';
  if(score&&follow)resetFollower();
  updatePianoGuidance();
}
function stopReference() {
  if (!reference) return;
  clearInterval(reference.timer); void reference.context.close(); reference = null;
  stopPlaybackAnimation();
  $('practice-reference').textContent = '▶ MIDI 示范';
}
function stopPlaybackAnimation() {
  cancelAnimationFrame(playbackFrame);playbackFrame=null;
  for(const key of document.querySelectorAll('#practice-keyboard [data-midi]'))key.classList.remove('reference-playing');
}
function paintPlayback(seconds,hand='both') {
  const pitches=soundingPitches(score.notes,seconds,hand);
  for(const key of document.querySelectorAll('#practice-keyboard [data-midi]'))key.classList.toggle('reference-playing',pitches.has(Number(key.dataset.midi)));
  updateCursor(seconds);
}
function animatePlayback(readTime,hand='both') {
  stopPlaybackAnimation();
  const tick=()=>{paintPlayback(readTime(),hand);playbackFrame=requestAnimationFrame(tick);};
  tick();
}
function setBusy(value) {
  recording = value;
  if($('practice-input').value==='piano'){
    if(value)pianoPhase='loading';
    else if(pianoPhase!=='error')pianoPhase='finished';
    updatePianoGuidance();
  }
  for (const element of document.querySelectorAll('.practice-controls select, .practice-controls input')) element.disabled = value;
  $('practice-mic-start').disabled = value;
  $('piano-start').disabled = value;
  $('practice-analyze').disabled = value || Boolean(pendingJob);
  $('practice-reference').disabled = value;
  $('follow-reset').disabled = value;
  $('practice-random').disabled=value;
  $('practice-accompaniment').hidden = value;
  $('practice-save-recording').disabled = value;
  $('practice-controls')?.classList.toggle('busy', value);
  updateAutomaticControls();
  updateRecovery();
}
function updateAutomaticControls() {
  const active=automaticRunning();
  for(const id of ['piano-auto-correct','piano-auto-random','piano-auto-random-piece'])$(id).disabled=autoStarting||active||Boolean(pendingJob)||(recording&&!pianoActive());
  $('piano-auto-error-rate').disabled=autoStarting||active;
  $('piano-auto-stop').disabled=!active||autoTest.status!=='playing';
  for(const id of ['simulator-target','simulator-wrong','simulator-chord-mode','simulator-chord-play','simulator-velocity','simulator-pedal'])$(id).disabled=active||autoStarting;
  updateRecovery();
  if(!autoTest)return;
  const label=autoTest.plan.mode==='correct'?'完全正确弹':'随机错误弹';
  const progress={preparing:`${label}：正在准备钢琴与模型…`,playing:`${label}：已演奏 ${autoTest.groups.length} / ${autoTest.plan.steps.length} 组；按所选谱段继续弹奏，模型判定不会被跳过。`,processing:'演奏已停止，正在处理尾音并生成完整结果…',completed:'自动测试已完成，结果如下。',cancelled:'自动测试已停止，以下为已弹部分的结果。',failed:`自动测试中断：${autoTest.error||'连接未完成'}`};
  $('piano-auto-progress').textContent=progress[autoTest.status];
  if(active)renderAutomaticResult(automaticSnapshot(autoTest));
}
function stopAutomaticPlayer() {autoTest?.player?.stop();paintHeld();updateAutomaticControls();}
function automaticSnapshot(run,{final=false,recognitionMetrics=null,audioSeconds=run.receivedAudioSeconds||0}={}) {
  const groups=final?run.groups.filter(group=>group.audioOnsetSeconds<audioSeconds):run.groups;
  return {id:run.id,sessionId:source?.metadata.sessionId||null,score:{id:score.id,title:score.title,difficulty:score.difficulty,difficultyName:score.difficultyName},status:run.status,error:run.error||null,plan:run.plan,settings:run.settings,velocity:run.velocity,pedal:run.pedal,
    performedGroups:groups.length,plannedGroups:run.plan.steps.length,audioSeconds,final,recognitionMetrics,
    analysis:analyzeAutoTest(groups,run.observedEvents,.12,final?Infinity:run.processedThroughSeconds||0),model:source?.metadata.model||null,recordingId:savedRecordingId,
    actualTriggeredNotes:source?.metadata.triggeredNotes||sampler?.events||[],modelEvents:run.observedEvents,
    waitingFollower:{completedSteps:follower?.index||0,totalSteps:follower?.steps.length||0,decisions:follower?.trace||[]},performance:automaticPerformance(run),createdAt:new Date().toISOString()};
}
function finishAutomaticResult(run,recognitionMetrics,audioSeconds,final=true) {
  const capturedGroups=run.groups.filter(group=>group.audioOnsetSeconds<audioSeconds).length;
  if(run.finishedNaturally&&(!final||capturedGroups!==run.plan.steps.length))run.error||='测试未收齐全部音符的识别结果';
  run.status=run.error?'failed':run.finishedNaturally?'completed':'cancelled';
  run.result=automaticSnapshot(run,{final,recognitionMetrics,audioSeconds});
  if(source?.metadata.autoTest?.id===run.id)source.metadata.autoTest=run.result;
  renderAutomaticResult(run.result);updateAutomaticControls();updatePianoGuidance();void persistAutomaticResult(run);
}
async function refreshTestHistory() {
  const {runs}=await api('/test-runs');
  const body=$('piano-test-history');body.replaceChildren();
  for(const run of runs.slice(0,20)){
    const row=body.insertRow();
    const review=run.teacherReview;
    const reviewed=review?.count>0?`复核判对 ${percent(review.accuracy??(review.count-review.falseBlocks-review.falsePasses)/review.count)}（${review.count} 次）`:null;
    const verdict=reviewed||(run.status==='completed'?(run.accuracy?.value==null?'待复核':percent(run.accuracy.value)):'未完整完成');
    for(const value of [new Date(run.serverRecordedAt).toLocaleString(),run.score?.title||catalog.find(piece=>piece.id===run.settings.pieceId)?.title||'未选曲目',run.score?.difficultyName||run.settings.difficulty||'—',{both:'双手',left:'左手',right:'右手'}[run.settings.hand]||'—',verdict,run.scope?.startsWith('microphone')?`老师已复核 ${run.teacherReview?.count||0} 次`:(run.diagnostics.octaveExtraGroups==null?'原始声音识别，待复核':`八度误报 ${run.diagnostics.octaveExtraGroups} 组 / 漏音 ${run.diagnostics.missingGroups} 组`)])row.insertCell().textContent=value;
    const cell=row.insertCell(),download=document.createElement('button');download.className='text-button';download.textContent='完整日志';
    download.onclick=async()=>{try{const report=await api(`/test-runs/${run.id}`);const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`pianoval-log-${run.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){notify(error.message,true);}};cell.append(download);
    if(run.recordingId){const review=document.createElement('button');review.className='text-button';review.textContent='录音复核';review.onclick=async()=>{await refresh();showView('recordings');await selectRecord(run.recordingId);};cell.append(review);}
  }
  if(!runs.length){const cell=body.insertRow().insertCell();cell.colSpan=7;cell.textContent='麦克风实弹和自动模拟测试的录音、完整诊断日志保存在这里；实琴准确率需要核验实际弹奏。';}
}
function persistPracticeReport(report) {
  return trackReportWrite((async()=>{
    try{await api('/test-runs',{method:'POST',body:JSON.stringify(report)});reportSaveError=null;await refreshTestHistory();}
    catch(error){notify(`实弹日志保存失败：${error.message}；原始服务端会话记录仍保留。`,true);throw error;}
  })());
}

function persistAutomaticResult(run) {
  if(run.persisting)return;run.persisting=true;
  const status=$('piano-auto-log-status');status.textContent='正在保存本次录音与诊断日志…';
  return trackReportWrite((async()=>{
  try{
    const saved=await api('/test-runs',{method:'POST',body:JSON.stringify(run.result)});
    reportSaveError=null;
    if(autoTest===run)status.textContent=`诊断日志已保存 · ${saved.diagnostics.hasReplayAudio?'录音可复核':'未留存完整录音'} · 八度额外音 ${saved.diagnostics.octaveExtraGroups} 组 · 漏音 ${saved.diagnostics.missingGroups} 组。测试不会自动训练模型。`;
    await refreshTestHistory();
  }catch(error){if(autoTest===run)status.textContent=`日志保存失败：${error.message}。仍可下载本次完整结果。`;throw error;}
  })());
}

function renderAutomaticResult(result) {
  const active=['preparing','playing','processing'].includes(result.status);
  $('piano-auto-result').hidden=false;$('piano-auto-download').disabled=active;
  $('piano-auto-result-title').textContent=active?'实时测试结果':'自动测试结果';
  const mode=result.plan.mode==='correct'?'完全正确弹':'随机错误弹';
  $('piano-auto-summary').textContent=`${result.model?result.model.inferenceProfile+' · ':''}${score.title} · ${score.difficultyName} · ${result.status==='completed'?'整段已完成':result.status==='failed'?'测试中断':active?'测试进行中':'已停止，部分结果'} · ${mode} · ${{both:'双手',left:'左手',right:'右手'}[result.settings.hand]} · 第 ${result.settings.startMeasure}–${result.settings.endMeasure} 小节 · 已弹 ${result.performedGroups}/${result.plannedGroups} 组 · ${result.audioSeconds.toFixed(1)} 秒`;
  const totals=result.analysis.totals,accuracy=result.analysis.accuracy;
  $('piano-auto-accuracy-label').textContent=active?'实时逐组判断正确率':result.status==='completed'?'最终逐组判断正确率':'已评测部分判断正确率';
  $('piano-auto-accuracy').textContent=accuracy.value===null?'—':percent(accuracy.value);
  $('piano-auto-accuracy').dataset.evaluated=String(accuracy.evaluatedGroups);
  $('piano-auto-accuracy').dataset.correctDecisions=String(accuracy.correctDecisions);
  $('piano-auto-accuracy-count').textContent=`判对 ${accuracy.correctDecisions} ÷ 已评测 ${accuracy.evaluatedGroups} 组；全段 ${result.plannedGroups} 组，${totals.pendingGroups} 组等待模型。`;
  $('piano-auto-accuracy-detail').textContent=`判对 = 正确弹奏放行 ${totals.correctPasses} 组 + 错音正确拦截 ${totals.detectedErrors} 组。${totals.correctInputs?`正确弹奏误拦 ${totals.falseBlocks}/${totals.correctInputs} 组（${percent(accuracy.falseBlockRate)}）。`:''}${active?'只有完整起音窗口已分析的组才计入准确率。':''}`;
  const target=$('piano-auto-target');
  target.textContent=active?'本轮模拟验收目标：95% 及以上，等待完整结果':result.status!=='completed'?'测试未完整完成':accuracy.value>=.95?'本轮模拟判断正确率 ≥95%：达标':'本轮模拟判断正确率未达到 95%';
  target.dataset.passed=String(!active&&result.status==='completed'&&accuracy.value>=.95);
  const timing=result.performance,ms=value=>value===null?'待测':`${Math.round(value)} ms`;
  $('piano-auto-latency').textContent=`完整判定延迟 P50 ${ms(timing.decisionLatency.p50Ms)} / P95 ${ms(timing.decisionLatency.p95Ms)} / 最慢 ${ms(timing.decisionLatency.maxMs)}（${timing.decisionLatency.count} 组）；模型计算 P95 ${ms(timing.inference.p95Ms)}；网络往返 P95 ${ms(timing.networkRtt.p95Ms)}。延迟从实际发声计到浏览器收到完整起音窗口，包含采集、等待、传输和计算。`;
  $('piano-auto-metrics').replaceChildren();
  const cards=[['已评测组',totals.groups],['正确弹奏放行',totals.correctPasses],['正确弹奏被误拦',totals.falseBlocks],['实际插入错音组',totals.injectedErrors],['错音正确拦截',totals.detectedErrors],['错音被误放行',totals.falsePasses]];
  for(const[label,value]of cards){const card=document.createElement('div'),strong=document.createElement('strong');strong.textContent=value;card.append(strong,document.createTextNode(label));$('piano-auto-metrics').append(card);}
  const metrics=result.recognitionMetrics;
  $('piano-auto-note-metrics').textContent=metrics?`音符识别 F1 ${percent(metrics.f1)}，精确率 ${percent(metrics.precision)}，召回率 ${percent(metrics.recall)}。匹配 ${metrics.tp}，多识别 ${metrics.fp}，漏识别 ${metrics.fn}。F1 按单个音符统计，是精确率与召回率的调和平均；上方判断正确率按整组音符是否判对统计，二者不同。`:'音符识别 F1、精确率和召回率在完整音频处理后汇总。上方逐组判断正确率随模型返回实时更新。';
  $('piano-auto-interpretation').textContent=`实际跟弹走到 ${result.waitingFollower.completedSteps}/${result.waitingFollower.totalSteps} 组，这是跟弹进度。上方正确率独立对照每次自动弹奏与模型输出。${result.analysis.unmatchedModelEvents.length?`起音窗口外另有 ${result.analysis.unmatchedModelEvents.length} 个模型事件，已保留在完整结果中。`:''}模拟音频测试不能代表真实学生的录音准确率。`;
  const body=$('piano-auto-rows');body.replaceChildren();
  const verdicts={correctPasses:'正确弹奏已放行',falseBlocks:'已弹对，模型误拦',detectedErrors:'错音已检出（应等待）',falsePasses:'错音被判正确（误放行）',pending:'等待模型，不计入准确率'};
  const errors={none:'正确',replace:'换错音',extra:'多弹音',missing:'漏弹音'};
  for(const group of result.analysis.rows){
    const row=body.insertRow();row.dataset.verdict=group.verdict;
    const differences=[group.extra.length?`多识别 ${group.extra.map(midiName).join('、')}`:'',group.missing.length?`漏识别 ${group.missing.map(midiName).join('、')}`:''].filter(Boolean).join('；');
    const verdict=verdicts[group.verdict]+(group.verdict!=='pending'&&differences?`；${differences}`:'');
    for(const value of [`${group.index+1} · ${group.audioOnsetSeconds.toFixed(2)}s`,group.expected.map(midiName).join(' + '),`${group.pitches.map(midiName).join(' + ')}（${errors[group.error]}）`,group.heard.map(midiName).join(' + ')||(group.verdict==='pending'?'识别中…':'未识别到音'),verdict])row.insertCell().textContent=value;
  }
  if(!result.analysis.rows.length){const cell=body.insertRow().insertCell();cell.colSpan=5;cell.textContent='没有完成可对照的弹奏音符组。';}
  renderAutomaticDecisions(result);
}
async function waitForPiano(predicate,timeout=30000) {
  const began=performance.now();
  while(!predicate()){
    if(performance.now()-began>timeout)throw new Error('等待钢琴或模型处理超时，请检查连接后重试');
    if(pianoPhase==='error')throw new Error($('practice-status').textContent||'钢琴连接失败');
    await new Promise(resolve=>setTimeout(resolve,50));
  }
}
async function startAutomaticTest(mode) {
  if(autoStarting||automaticRunning())return;
  autoStarting=true;updateAutomaticControls();
  let run;
  try{
    if(pendingJob)throw new Error('请先等待上传录音识别完成');
    if(recording&&(!pianoActive()||sampler.events.length||!source?.metadata.saveRecording)){
      await $('practice-mic-stop').onclick();await waitForPiano(()=>!recording,45000);
    }
    $('practice-input').value='piano';$('practice-mode').value='follow';applyMode();applyInput();
    const settings=config(),seed=crypto.getRandomValues(new Uint32Array(1))[0];
    const plan=makeAutoPlan(score.notes,{hand:settings.hand,startSeconds:startTime(settings),endSeconds:endTime(settings),speed:settings.speed,mode,errorRate:Number($('piano-auto-error-rate').value),seed});
    run=autoTest={id:crypto.randomUUID(),status:'preparing',plan,settings,groups:[],observedEvents:[],velocity:Number($('simulator-velocity').value),pedal:$('simulator-pedal').checked,finishedNaturally:false};
    $('practice-result-view').hidden=false;$('practice-result-view').value='automatic';
    $('piano-auto-download').disabled=true;
    updateAutomaticControls();updatePianoGuidance();
    if(!recording)await $('practice-mic-start').onclick();
    await waitForPiano(()=>pianoActive()&&pianoPhase==='ready');
    source.metadata.autoTest={id:run.id,plan,settings,velocity:run.velocity,pedal:run.pedal};
    run.status='playing';
    run.player=new AutoPianoPlayer(sampler,plan,{velocity:run.velocity,tailSeconds:(source.metadata.model?.rightContextSeconds||2.4)+.4,
      onStep:group=>{run.groups.push(group);updateAutomaticControls();},onPaint:paintHeld,
      onFinish:()=>{run.finishedNaturally=true;run.status='processing';updateAutomaticControls();void $('practice-mic-stop').onclick();},
      onError:error=>{run.error=error.message;run.status='processing';updateAutomaticControls();notify(error.message,true);void $('practice-mic-stop').onclick();},
    });
    run.player.start();updateAutomaticControls();updatePianoGuidance();
  }catch(error){
    if(run){run.error=error.message;run.status='failed';run.player?.stop();finishAutomaticResult(run,null,0,false);}
    updateAutomaticControls();notify(error.message,true);
    if(recording&&pianoActive())void $('practice-mic-stop').onclick();
  }finally{autoStarting=false;updateAutomaticControls();}
}
$('piano-auto-correct').onclick=()=>void startAutomaticTest('correct');
$('piano-auto-random').onclick=()=>void startAutomaticTest('random');
$('piano-auto-stop').onclick=()=>void $('practice-mic-stop').onclick();
$('piano-auto-download').onclick=()=>{
  if(!autoTest?.result)return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(autoTest.result,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=`pianoval-auto-${autoTest.id}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
function updateChoices(state) {
  const modelValue = $('practice-model').value;
  $('practice-model').replaceChildren(new Option('基础预训练模型','base'), new Option('当前启用模型','active'));
  for (const job of state.jobs.filter((item) => item.kind === 'training' && item.status === 'completed')) {
    $('practice-model').add(new Option(`候选 ${job.id.slice(0,6)}${job.result.demonstration ? ' · 演示' : ''}`,job.id));
  }
  if ([...$('practice-model').options].some((option) => option.value === modelValue)) $('practice-model').value = modelValue;
  const selectedRecord = $('practice-recording').value;
  const records = [...state.records].sort((a,b) => b.createdAt - a.createdAt);
  $('practice-recording').replaceChildren(...records.map((record) => new Option(record.title,record.id)));
  if (!records.length) $('practice-recording').add(new Option('先上传一段实弹录音',''));
  if (records.some((record) => record.id === selectedRecord)) $('practice-recording').value = selectedRecord;
}

function versionChoices() {
  const piece=catalog.find(piece=>piece.id===$('practice-piece').value);
  $('practice-difficulty').replaceChildren(...piece.versions.map(version=>new Option(version.name,version.id)));
}
async function loadScore({resetRange=false}={}) {
  if(recording||pendingJob){
    if(score){$('practice-piece').value=score.id;versionChoices();$('practice-difficulty').value=score.difficulty;}
    throw new Error('请结束当前测试或等待录音识别完成后再切换曲谱');
  }
  const revision = ++loadingScore;
  stopReference(); source = null; lastReport = null;
  autoTest=null;$('piano-auto-result').hidden=true;$('practice-result-view').hidden=true;$('practice-result-view').value='follower';
  $('piano-auto-progress').textContent='选择完全正确弹或随机错误弹，自动启动并生成这首曲目的报告。';
  $('practice-status').textContent = '正在载入曲谱与左右手 MIDI…';
  const data = await api(`/practice/${encodeURIComponent($('practice-difficulty').value)}?pieceId=${encodeURIComponent($('practice-piece').value)}`);
  if (revision !== loadingScore) return;
  score = data;
  score.assetsBase=appPath(data.assetsBase);
  for(const option of $('practice-notation').options)option.disabled=option.value!=='staff'&&!data.assets[option.value];
  if($('practice-notation').selectedOptions[0].disabled)$('practice-notation').value='staff';
  $('practice-title').textContent=data.title;
  $('practice-original').href=data.source;
  $('practice-start-measure').max = data.bars; $('practice-end-measure').max = data.bars;
  if(resetRange){$('practice-start-measure').value=1;$('practice-end-measure').value=Math.min(8,data.bars);}
  if (Number($('practice-end-measure').value) > data.bars) $('practice-end-measure').value = data.bars;
  if (Number($('practice-start-measure').value) > data.bars) $('practice-start-measure').value = 1;
  $('practice-bpm').min=Math.ceil(data.tempo*.5);$('practice-bpm').max=Math.floor(data.tempo*1.5);$('practice-bpm').value=data.tempo;
  $('practice-score-meta').textContent = `${data.difficultyName} · ${data.bars} 小节 · ${data.tempo} BPM${data.bars!==data.sourceBars?' · 含反复展开':''}`;
  const track=$('practice-accompaniment');
  $('practice-audio-offset').value=0;$('practice-audio-speed').value=1;
  track.closest('.reference-track').hidden=!data.assets.accompaniment;
  if(data.assets.accompaniment)track.src=data.assetsBase+data.assets.accompaniment;else {track.removeAttribute('src');track.load();}
  track.playbackRate=1;
  await renderScore(revision);
  if (revision !== loadingScore) return;
  $('practice-status').textContent = '曲谱已就绪。先选片段、速度和模型，再上传录音或开始听琴。';
  $('practice-comparison').replaceChildren(); $('practice-recompare').disabled = true; $('practice-report-download').disabled = true;
  savedRecordingId=null;$('practice-review-recording').hidden=true;
  applyMode();updateAutomaticControls();
}
async function renderScore(revision = loadingScore) {
  if (!score) return;
  scoreCursor = null;
  const mode = $('practice-notation').value;
  $('practice-score-render').hidden = mode !== 'staff'; $('practice-score-image').hidden = mode === 'staff';
  if (mode !== 'staff') {
    $('practice-score-image').src = `${score.assetsBase}${score.assets[mode]}`;
    return;
  }
  if (!window.opensheetmusicdisplay) throw new Error('五线谱渲染器未加载，请刷新；也可选择原站简谱或双谱');
  if (!osmd) osmd = new window.opensheetmusicdisplay.OpenSheetMusicDisplay($('practice-score-render'), {
    autoResize:true, backend:'svg', drawingParameters:'compacttight', drawTitle:false, drawSubtitle:false,
    drawComposer:false, renderSingleHorizontalStaffline:true, followCursor:false,
    cursorsOptions:[{type:0,color:'#218c79',alpha:0.22,follow:false}],
  });
  const xmlResponse = await fetch(`${score.assetsBase}${score.assets.musicXml}`);
  if (!xmlResponse.ok) throw new Error('乐谱文件载入失败');
  const xml = await xmlResponse.text(); if (revision !== loadingScore) return;
  await osmd.load(xml); if (revision !== loadingScore) return;
  osmd.Zoom = 0.85; osmd.render();
  scoreCursor=new ScoreCursor(osmd.cursor);
  updateCursor(isFollow()&&follower?.current?follower.current.onsetSeconds:startTime(config()));
}
function updateCursor(time) {
  if (!score) return;
  const position=printedPosition(score,time);
  $('practice-position').textContent = `演奏顺序第 ${position.measure} / ${score.bars} 小节${score.bars!==score.sourceBars?`（谱面第 ${position.sourceMeasure} 小节）`:''} · ${Math.max(0,time).toFixed(1)} 秒`;
  if (!scoreCursor || $('practice-notation').value !== 'staff') return;
  try {
    if(scoreCursor.cursor!==osmd.cursor)scoreCursor=new ScoreCursor(osmd.cursor);
    scoreCursor.seek(position.quarter);
    const element = osmd.cursor.cursorElement;
    if (element) {
      const scroll = $('practice-sheet-scroll');
      const x = element.getBoundingClientRect().left - scroll.getBoundingClientRect().left + scroll.scrollLeft;
      if (x > scroll.scrollLeft + scroll.clientWidth - 80 || x < scroll.scrollLeft + 30) scroll.scrollLeft = Math.max(0,x - scroll.clientWidth * 0.25);
    }
  } catch { /* Score agreement uses MIDI timing even when the visual cursor reaches its end. */ }
}
function keyboard() {
  const container = $('practice-keyboard'); container.replaceChildren();
  const inner = document.createElement('div');inner.className='piano-keyboard-inner';container.append(inner);
  const whitePitches = [];
  for (let pitch=21;pitch<=108;pitch++) if (![1,3,6,8,10].includes(pitch%12)) whitePitches.push(pitch);
  for (const pitch of whitePitches) {
    const key = document.createElement('div');key.className='piano-key';key.dataset.midi=pitch;
    if (pitch % 12 === 0) { const label=document.createElement('span');label.textContent=midiName(pitch);key.append(label); }
    makePlayable(key,pitch);inner.append(key);
  }
  for (let pitch=22;pitch<108;pitch++) if ([1,3,6,8,10].includes(pitch%12)) {
    const index=whitePitches.findIndex((white) => white === pitch-1);
    const key=document.createElement('div'); key.className='piano-key sharp';key.dataset.midi=pitch;
    key.style.left=`calc(100% * ${(index+1)/whitePitches.length} - 5px)`;makePlayable(key,pitch);inner.append(key);
  }
}
function pianoActive() {return recording&&$('practice-input').value==='piano'&&sampler?.origin!==null&&sampler?.context.state==='running';}
function paintHeld() {
  const pitches=new Set([...heldKeys.values()].map((key)=>key.midi));
  for(const pitch of autoTest?.player?.activePitches||[])pitches.add(pitch);
  for(const key of document.querySelectorAll('#practice-keyboard [data-midi]')){
    key.classList.toggle('pressed',pitches.has(Number(key.dataset.midi)));
    key.classList.toggle('armed',armedPitches.has(Number(key.dataset.midi)));
  }
  $('simulator-chord-label').textContent=armedPitches.size?[...armedPitches].sort((a,b)=>a-b).map(midiName).join(' + '):'未选和弦';
}
function releaseHeld(identifier) {
  const held=heldKeys.get(identifier);if(!held)return;
  sampler?.noteOff(held.voice);heldKeys.delete(identifier);paintHeld();
}
function playHeld(identifier,pitch,time) {
  if(!pianoActive()||heldKeys.has(identifier)||[...heldKeys.values()].some((key)=>key.midi===pitch))return;
  const voice=sampler.noteOn(pitch,Number($('simulator-velocity').value),time);
  if(voice)heldKeys.set(identifier,{voice,midi:pitch});paintHeld();
}
function makePlayable(key,pitch) {
  key.title=`${midiName(pitch)} · MIDI ${pitch}`;key.setAttribute('role','button');key.setAttribute('aria-label',key.title);key.tabIndex=0;
  const hint=document.createElement('span');hint.className='piano-key-target-hint';hint.hidden=true;hint.setAttribute('aria-hidden','true');
  const arrow=document.createElement('b');arrow.textContent='↓';
  const tap=document.createElement('small');tap.className='piano-key-tap';tap.textContent='点这里';
  const name=document.createElement('strong');name.textContent=midiName(pitch);
  const shortcut=document.createElement('kbd');hint.append(arrow,tap,name,shortcut);key.append(hint);
  key.onpointerdown=(event)=>{
    if($('practice-input').value!=='piano')return;
    event.preventDefault();
    if(automaticRunning())return;
    if(chordMode){if(armedPitches.has(pitch))armedPitches.delete(pitch);else armedPitches.add(pitch);paintHeld();return;}
    if(!pianoActive()){notify('先点击“启动模拟测试”，等待采样与模型就绪。');return;}
    key.setPointerCapture(event.pointerId);playHeld(`pointer-${event.pointerId}`,pitch);
  };
  key.onpointerup=key.onpointercancel=(event)=>releaseHeld(`pointer-${event.pointerId}`);
  key.onkeydown=(event)=>{if(['Enter','Space'].includes(event.code)){event.preventDefault();if(!automaticRunning())playHeld(`accessible-${pitch}`,pitch);}};
  key.onkeyup=(event)=>{if(['Enter','Space'].includes(event.code))releaseHeld(`accessible-${pitch}`);};
}
function applyInput() {
  const virtual=$('practice-input').value==='piano';
  $('practice-teacher-help').hidden=virtual;
  $('view-practice').classList.toggle('piano-mode',virtual);
  $('simulator-controls').hidden=!virtual;$('piano-play-controls').hidden=!virtual;$('practice-keyboard').classList.toggle('virtual',virtual);
  $('practice-keyboard').setAttribute('aria-label',virtual?'可弹奏的 88 键钢琴':'实际识别音符键盘');
  $('practice-mic-start').textContent=virtual?'启动模拟测试':'开始听琴';
  $('practice-input-heading').textContent=virtual?'方式二 · 虚拟钢琴弹奏':'方式二 · 麦克风实弹';
  if(virtual)$('practice-mode-help').textContent='点击琴键发声，声音送到真实模型。弹对当前目标才前进；错音、漏音和多音会停住。';
  if(virtual)$('practice-keyboard').scrollLeft=document.querySelector(`#practice-keyboard [data-midi="${$('simulator-octave').value}"]`)?.offsetLeft-40||0;
  updatePianoGuidance(true);
}
function playChord(pitches) {
  if(automaticRunning())throw new Error('自动测试正在演奏，请等待结果或先停止自动测试');
  if(!pianoActive())throw new Error('先启动模拟测试，等待采样和模型就绪');
  if(heldKeys.size)throw new Error('请先松开正在按下的琴键');
  const time=sampler.context.currentTime+.008;
  for(const pitch of new Set(pitches)){
    const identifier=Symbol(pitch);playHeld(identifier,pitch,time);setTimeout(()=>releaseHeld(identifier),800);
  }
}
const lowerKeys=['KeyZ','KeyS','KeyX','KeyD','KeyC','KeyV','KeyG','KeyB','KeyH','KeyN','KeyJ','KeyM','Comma','KeyL','Period','Semicolon','Slash'];
const upperKeys=['KeyQ','Digit2','KeyW','Digit3','KeyE','KeyR','Digit5','KeyT','Digit6','KeyY','Digit7','KeyU','KeyI','Digit9','KeyO','Digit0','KeyP'];
function pianoShortcuts(pitch) {
  const base=Number($('simulator-octave').value);
  return [upperKeys[pitch-base-12],lowerKeys[pitch-base]].filter(Boolean).map((code)=>
    ({Comma:',',Period:'.',Semicolon:';',Slash:'/'}[code]||code.replace(/^(Key|Digit)/,'')));
}
function setPianoPhase(phase){pianoPhase=phase;updatePianoGuidance();}
function updatePianoFeedback() {
  const visible=$('practice-input').value==='piano'&&isFollow()&&!automaticRunning();
  $('piano-attempt-feedback').hidden=!visible;
  const feedback=pianoAttemptFeedback(pianoAttempt,liveNotes,throughSeconds,follower?.trace||[]);
  $('piano-attempt-feedback').dataset.state=feedback.state;
  $('piano-attempt-title').textContent=feedback.title;
  $('piano-attempt-played').textContent=feedback.played;
  $('piano-attempt-heard').textContent=feedback.heard;
  $('piano-attempt-detail').textContent=feedback.detail;
  return feedback;
}
function updatePianoGuidance(forceScroll=false) {
  const visible=$('practice-input').value==='piano',follow=isFollow();
  const pitches=visible&&follow&&follower?.current?follower.current.pitches:[];
  const feedback=updatePianoFeedback();
  const signature=JSON.stringify([visible,follow,follower?.index,pitches,$('simulator-octave').value,pianoPhase,feedback.state,automaticRunning()]);
  if(signature===guidanceSignature&&!forceScroll)return;
  guidanceSignature=signature;
  const targetSignature=JSON.stringify([visible,follow,pitches,$('simulator-octave').value]);
  const scrollNeeded=forceScroll||targetSignature!==guidanceTargetSignature;
  guidanceTargetSignature=targetSignature;
  const guide=$('piano-key-guidance');guide.hidden=!visible;
  const chips=$('piano-target-keys');chips.replaceChildren();
  const complete=follow&&follower?.complete;
  const phases={idle:'尚未开始',loading:'正在准备，请稍等',ready:'可以弹了',listening:'正在听，请稍等',stopping:'正在结束测试',finished:'本次测试已结束',error:'未能开始，请重试'};
  $('piano-ready-status').textContent=pianoPhase==='ready'&&feedback.state==='model-mismatch'?'模型识别有偏差':phases[pianoPhase];
  $('piano-ready-status').dataset.phase=pianoPhase;
  $('piano-ready-status').dataset.feedback=feedback.state;
  $('piano-enable-guidance').hidden=follow;
  $('piano-enable-guidance').disabled=recording;
  $('piano-play-guided').hidden=!follow||complete;
  $('piano-play-guided').disabled=automaticRunning()||!pianoActive()||!pitches.length||pianoPhase!=='ready';
  $('piano-play-guided').textContent=pitches.length>1?'用鼠标？帮我一起弹这组':'不会找？帮我弹这一键';
  $('piano-guidance-title').textContent=automaticRunning()?'自动测试中，无需手动按琴键'
    :!follow?'当前是固定节拍对照，点击“开启按键引导”查看该点哪里'
    :complete?'所选片段已完成':pianoPhase==='loading'?'正在加载钢琴和识别模型，准备好后再点琴键'
    :pianoPhase==='idle'?'先点击“启动模拟测试”，再点下方标着“点这里”的琴键'
    :pianoPhase==='listening'?'已收到按键，正在识别；先松开，等提示切到下一键'
    :pianoPhase==='stopping'?'正在处理最后的声音，请稍等'
    :pianoPhase==='finished'?'本次已结束，点击“启动模拟测试”可以重新开始'
    :pianoPhase==='error'?'连接未成功，请重新启动后再点琴键'
    :feedback.state==='model-mismatch'?'你已按对，请查看下方的模型识别差异'
    :pitches.length>1?`可以弹了：同时按下 ${pitches.length} 个蓝色琴键（${pitches.map((_,i)=>'①②③④⑤⑥⑦⑧⑨⑩'[i]||String(i+1)).join('、')}）`
    :'可以弹了：点击下方蓝色箭头指着的“点这里”';
  $('piano-guidance-note').textContent=automaticRunning()?'橙色为自动弹奏的键，绿色为模型听到的音；蓝色跟弹目标仍只由模型推进，结果会保留卡点。'
    :!follow?`${recording?'先结束当前测试，再开启引导。':''}按键引导会逐步告诉你点哪一个琴键，不需要看懂琴谱。`
    :complete?'本段没有待弹音符，可结束测试或重新选择片段。'
    :pianoPhase==='ready'&&feedback.state==='model-mismatch'?'已经确认你按了目标键，无需反复点击。可“结束并对照”保存本次误识别，供后续模型评测。'
    :pitches.length>1?'和弦要一起发声。Pad 可以多指同时按；电脑可以按提示的多个字母，或点击“帮我一起弹这组”。'
    :'不用懂音名。按住“点这里”约半秒再松开，等待几秒；通过后蓝色提示会自动移到下一键。';
  for(const [index,pitch] of pitches.entries()) {
    const chip=document.createElement('button');chip.className='piano-target-chip';chip.type='button';
    chip.setAttribute('aria-label',`定位应弹琴键 ${midiName(pitch)}`);
    const number=document.createElement('span');number.className='piano-target-number';number.textContent='①②③④⑤⑥⑦⑧⑨⑩'[index]||String(index+1);
    const name=document.createElement('strong');name.textContent=midiName(pitch);chip.append(number,name);
    const shortcuts=pianoShortcuts(pitch);
    if(shortcuts.length){const key=document.createElement('kbd');key.textContent=shortcuts.join(' 或 ');chip.append(key);}
    else{const hint=document.createElement('small');hint.textContent='点击琴键';chip.append(hint);}
    chip.onclick=()=>{
      const key=document.querySelector(`#practice-keyboard [data-midi="${pitch}"]`);
      if(key)$('practice-keyboard').scrollTo({left:key.offsetLeft-$('practice-keyboard').clientWidth/2+key.offsetWidth/2,behavior:'smooth'});
    };
    chips.append(chip);
  }
  for(const key of document.querySelectorAll('#practice-keyboard [data-midi]')) {
    const pitch=Number(key.dataset.midi),target=pitches.includes(pitch),hint=key.querySelector('.piano-key-target-hint');
    key.classList.toggle('target',target);hint.hidden=!target;
    hint.querySelector('b').textContent=target?`${'①②③④⑤⑥⑦⑧⑨⑩'[pitches.indexOf(pitch)]||pitches.indexOf(pitch)+1}\n↓`:'↓';
    const shortcuts=pianoShortcuts(pitch);hint.querySelector('kbd').textContent=shortcuts[0]||'';
    hint.querySelector('kbd').hidden=!shortcuts.length;
    key.setAttribute('aria-label',`${midiName(pitch)} · MIDI ${pitch}${target?' · 当前应弹'+(shortcuts.length?` · 电脑键 ${shortcuts.join(' 或 ')}`:''):''}`);
  }
  if(!pitches.length||!scrollNeeded)return;
  requestAnimationFrame(()=>{
    if(guidanceTargetSignature!==targetSignature)return;
    const container=$('practice-keyboard');if(!container.clientWidth)return;
    const targets=pitches.map((pitch)=>document.querySelector(`#practice-keyboard [data-midi="${pitch}"]`));
    const left=Math.min(...targets.map((key)=>key.offsetLeft)),right=Math.max(...targets.map((key)=>key.offsetLeft+key.offsetWidth));
    const viewport=container.clientWidth-14;
    const position=right-left<viewport-32?(left+right-viewport)/2:left-20;
    container.scrollTo({left:Math.max(0,position),behavior:forceScroll||matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  });
}
window.addEventListener('resize',()=>updatePianoGuidance(true));
document.addEventListener('keydown',(event)=>{
  if(automaticRunning()||event.repeat||!pianoActive()||event.ctrlKey||event.metaKey||event.altKey||/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))return;
  const lower=lowerKeys.indexOf(event.code),upper=upperKeys.indexOf(event.code);
  const pitch=Number($('simulator-octave').value)+(lower>=0?lower:upper>=0?upper+12:-1000);
  if(pitch<21||pitch>108)return;
  event.preventDefault();playHeld(`computer-${event.code}`,pitch);
});
document.addEventListener('keyup',(event)=>releaseHeld(`computer-${event.code}`));
window.addEventListener('blur',()=>{for(const key of [...heldKeys.keys()])releaseHeld(key);});
$('simulator-velocity').oninput=()=>{$('simulator-velocity-value').textContent=$('simulator-velocity').value;};
$('simulator-octave').onchange=()=>{
  $('practice-keyboard').scrollLeft=document.querySelector(`#practice-keyboard [data-midi="${$('simulator-octave').value}"]`)?.offsetLeft-40||0;
  updatePianoGuidance(true);
};
$('piano-prev').onclick=()=>$('practice-keyboard').scrollBy({left:-230,behavior:'smooth'});
$('piano-next').onclick=()=>$('practice-keyboard').scrollBy({left:230,behavior:'smooth'});
$('piano-start').onclick=()=>$('practice-mic-start').click();
$('piano-stop').onclick=()=>$('practice-mic-stop').click();
$('piano-enable-guidance').onclick=()=>{$('practice-mode').value='follow';applyMode();};
$('piano-play-guided').onclick=()=>{try{if(follower?.current)playChord(follower.current.pitches);}catch(error){notify(error.message,true);}};
$('simulator-pedal').onchange=()=>sampler?.setPedal($('simulator-pedal').checked);
$('simulator-chord-mode').onclick=()=>{chordMode=!chordMode;$('simulator-chord-mode').textContent=`组和弦：${chordMode?'开启':'关闭'}`;};
$('simulator-chord-play').onclick=()=>{try{if(!armedPitches.size)throw new Error('先开启组和弦，点击琴键选音，再一起弹奏');playChord([...armedPitches]);}catch(error){notify(error.message,true);}};
$('simulator-target').onclick=()=>{try{if(!follower?.current)throw new Error('没有等待的目标，请先选择跟弹模式和片段');playChord(follower.current.pitches);}catch(error){notify(error.message,true);}};
$('simulator-wrong').onclick=()=>{try{
  if(!follower?.current)throw new Error('请先选择跟弹模式和片段');
  let pitch=follower.current.pitches[0]+1;while(follower.current.pitches.includes(pitch))pitch++;
  if(pitch>108)pitch=21;playChord([pitch]);
}catch(error){notify(error.message,true);}};
$('practice-input').onchange=()=>{if($('practice-input').value==='piano')$('practice-mode').value='follow';applyMode();applyInput();};
function flashNotes(notes) {
  clearTimeout(pulseTimer);
  const pitches=new Set(notes.map((note)=>note.midi));
  for (const key of document.querySelectorAll('#practice-keyboard [data-midi]')) key.classList.toggle('played',pitches.has(Number(key.dataset.midi)));
  pulseTimer=setTimeout(()=>{for(const key of document.querySelectorAll('#practice-keyboard [data-midi]'))key.classList.remove('played');},500);
}
async function compare(final = true, frozenConfig = null) {
  if (!source || comparing) return;
  comparing = true;
  const serial = ++comparisonSerial;
  try {
    const settings = frozenConfig || config();
    if (isFollow()) {
      if (!source.notes && source.jobId) {
        const result = await api(`/jobs/${source.jobId}/result`);
        source.notes = result.events.map(({midi,onsetSeconds,velocity})=>({midi,onsetSeconds,velocity}));
      }
      liveConfig=settings;resetFollower(settings);follower.push(source.notes,Infinity,true);showFollower();followReport(final);
      $('practice-recompare').disabled=false;
      return;
    }
    const request = {...settings, ...(source.jobId ? {jobId:source.jobId} : {notes:source.notes}),
      ...(!final ? {throughSeconds:throughSeconds} : {})};
    const response=await api('/practice/compare',{method:'POST',body:JSON.stringify(request)});
    if (serial !== comparisonSerial) return;
    lastReport={id:source.metadata.testRunId||crypto.randomUUID(),mode:'fixed-tempo',status:final?'completed':'failed',final,analysis:{},model:source.metadata.model||null,sessionId:source.metadata.sessionId||null,recordingId:savedRecordingId,
      score:{id:score.id,title:score.title,difficulty:settings.difficulty,hand:settings.hand},settings,
      source:source.metadata,modelId:source.modelId,comparison:response,observedNotes:response.observedNotes,
      createdAt:new Date().toISOString(),limitation:'Fixed tempo and manual offset; score agreement is not acoustic recognition accuracy'};
    if(final&&source.metadata.kind==='microphone')void persistPracticeReport(lastReport);
    showComparison(response,final);
    $('practice-recompare').disabled=false; $('practice-report-download').disabled=false;
  } finally { comparing=false; }
}
function showComparison(result,final) {
  const metrics=result.metrics;
  $('practice-comparison').replaceChildren();
  for(const[label,value]of[['与谱音符 F1',percent(metrics.f1)],['匹配音符',String(metrics.tp)],['谱面未匹配',String(metrics.fn)],['结果中多出',String(metrics.fp)]]){
    const div=document.createElement('div');div.className='practice-metric';
    const strong=document.createElement('strong');strong.textContent=value;div.append(strong,document.createTextNode(label));$('practice-comparison').append(div);
  }
  $('practice-event-count').textContent=`${final?'完整片段':'已分析区间'} · 谱面 ${result.expectedCount} 音 · 识别 ${result.observedCount} 音`;
  const body=$('practice-difference-body');body.replaceChildren();
  for(const note of result.differences.slice(0,300)){
    const row=body.insertRow();
    row.insertCell().textContent=`${note.onsetSeconds.toFixed(3)} s`;
    row.insertCell().textContent=note.note||midiName(note.midi);row.insertCell().textContent=note.midi;
    const tag=document.createElement('span');tag.className=`diff-tag ${note.kind}`;tag.textContent=note.kind==='missing'?'谱面未匹配':'结果中多出';row.insertCell().append(tag);
    row.insertCell().textContent=note.meaning;
  }
  if(!result.differences.length){const cell=body.insertRow().insertCell();cell.colSpan=5;cell.textContent=result.expectedCount?'此区间暂未发现差异。':'该时间段还没有可对照音符。';}
}

$('practice-upload').onclick=()=>$('audio-upload').click();
$('practice-mode').onchange=()=>{applyMode();if(source)void compare(true).catch((error)=>notify(error.message,true));};
for(const id of ['practice-hand','practice-start-measure','practice-end-measure'])$(id).addEventListener('change',()=>{
  const start=$('practice-start-measure'),end=$('practice-end-measure');
  // Editing a pair of range fields temporarily leaves an incomplete range.
  // Validate on Start, and refresh the target once both fields are valid.
  if(!Number.isInteger(Number(start.value))||!Number.isInteger(Number(end.value))
    ||Number(start.value)<1||Number(end.value)>score?.bars||Number(start.value)>Number(end.value))return;
  if(isFollow()&&score){try{resetFollower();}catch(error){notify(error.message,true);}}
});
$('follow-reset').onclick=()=>{try{resetFollower();$('practice-status').textContent='已回到所选片段开头，开始听琴后按当前目标演奏。';}catch(error){notify(error.message,true);}};
function releaseFollow(nextMeasure=false){
  try{
    const audioOnsetSeconds=liveAudioSeconds();
    if(!recording||audioOnsetSeconds===null||!isFollow()||!follower?.current||automaticRunning())return;
    const nextBar=measureAt(score,follower.current.onsetSeconds)+1;
    const decision=follower.manualAdvance({audioOnsetSeconds,
      ...(nextMeasure?{toScoreSeconds:measureStart(score,nextBar),reason:'next-measure'}:{reason:'teacher-release'})});
    if(!decision)return;
    pianoAttempt=null;
    showFollower();followReport(false);
    // Persist immediately, not only at the end: keep overrides if the iPad disconnects.
    void persistPracticeReport(lastReport);
    $('follow-recovery-note').textContent=follower.complete?'所选片段已结束。请点击“结束并对照”保存完整录音。'
      :`已人工放行 ${decision.skippedSteps} 组。请从第 ${measureAt(score,follower.current.onsetSeconds)} 小节、${follower.current.pitches.map(midiName).join(' + ')} 继续弹奏。`;
    if(pianoActive())setPianoPhase('ready');
  }catch(error){notify(error.message,true);}
}
$('follow-release').onclick=()=>releaseFollow();
$('follow-release-panel').onclick=()=>releaseFollow();
$('follow-next-measure').onclick=()=>releaseFollow(true);
$('practice-review-recording').onclick=async()=>{
  if(!savedRecordingId)return;
  try{await refresh();showView('recordings');await selectRecord(savedRecordingId);}catch(error){notify(error.message,true);}
};
$('practice-difficulty').onchange=()=>loadScore({resetRange:true}).catch((error)=>notify(error.message,true));
$('practice-piece').onchange=()=>{versionChoices();void loadScore({resetRange:true}).catch(error=>notify(error.message,true));};
async function randomScore() {
  if(recording||pendingJob)throw new Error('请先结束当前测试');
  const choices=catalog.filter(piece=>piece.id!==score?.id);
  const choose=items=>items[crypto.getRandomValues(new Uint32Array(1))[0]%items.length];
  const piece=choose(choices);$('practice-piece').value=piece.id;versionChoices();
  $('practice-difficulty').value=choose(piece.versions).id;
  await loadScore({resetRange:true});
}
$('practice-random').onclick=()=>void randomScore().catch(error=>notify(error.message,true));
$('piano-auto-random-piece').onclick=async()=>{
  const button=$('piano-auto-random-piece');button.disabled=true;
  try{await randomScore();await startAutomaticTest('correct');}catch(error){notify(error.message,true);}finally{updateAutomaticControls();}
};
$('practice-notation').onchange=()=>renderScore().catch((error)=>notify(error.message,true));
$('practice-fullscreen').onclick=()=>{
  const card=document.querySelector('.practice-score-card');
  if(document.fullscreenElement)void document.exitFullscreen();else void card.requestFullscreen().catch((error)=>notify(error.message,true));
};
$('practice-bpm').onchange=()=>{ $('practice-accompaniment').playbackRate=Number($('practice-bpm').value)/score.tempo;stopReference(); };
$('practice-reference').onclick=async()=>{
  if(reference){stopReference();return;}
  try{
    const settings=config();const start=startTime(settings);const end=endTime(settings);
    $('practice-accompaniment').pause();
    const context=new AudioContext();await context.resume();
    const time=context.currentTime+0.08;
    reference={context,timer:null};
    for(const note of score.notes){
      if(note.onsetSeconds<start-.001||note.onsetSeconds>=end-.001||(settings.hand!=='both'&&note.hand!==settings.hand))continue;
      const onset=time+(note.onsetSeconds-start)/settings.speed;const length=Math.min(2,note.durationSeconds/settings.speed);
      const oscillator=context.createOscillator();const gain=context.createGain();oscillator.type='triangle';
      oscillator.frequency.value=440*2**((note.midi-69)/12);gain.gain.setValueAtTime(0,onset);gain.gain.linearRampToValueAtTime(0.08,onset+0.01);gain.gain.exponentialRampToValueAtTime(0.001,onset+Math.max(0.04,length));
      oscillator.connect(gain);gain.connect(context.destination);oscillator.start(onset);oscillator.stop(onset+Math.max(0.04,length)+0.02);
    }
    animatePlayback(()=>start+Math.max(0,context.currentTime-time)*settings.speed,settings.hand);
    reference.timer=setInterval(()=>{
      const elapsed=context.currentTime-time;
      if(elapsed>(end-start)/settings.speed)stopReference();
    },120);
    $('practice-reference').textContent='■ 停止示范';
  }catch(error){stopReference();notify(error.message,true);}
};
const accompaniment=$('practice-accompaniment');
function accompanimentTime() {return audioScoreTime(accompaniment.currentTime,Number($('practice-audio-offset').value),Number($('practice-audio-speed').value));}
accompaniment.addEventListener('play',()=>{
  if(recording){accompaniment.pause();notify('请先结束听琴，再播放试听音乐');return;}
  stopReference();animatePlayback(accompanimentTime);
});
for(const event of ['pause','ended','emptied'])accompaniment.addEventListener(event,stopPlaybackAnimation);
accompaniment.addEventListener('seeked',()=>{if(score)paintPlayback(accompanimentTime());if(accompaniment.paused)stopPlaybackAnimation();});
for(const id of ['practice-audio-offset','practice-audio-speed'])$(id).addEventListener('change',()=>{
  if(score&&Number.isFinite(accompanimentTime()))paintPlayback(accompanimentTime());
  if(accompaniment.paused)stopPlaybackAnimation();
});
$('practice-analyze').onclick=async()=>{
  try{
    if(pendingJob)throw new Error('请等待当前识别任务完成');
    const settings=config();const recordId=$('practice-recording').value;
    if(!recordId)throw new Error('请先上传并选择一段实弹录音');
    const job=await api(`/recordings/${recordId}/transcribe`,{method:'POST',body:JSON.stringify({modelId:$('practice-model').value})});
    pendingJob={id:job.id,settings,modelId:$('practice-model').value,recordId};$('practice-analyze').disabled=true;
    $('practice-status').textContent='录音已送入真实模型，正在识别…';await refresh();
  }catch(error){notify(error.message,true);}
};
$('practice-mic-start').onclick=async()=>{
  try{
    if(!automaticRunning()){$('practice-result-view').value='follower';$('practice-result-view').hidden=true;}
    if(pendingJob)throw new Error('请等待上传录音识别完成后再开始麦克风测试');
    liveConfig=config();stopReference();$('practice-accompaniment').pause();pianoAttempt=null;
    latencyLines.length=0;$('practice-latency-log').textContent='正在等待本次测试的第一窗音频…';
    if(isFollow())resetFollower(liveConfig);
    const usingPiano=$('practice-input').value==='piano';
    savedRecordingId=null;$('practice-review-recording').hidden=true;
    liveNotes=[];throughSeconds=0;source={notes:liveNotes,modelId:$('practice-model').value,metadata:{kind:usingPiano?'simulated-piano':'microphone'}};
    source.metadata.saveRecording=automaticRunning()||$('practice-save-recording').checked;
    source.metadata.testRunId=autoTest&&automaticRunning()?autoTest.id:crypto.randomUUID();source.statistics={groups:[],telemetry:[]};
    $('simulator-triggered').textContent='实际触发：等待按键';
    $('simulator-evaluation').hidden=true;
    let finalizing=false,finishTask=Promise.resolve();
    reportSaveError=null;
    setBusy(true);$('practice-status').textContent=usingPiano?'正在连接模型并加载真实钢琴采样…':'正在连接并申请麦克风；就绪后再弹奏…';
    const inputFactory=usingPiano?async(context)=>{
      sampler=new PianoSampler(context,(event)=>{
        $('simulator-triggered').textContent=`实际触发：${sampler.events.slice(-12).map((note)=>`${midiName(note.midi)} @${note.onsetSeconds.toFixed(2)}s`).join(' · ')}`;
        if(isFollow()&&!automaticRunning())pianoAttempt=recordPianoAttempt(pianoAttempt,event,follower?.current?.pitches||[],follower?.index||0);
        setPianoPhase('listening');
      });
      await sampler.load((count,total)=>{$('practice-status').textContent=`加载钢琴采样 ${count}/${total}…`;});
      sampler.setPedal($('simulator-pedal').checked);return sampler;
    }:undefined;
    await startLive({modelId:source.modelId, saveRecording:source.metadata.saveRecording,testId:source.metadata.testRunId,testContext:liveConfig,
      inputFactory,
      onCapture:()=>{if(usingPiano)setPianoPhase('ready');$('practice-status').textContent=usingPiano?'模拟钢琴已就绪。点击下方琴键或用电脑键盘弹奏；模型识别后才推进。':'麦克风已就绪，可以开始弹奏。';$('practice-mic-stop').disabled=false;$('piano-stop').disabled=false;updateAutomaticControls();updateRecovery();updateCursor(isFollow()&&follower.current?follower.current.onsetSeconds:startTime(liveConfig));},
      onError:(error)=>{if(usingPiano)setPianoPhase('error');$('practice-status').textContent=error.message;notify(error.message,true);},
      onMessage:(message)=>{
        if(message.type==='ready'){source.metadata.model=message.model;source.metadata.sessionId=message.sessionId;source.modelId=message.model.version;}
        if(message.type==='notes'){
          recordAutomaticTiming(source.statistics,message);
          if(autoTest&&autoTest.id===source.metadata.autoTest?.id){autoTest.observedEvents.push(...message.events);autoTest.processedThroughSeconds=message.processedThroughSeconds;autoTest.receivedAudioSeconds=message.receivedAudioSeconds;recordAutomaticTiming(autoTest,message);}
          liveNotes.push(...message.events.map(({midi,onsetSeconds,velocity})=>({midi,onsetSeconds,velocity})));
          throughSeconds=message.processedThroughSeconds;
          $('practice-status').textContent=`已收音 ${message.receivedAudioSeconds.toFixed(1)} 秒 · 已分析 ${throughSeconds.toFixed(1)} 秒 · ${liveNotes.length} 个起音`;
          const receipt=message.clientTiming?.audioAtReceiptSeconds,rtt=message.clientTiming?.rttMs;
          $('practice-latency').textContent=`音频分析滞后：${Number.isFinite(receipt)?Math.round(Math.max(0,receipt-throughSeconds)*1000)+' ms':'待测'} · 本窗推理：${message.inferenceMs} ms · 同连接往返：${Number.isFinite(rtt)?Math.round(rtt)+' ms':'待测'}（包含服务端积压）`;
          latencyLines.push(`${new Date(message.clientTiming.receivedAtUnixMs).toLocaleTimeString()} 窗 ${message.windowId} | 已发送 ${message.clientTiming.sentPackets} 包 | 分析落后 ${Math.round(message.clientTiming.analysisLagMs??0)}ms | 推理 ${message.inferenceMs}ms | 推理排队/调度 ${message.serverTiming?.executorWaitAndOverheadMs??'—'}ms | 发包缓冲 ${message.clientTiming.browserBufferedBytes}B | 计算/音频 ${message.serverTiming?.computeToAudioRatio??'—'}`);
          if(latencyLines.length>20)latencyLines.shift();$('practice-latency-log').textContent=latencyLines.join('\n');
          flashNotes(message.events);
          if(isFollow()){
            if(usingPiano&&pianoPhase==='listening'&&throughSeconds>=(sampler.events.at(-1)?.onsetSeconds??Infinity)+.12)setPianoPhase('ready');
            const before=follower.trace.length;
            follower.push(message.events,throughSeconds);showFollower();
            recordFollowDecisionTiming(source.statistics,follower.trace.slice(before),message);followReport(false);
          }else{
            updateCursor(startTime(liveConfig)+Math.max(0,throughSeconds-liveConfig.offsetSeconds)*liveConfig.speed);
            void compare(false,liveConfig).catch((error)=>notify(error.message,true));
          }
          if(automaticRunning())updateAutomaticControls();
        }
        if(message.type==='complete'){
          finalizing=true;
          const completedSource=source;
          const completedRecordingId=message.recordingId;
          const completedAutoTest=autoTest?.id===source.metadata.autoTest?.id?autoTest:null;
          source.metadata.audioSeconds=message.audioSeconds;
          if(usingPiano)source.metadata.triggeredNotes=sampler.events.filter((note)=>note.onsetSeconds<message.audioSeconds);
          savedRecordingId=message.recordingId;source.metadata.recordingId=savedRecordingId;
          $('practice-review-recording').hidden=!savedRecordingId;
          $('practice-status').textContent=`已处理完成：${message.audioSeconds.toFixed(1)} 秒，识别 ${message.noteCount} 个起音。`;
          // Wait for any incremental comparison before the final complete-clip comparison.
          const finish=async()=>{
            while(comparing)await new Promise((resolve)=>setTimeout(resolve,50));
            if(isFollow()){follower.push([],throughSeconds,true);showFollower();followReport(true);$('practice-recompare').disabled=false;}
            else await compare(true,liveConfig);
            if(usingPiano){
              const expected=completedSource.metadata.triggeredNotes;
              const metrics=await api('/recognition/compare',{method:'POST',body:JSON.stringify({expected,observed:completedSource.notes})});
              completedSource.metadata.simulatedRecognitionMetrics=metrics;
              if(completedAutoTest)finishAutomaticResult(completedAutoTest,metrics,message.audioSeconds);
              if(source===completedSource){
                $('simulator-evaluation').hidden=false;
                $('simulator-evaluation').textContent=`对实际触发音：F1 ${percent(metrics.f1)} · 正确匹配 ${metrics.tp} · 误报 ${metrics.fp} · 漏音 ${metrics.fn}（模拟音频）`;
                if(isFollow())followReport(true);
              }
              if(completedRecordingId&&expected.length)await api(`/recordings/${completedRecordingId}/labels`,{method:'PUT',body:JSON.stringify({notes:expected,reviewed:true,split:'unassigned',group:`virtual-${completedRecordingId}`})});
            }
            await refresh();
          };
          finishTask=finish().catch((error)=>{
            if(completedAutoTest){completedAutoTest.error=error.message;finishAutomaticResult(completedAutoTest,null,message.audioSeconds);}
            notify(error.message,true);
          }).finally(()=>setBusy(false));
        }
      },
      afterSave:async()=>{await finishTask;await waitForReportWrites();},
      onEnd:()=>{
        if(!finalizing){
          if(automaticRunning()){
            autoTest.error||=$('practice-status').textContent||'连接提前中断';autoTest.player?.stop();
            finishAutomaticResult(autoTest,null,throughSeconds,false);
          }
          if(source?.metadata.kind==='microphone'&&isFollow()){followReport(false);void persistPracticeReport(lastReport);}
          setBusy(false);
        }
        $('practice-mic-stop').disabled=true;$('piano-stop').disabled=true;heldKeys.clear();paintHeld();
      },
    });
  }catch(error){if($('practice-input').value==='piano')setPianoPhase('error');setBusy(false);notify(error.message,true);}
};
$('practice-mic-stop').onclick=async()=>{
  if(automaticRunning()){autoTest.status='processing';stopAutomaticPlayer();}
  $('practice-mic-stop').disabled=true;$('piano-stop').disabled=true;if($('practice-input').value==='piano')setPianoPhase('stopping');$('practice-status').textContent='正在处理尾音与完整片段…';await stopLive();
};
window.addEventListener('pianoval:prepare-logout',()=>{
  if(automaticRunning()){autoTest.status='processing';stopAutomaticPlayer();}
  stopReference();$('practice-accompaniment').pause();
});
$('practice-recompare').onclick=()=>compare(true).catch((error)=>notify(error.message,true));
$('practice-report-download').onclick=()=>{
  if(!lastReport)return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(lastReport,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=`pianoval-practice-${Date.now()}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
window.addEventListener('pianoval:state',({detail})=>{
  updateChoices(detail);
  if(!pendingJob)return;
  const job=detail.jobs.find((item)=>item.id===pendingJob.id);if(!job)return;
  if(job.status==='completed'){
    const completed=pendingJob;pendingJob=null;$('practice-analyze').disabled=recording;
    source={jobId:job.id,modelId:job.modelId,metadata:{kind:'uploaded-recording',recordId:completed.recordId,jobId:job.id}};
    $('practice-status').textContent=`识别完成：${job.noteCount} 个起音。正在与所选片段对照。`;
    void compare(true,completed.settings).catch((error)=>notify(error.message,true));
  }else if(['failed','cancelled','interrupted'].includes(job.status)){
    $('practice-status').textContent=job.error||'任务未完成';pendingJob=null;$('practice-analyze').disabled=recording;
  }else $('practice-status').textContent=`模型正在分析录音：${Math.round(job.progress*100)}%`;
});
async function initialize(){
  if(initialized)return;initialized=true;keyboard();
  try{updateChoices(await api('/state'));catalog=(await api('/practice/catalog')).pieces;$('practice-library-info').textContent=`已缓存 ${catalog.length} 首曲目、${catalog.reduce((sum,piece)=>sum+piece.versions.length,0)} 个版本`;$('practice-piece').replaceChildren(...catalog.map(piece=>new Option(piece.title,piece.id)));versionChoices();await loadScore();applyInput();await refreshTestHistory();}catch(error){initialized=false;notify(error.message,true);}
}
window.addEventListener('pianoval:view',({detail})=>{
  if(detail==='practice'&&!recording&&$('practice-input').value!=='microphone'){$('practice-input').value='microphone';$('practice-mode').value='follow';applyMode();applyInput();}
  if(detail==='piano'&&!recording){$('practice-input').value='piano';$('practice-mode').value='follow';applyMode();applyInput();}
  if(detail==='practice'||detail==='piano')void initialize();
});
if(location.hash==='#piano'){$('practice-input').value='piano';$('practice-mode').value='follow';}
if(!$('view-practice').hidden)void initialize();
