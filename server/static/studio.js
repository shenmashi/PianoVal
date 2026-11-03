const $ = (id) => document.getElementById(id);
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const percent = (value) => `${(value * 100).toFixed(1)}%`;
const duration = (seconds) => `${Math.floor(Math.round(seconds) / 60)}:${String(Math.round(seconds) % 60).padStart(2, '0')}`;
const splitName = (split) => ({train:'训练集', validation:'验证集', unassigned:'未分配'}[split]);
const statusName = (status) => ({queued:'排队中', running:'进行中', completed:'已完成', failed:'失败', cancelled:'已停止', interrupted:'服务曾中断'}[status] || status);
const phaseName = (phase) => ({starting:'加载预训练权重', baseline:'评测基础模型', preparing:'准备训练窗口', training:'微调起音识别阶段', validation:'评测候选模型', complete:'微调与验证完成'}[phase] || '准备任务');
let state = {records: [], jobs: []};
let selected = null;
let selectedTraining = null;
let prediction = [];
let activeInference = null;
let audioURL = null;
let refreshBusy = false;
let noticeTimer;
let dirty = false;
const sidebarToggle=document.createElement('button');
sidebarToggle.className='text-button sidebar-toggle';sidebarToggle.type='button';
sidebarToggle.textContent='☰';sidebarToggle.setAttribute('aria-label','收起菜单');sidebarToggle.setAttribute('aria-expanded','true');
document.querySelector('.topbar>span').prepend(sidebarToggle);
function collapseSidebar(collapsed){
  document.body.classList.toggle('sidebar-collapsed',collapsed);
  sidebarToggle.setAttribute('aria-expanded',String(!collapsed));
  sidebarToggle.setAttribute('aria-label',collapsed?'展开菜单':'收起菜单');
}
sidebarToggle.onclick=()=>collapseSidebar(!document.body.classList.contains('sidebar-collapsed'));
window.addEventListener('pianoval:listening-start',()=>collapseSidebar(true));
window.addEventListener('pianoval:listening-end',()=>collapseSidebar(false));

function notify(message, error = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 14000 : 6500);
}

async function api(path, options = {}) {
  const headers = {'X-Pianoval-Token': $('token').value.trim(), ...options.headers};
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(appPath(`/api/studio${path}`), {...options, headers});
  if (!response.ok) {
    if(response.status===401)window.dispatchEvent(new Event('pianoval:login-required'));
    let message = `请求失败 (${response.status})`;
    try {
      const body = await response.json();
      message = Array.isArray(body.detail) ? body.detail.map((detail) => `${detail.loc?.slice(-1)[0] || ''}: ${detail.msg}`).join('；') : body.detail || message;
    } catch { /* Keep the HTTP error when no JSON is available. */ }
    throw new Error(message);
  }
  return options.blob ? response.blob() : response.json();
}

function action(id, handler) {
  $(id).addEventListener('click', async () => {
    const button = $(id);
    button.disabled = true;
    try { await handler(); } catch (error) { notify(error.message, true); }
    finally { button.disabled = false; }
  });
}

function showView(view) {
  const actualView = view === 'piano' ? 'practice' : view;
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${actualView}`;
  for (const nav of document.querySelectorAll('[data-view]')) nav.classList.toggle('active', nav.dataset.view === view);
  $('breadcrumb').textContent = {recordings:'录音与标注', training:'模型训练', live:'实时识别', practice:'曲谱实测', guide:'使用说明', piano:'虚拟钢琴测试'}[view];
  history.replaceState(null, '', appPath('/')+(view === 'recordings' ? '' : `#${view}`));
  window.dispatchEvent(new CustomEvent('pianoval:view', {detail:view}));
  requestAnimationFrame(() => { drawRoll(); drawLoss(); });
}
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => showView(button.dataset.view);
for (const id of ['upload-main', 'upload-secondary', 'upload-empty']) $(id).onclick = () => $('audio-upload').click();

function parseEditor() {
  return $('label-editor').value.split(/\r?\n/).map((line, index) => {
    if (!line.trim()) return null;
    const parts = line.trim().split(/[,，\s]+/);
    if (parts.length < 2 || parts.length > 3) throw new Error(`第 ${index + 1} 行应为：秒数, MIDI, 力度`);
    const onsetSeconds = Number(parts[0]);
    const midi = Number(parts[1]);
    const velocity = parts.length === 3 ? Number(parts[2]) : 80;
    if (!Number.isFinite(onsetSeconds) || onsetSeconds < 0 || onsetSeconds >= selected.duration || !Number.isInteger(midi) || midi < 21 || midi > 108 || !Number.isInteger(velocity) || velocity < 1 || velocity > 127) {
      throw new Error(`第 ${index + 1} 行无效：时间须在录音内，MIDI 为 21～108，力度为 1～127`);
    }
    return {onsetSeconds, midi, velocity};
  }).filter(Boolean);
}
function notesToText(notes) {
  return notes.map((note) => `${note.onsetSeconds.toFixed(3)}, ${note.midi}, ${note.velocity ?? 80}`).join('\n');
}

function fillEditor(record) {
  selected = record;
  dirty = false;
  $('editor-empty').hidden = true;
  $('editor').hidden = false;
  $('record-title').textContent = record.title;
  $('record-meta').textContent = `${duration(record.duration)} · 16 kHz 单声道 · 标注版本 ${record.revision}${record.provenance.startsWith('synthetic') ? ' · 模拟 / 合成音，非学生实弹' : ''}`;
  $('label-badge').textContent = record.reviewed ? '标注已核验' : record.hasLabels ? '待人工核验' : '尚无标注';
  $('label-badge').classList.toggle('ready', record.reviewed);
  $('label-editor').value = notesToText(record.notes);
  $('record-split').value = record.split;
  $('record-group').value = record.group;
  $('record-reviewed').checked = record.reviewed;
  $('label-status').textContent = record.reviewed ? '已保存，可按所选用途加入数据集' : '未确认的标注不会用于训练';
  drawRoll();
}

async function selectRecord(identifier) {
  if (selected?.id === identifier) return;
  if (dirty && !window.confirm('这段录音的标注尚未保存，确定切换吗？')) return;
  const record = await api(`/recordings/${identifier}`);
  prediction = [];
  activeInference = null;
  $('inference-status').textContent = '';
  $('inference-metrics').hidden = true;
  $('prediction-draft').disabled = true;
  fillEditor(record);
  renderLibrary();
  const blob = await api(`/recordings/${identifier}/audio`, {blob: true});
  if (selected?.id !== identifier) return;
  if (audioURL) URL.revokeObjectURL(audioURL);
  audioURL = URL.createObjectURL(blob);
  $('audio-player').src = audioURL;
}

function renderLibrary() {
  const records = [...state.records].sort((a, b) => b.createdAt - a.createdAt);
  $('record-count').textContent = records.length;
  $('record-list').replaceChildren();
  if (!records.length) {
    const empty = document.createElement('p'); empty.className = 'muted padded'; empty.textContent = '暂无录音。上传学生实弹录音，或载入演示数据体验完整流程。'; $('record-list').append(empty);
  }
  for (const record of records) {
    const button = document.createElement('button');
    button.className = `record-item${selected?.id === record.id ? ' selected' : ''}`;
    button.innerHTML = `<strong>${escapeHTML(record.title)}</strong><span class="record-item-meta"><span>${duration(record.duration)} · ${record.reviewed ? `${record.notes?.length ?? record.noteCount ?? 0} 个标注` : '待核验'}</span><span class="mini-tag">${splitName(record.split)}</span></span>`;
    button.onclick = () => selectRecord(record.id).catch((error) => notify(error.message, true));
    $('record-list').append(button);
  }
  $('stat-records').textContent = records.length;
  $('stat-duration').textContent = `共 ${duration(records.reduce((sum, record) => sum + record.duration, 0))} 分钟:秒`;
  $('stat-notes').textContent = records.filter((record) => record.reviewed).reduce((sum, record) => sum + (record.noteCount ?? 0), 0).toLocaleString();
  const train = records.filter((record) => record.split === 'train' && record.reviewed);
  const validation = records.filter((record) => record.split === 'validation' && record.reviewed);
  $('stat-split').textContent = `${train.length} / ${validation.length}`;
  $('training-summary').textContent = `训练集 ${train.length} 条 · ${duration(train.reduce((sum, record) => sum + record.duration, 0))}\n验证集 ${validation.length} 条 · ${duration(validation.reduce((sum, record) => sum + record.duration, 0))}`;
  $('training-summary').style.whiteSpace = 'pre-line';
  const hasDemo = records.some((record) => record.provenance.startsWith('synthetic'));
  $('demo-exclude').hidden = !hasDemo;
  $('demo-install').textContent = hasDemo ? '演示合成音仅用于检查训练流程' : '没有素材？载入带标注演示数据 ↗';
}

function renderModels() {
  const value = $('inference-model').value;
  $('inference-model').replaceChildren(new Option('基础预训练模型', 'base'), new Option('当前启用模型', 'active'));
  for (const job of state.jobs.filter((job) => job.kind === 'training' && job.status === 'completed')) {
    $('inference-model').add(new Option(`候选 ${job.id.slice(0, 6)}${job.result.demonstration ? ' · 演示' : ''}`, job.id));
  }
  if ([...$('inference-model').options].some((option) => option.value === value)) $('inference-model').value = value;
}

function trainingJob() { return state.jobs.find((job) => job.id === selectedTraining); }
function renderTraining() {
  const jobs = state.jobs.filter((job) => job.kind === 'training');
  if (!selectedTraining && jobs.length) selectedTraining = jobs[0].id;
  const job = trainingJob();
  $('training-empty').hidden = Boolean(job);
  $('training-detail').hidden = !job;
  $('train-start').disabled = jobs.some((job) => ['queued', 'running'].includes(job.status));
  $('job-history').replaceChildren();
  for (const item of jobs) {
    const row = document.createElement('div'); row.className = `history-item${item.id === selectedTraining ? ' selected' : ''}`;
    row.innerHTML = `<div><strong>${escapeHTML(new Date(item.createdAt * 1000).toLocaleString())} · ${item.parameters.steps} 步</strong><small>${item.id.slice(0, 8)} · ${statusName(item.status)}${item.result?.demonstration ? ' · 演示合成数据' : ''}</small></div>`;
    const button = document.createElement('button'); button.className = 'text-button'; button.textContent = '查看';
    button.onclick = () => { selectedTraining = item.id; renderTraining(); };
    row.append(button); $('job-history').append(row);
  }
  if (!jobs.length) { const p = document.createElement('p'); p.className = 'muted padded'; p.textContent = '预训练基础模型已保留，尚无微调记录。'; $('job-history').append(p); }
  if (!job) return;
  $('training-state').textContent = statusName(job.status);
  $('training-state').classList.toggle('ready', job.status === 'completed');
  $('training-phase').textContent = job.error || phaseName(job.phase);
  $('training-progress').style.width = `${(job.progress || 0) * 100}%`;
  const report = job.report || {};
  $('training-progress-text').textContent = `${report.step || 0} / ${job.parameters.steps} 步${report.elapsedSeconds ? ` · 已用 ${report.elapsedSeconds.toFixed(1)} 秒` : ''} · 任务 ${job.id.slice(0, 8)}`;
  $('train-cancel').hidden = !['queued', 'running'].includes(job.status);
  $('activate-model').hidden = !job.result?.eligible;
  $('comparison').replaceChildren();
  if (job.result) {
    const result = job.result;
    const table = document.createElement('table'); table.className = 'comparison-table';
    table.innerHTML = '<thead><tr><th>独立验证 · 同音高 ±50ms</th><th>基础模型</th><th>候选模型</th></tr></thead>';
    const body = table.createTBody();
    for (const [label, key, format] of [['音符 F1', 'f1', percent], ['精确率', 'precision', percent], ['召回率', 'recall', percent], ['误报音符', 'fp', String], ['漏掉音符', 'fn', String]]) {
      const row = body.insertRow();
      for (const value of [label, format(result.baseline[key]), format(result.candidate[key])]) row.insertCell().textContent = value;
    }
    $('comparison').append(table);
    const prefix = result.demonstration ? '演示合成数据：仅确认真实训练流程，不能据此判断真琴准确率，不开放启用。' : result.eligible ? '验证 F1 提高且精确率未下降，可手动启用；仍需更多真实录音验证。' : '此次验证未满足启用条件，继续保留当前模型。候选模型可在录音页单独对比。';
    $('training-verdict').textContent = `${prefix} 验证样本 ${result.validationRecordings} 条，共 ${duration(result.validationSeconds)}。`;
  } else {
    $('training-verdict').textContent = job.status === 'failed' ? '任务失败，没有替换正在使用的模型。' : '训练结束后使用独立验证录音比较；训练损失不等同于准确率。';
  }
  drawLoss();
}

async function refresh() {
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    state = await api('/state');
    const ready = Boolean(state.model);
    $('model-badge').textContent = ready ? `${state.model.version === 'base' ? '基础预训练' : `候选 ${state.model.version.slice(0, 6)}`} · 已就绪` : '模型未就绪';
    $('model-badge').classList.toggle('ready', ready);
    $('sidebar-dot').classList.toggle('ready', ready);
    $('sidebar-status').textContent = ready ? '识别服务在线' : '模型需要检查';
    renderLibrary(); renderModels(); renderTraining();
    window.dispatchEvent(new CustomEvent('pianoval:state', {detail:state}));
    if (activeInference && selected) {
      const job = state.jobs.find((item) => item.id === activeInference);
      if (job?.status === 'completed') {
        const identifier = selected.id;
        const result = await api(`/jobs/${job.id}/result`);
        if (selected?.id === identifier && activeInference === job.id) {
          prediction = result.events;
          $('inference-status').textContent = `已识别 ${prediction.length} 个起音事件`;
          $('prediction-draft').disabled = !prediction.length;
          $('inference-metrics').hidden = !result.metrics;
          if (result.metrics) $('inference-metrics').textContent = `对当前已核验标注：F1 ${percent(result.metrics.f1)} · 精确率 ${percent(result.metrics.precision)} · 召回率 ${percent(result.metrics.recall)} · 误报 ${result.metrics.fp} · 漏音 ${result.metrics.fn}`;
          drawRoll(); activeInference = null;
        }
      } else if (job && ['failed', 'cancelled', 'interrupted'].includes(job.status)) {
        $('inference-status').textContent = job.error || statusName(job.status); activeInference = null;
      } else if (job) $('inference-status').textContent = `正在分析 ${Math.round(job.progress * 100)}%`;
    }
  } catch (error) {
    $('sidebar-status').textContent = '工作台连接失败'; $('sidebar-dot').classList.remove('ready');
    if (!state.records.length) notify(error.message, true);
  } finally { refreshBusy = false; }
}

function canvasContext(id) {
  const canvas = $(id); const box = canvas.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = box.width * ratio; canvas.height = box.height * ratio;
  const context = canvas.getContext('2d'); context.scale(ratio, ratio);
  return {context, width:box.width, height:box.height};
}
function drawRoll() {
  if (!selected) return;
  const drawing = canvasContext('piano-roll'); if (!drawing) return;
  const {context:c, width:w, height:h} = drawing;
  let labels = []; try { labels = parseEditor(); } catch { /* Keep preview responsive during partial edits. */ }
  const all = [...prediction, ...labels];
  const low = Math.min(48, ...all.map((note) => note.midi)) - 2;
  const high = Math.max(84, ...all.map((note) => note.midi)) + 2;
  const x = (time) => 35 + time / selected.duration * (w - 48);
  const y = (pitch) => 10 + (high - pitch) / (high - low) * (h - 37);
  c.font = '9px system-ui';
  for (let pitch = Math.ceil(low / 12) * 12; pitch <= high; pitch += 12) {
    c.strokeStyle = '#e9eeee'; c.beginPath(); c.moveTo(32, y(pitch)); c.lineTo(w, y(pitch)); c.stroke();
    c.fillStyle = '#98a9ad'; c.fillText(`C${pitch / 12 - 1}`, 5, y(pitch) + 3);
  }
  for (let i = 0; i <= 5; i++) {
    const time = selected.duration * i / 5; c.fillStyle = '#98a9ad'; c.fillText(`${time.toFixed(1)}s`, Math.min(w - 30, x(time)), h - 6);
    c.strokeStyle = '#edf1f1'; c.beginPath(); c.moveTo(x(time), 5); c.lineTo(x(time), h - 23); c.stroke();
  }
  for (const [events, color, offset] of [[labels, '#c49848', 3], [prediction, '#278d7d', -2]]) {
    c.fillStyle = color;
    for (const note of events) c.fillRect(x(note.onsetSeconds), y(note.midi) + offset, Math.max(3, Math.min(14, (w - 48) / selected.duration * 0.15)), 3);
  }
  $('roll-count').textContent = `识别 ${prediction.length} · 标注 ${labels.length}`;
}
function drawLoss() {
  const job = trainingJob(); if (!job) return;
  const drawing = canvasContext('loss-chart'); if (!drawing) return;
  const {context:c, width:w, height:h} = drawing;
  const values = job.result?.history || job.report?.history || [];
  c.font = '10px system-ui'; c.fillStyle = '#98a9ad';
  if (!values.length) { c.fillText('实际训练开始后显示损失曲线', 12, h / 2); return; }
  const max = Math.max(...values.map((item) => item.loss), 0.0001) * 1.1;
  const x = (index) => 45 + index / Math.max(1, values.length - 1) * (w - 65);
  const y = (loss) => h - 25 - loss / max * (h - 40);
  for (let i = 0; i <= 3; i++) {
    const loss = max * i / 3; c.strokeStyle = '#eaf0ef'; c.beginPath(); c.moveTo(42, y(loss)); c.lineTo(w - 10, y(loss)); c.stroke();
    c.fillStyle = '#98a9ad'; c.fillText(loss.toFixed(3), 0, y(loss) + 3);
  }
  c.beginPath(); values.forEach((item, index) => { if (!index) c.moveTo(x(index), y(item.loss)); else c.lineTo(x(index), y(item.loss)); });
  c.strokeStyle = '#187b70'; c.lineWidth = 2; c.stroke();
  c.fillText('step 1', 43, h - 5); c.fillText(`step ${values.at(-1).step} · loss ${values.at(-1).loss.toFixed(4)}`, Math.max(43, w - 175), h - 5);
}

$('audio-upload').onchange = async () => {
  const files = [...$('audio-upload').files]; if (!files.length) return;
  $('upload-progress').hidden = false;
  try {
    for (const [index, file] of files.entries()) {
      $('upload-progress').textContent = `上传 ${index + 1}/${files.length}：${file.name}`;
      const form = new FormData(); form.append('audio', file);
      const record = await api('/recordings', {method:'POST', body:form});
      await refresh(); await selectRecord(record.id);
    }
    notify('录音上传完成。可以先识别，也可以导入同步 MIDI 标注。');
  } catch (error) { notify(error.message, true); }
  finally { $('audio-upload').value = ''; $('upload-progress').hidden = true; }
};
for (const id of ['label-editor', 'record-split', 'record-group', 'record-reviewed']) $(id).addEventListener('input', () => {
  if (id === 'label-editor') $('record-reviewed').checked = false;
  dirty = true; $('label-status').textContent = '有未保存的修改'; drawRoll();
});
action('save-labels', async () => {
  if (!selected) return;
  const record = await api(`/recordings/${selected.id}/labels`, {method:'PUT', body:JSON.stringify({
    notes:parseEditor(), reviewed:$('record-reviewed').checked, split:$('record-split').value, group:$('record-group').value.trim(),
  })});
  fillEditor(record); await refresh(); notify('标注与数据集用途已保存。');
});
action('transcribe', async () => {
  if (!selected) return;
  const job = await api(`/recordings/${selected.id}/transcribe`, {method:'POST', body:JSON.stringify({modelId:$('inference-model').value})});
  activeInference = job.id; $('inference-status').textContent = '识别任务已创建…'; await refresh();
});
action('import-midi', async () => {
  if (!selected || !$('midi-upload').files.length) throw new Error('请先选择录音和对应的 MIDI 文件');
  const form = new FormData(); form.append('midi', $('midi-upload').files[0]); form.append('offset', $('midi-offset').value);
  const record = await api(`/recordings/${selected.id}/midi`, {method:'POST', body:form});
  fillEditor(record); await refresh(); notify('已导入起音标注，请听音频检查时间偏移和学生实际弹奏，再勾选确认。');
});
$('prediction-draft').onclick = () => {
  $('label-editor').value = notesToText(prediction); $('record-reviewed').checked = false; dirty = true;
  $('label-status').textContent = '预测仅作草稿，需逐条核验后保存'; drawRoll();
  notify('已填入识别草稿。模型预测可能有错音或漏音，不能直接作为训练答案。');
};
$('json-import-button').onclick = () => $('json-import').click();
$('json-import').onchange = async () => {
  try {
    if (!selected || !$('json-import').files.length) return;
    const data = JSON.parse(await $('json-import').files[0].text());
    const notes = Array.isArray(data) ? data : data.notes;
    if (!Array.isArray(notes) || notes.length > 50000) throw new Error('JSON 需包含 notes 数组，最多 50000 个音符');
    for (const note of notes) if (!Number.isFinite(note.onsetSeconds) || !Number.isInteger(note.midi)) throw new Error('音符需包含 onsetSeconds 和整数 midi');
    $('label-editor').value = notesToText(notes); parseEditor(); $('record-reviewed').checked = false; dirty = true; drawRoll();
    notify('JSON 已导入编辑器，核验后请保存。');
  } catch (error) { notify(error.message, true); }
  finally { $('json-import').value = ''; }
};
action('export-labels', async () => {
  if (!selected) return;
  const blob = new Blob([JSON.stringify({notes:parseEditor()}, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${selected.title.replace(/\.[^.]+$/, '')}-notes.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
action('demo-install', async () => {
  const records = await api('/demo', {method:'POST'}); await refresh();
  if (records.length) await selectRecord(records[0].id);
  notify('已载入可运行的合成音演示集。它仅验证训练流程，不证明真实钢琴准确率。');
});
action('demo-exclude', async () => {
  await api('/demo/exclude', {method:'POST'}); await refresh();
  if (selected?.provenance.startsWith('synthetic')) fillEditor(await api(`/recordings/${selected.id}`));
  notify('演示录音已移出训练 / 验证集合，可以加入真实录音。');
});
action('train-start', async () => {
  const job = await api('/training', {method:'POST', body:JSON.stringify({steps:Number($('train-steps').value), learningRate:Number($('train-lr').value), seed:Number($('train-seed').value)})});
  selectedTraining = job.id; await refresh(); notify('真实微调任务已启动，进度与验证结果将在此更新。');
});
action('train-cancel', async () => { if (selectedTraining) { await api(`/jobs/${selectedTraining}/cancel`, {method:'POST'}); await refresh(); } });
action('activate-model', async () => { await api(`/models/${selectedTraining}/activate`, {method:'POST'}); await refresh(); notify('候选模型已启用，之后的新录音会使用此版本。'); });
action('reset-model', async () => { await api('/models/base/activate', {method:'POST'}); await refresh(); notify('已切回基础预训练模型。'); });
action('refresh-auth', async () => { await refresh(); notify('已更新工作台连接。'); });
window.addEventListener('resize', () => { drawRoll(); drawLoss(); });
window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
await refresh();
window.dispatchEvent(new CustomEvent('pianoval:state', {detail:state}));
if (['training', 'live', 'practice', 'guide', 'piano'].includes(location.hash.slice(1))) showView(location.hash.slice(1));
setInterval(refresh, 2000);
export {api, notify, refresh, showView, selectRecord};
import {appPath} from './paths.js';
