<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import ScoreStaff from './components/ScoreStaff.vue'
import { alignNotes, midiToName, parseMusicXml, parseNotes } from './music/notes'
import type { PlayedNote, ScoreNote } from './music/notes'
import { MicrophoneSession } from './audio/recorder'
import { NoteTracker } from './audio/events'
import type { Pitch } from './audio/pitch'
import { analyseAudio, createDemo, encodeWav, playReference } from './audio/demo'

type State = 'idle' | 'preparing' | 'recording' | 'analysing' | 'playing' | 'complete'
const presets = [
  { id: 'scale', title: 'C 大调音阶', subtitle: '基础音阶 · 8 个音符', notes: 'C4 D4 E4 F4 G4 A4 B4 C5' },
  { id: 'joy', title: '欢乐颂 · 旋律练习', subtitle: '单音旋律 · 15 个音符', notes: 'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4 D4 D4' },
]
const selected = ref('scale'), title = ref(presets[0]!.title), score = ref<ScoreNote[]>(parseNotes(presets[0]!.notes))
const state = ref<State>('idle'), error = ref(''), pitch = ref<Pitch | null>(null), elapsed = ref(0), bpm = ref(80)
const played = ref<PlayedNote[]>([]), audioUrl = ref(''), audioType = ref(''), resultSource = ref<'microphone' | 'example'>('microphone')
const progress = ref(0), showEditor = ref(false), customNotes = ref(presets[0]!.notes)
const xmlInput = ref<HTMLInputElement | null>(null), player = ref<HTMLAudioElement | null>(null)
let session: MicrophoneSession | null = null, tracker = new NoteTracker(), permissionTimer: ReturnType<typeof setTimeout> | null = null
const comparisons = computed(() => state.value === 'complete' ? alignNotes(score.value, played.value) : [])
const correct = computed(() => comparisons.value.filter(row => row.status === 'correct').length)
const issues = computed(() => comparisons.value.filter(row => row.status !== 'correct'))
const accuracy = computed(() => Math.round(correct.value / Math.max(1, score.value.length + comparisons.value.filter(row => row.status === 'extra').length) * 100))
const busy = computed(() => ['preparing', 'recording', 'analysing', 'playing'].includes(state.value))
const clock = computed(() => `${String(Math.floor(elapsed.value / 60)).padStart(2, '0')}:${String(Math.floor(elapsed.value % 60)).padStart(2, '0')}`)
const statusLabel = computed(() => ({ idle: '准备好，就开始弹奏', preparing: '请允许使用麦克风', recording: '正在聆听你的弹奏', analysing: '正在对照参考乐谱', playing: '正在播放参考旋律', complete: '这一次练习，完成了' })[state.value])
const rms = computed(() => Math.min(100, (pitch.value?.rms || 0) * 500))
const keyboard = Array.from({ length: 13 }, (_, i) => 60 + i)
const issueNames = { wrong: '错音', missed: '漏音', extra: '多弹', correct: '正确' }

function clearResult() {
  player.value?.pause()
  if (audioUrl.value) URL.revokeObjectURL(audioUrl.value)
  audioUrl.value = ''; audioType.value = ''; played.value = []; pitch.value = null; elapsed.value = 0; state.value = 'idle'; error.value = ''
}
function choosePreset() {
  const preset = presets.find(item => item.id === selected.value)
  if (!preset) return
  clearResult(); title.value = preset.title; score.value = parseNotes(preset.notes); customNotes.value = preset.notes
}
function applyCustom() {
  try {
    const notes = parseNotes(customNotes.value)
    clearResult(); score.value = notes; title.value = '我的旋律练习'; selected.value = 'custom'; showEditor.value = false
  } catch (cause) { error.value = (cause as Error).message }
}
async function importScore(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  if (!file) return
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('请选择小于 2MB 的未压缩 MusicXML 文件。')
    const notes = parseMusicXml(await file.text())
    clearResult(); score.value = notes; title.value = file.name.replace(/\.(musicxml|xml)$/i, ''); selected.value = 'custom'
    customNotes.value = notes.map(note => midiToName(note.midi)).join(' ')
  } catch (cause) { error.value = (cause as Error).message }
  input.value = ''
}
function setAudio(blob: Blob) {
  if (audioUrl.value) URL.revokeObjectURL(audioUrl.value)
  audioUrl.value = URL.createObjectURL(blob); audioType.value = blob.type
}
async function stopRecording(message = '') {
  const current = session
  if (!current) return
  session = null
  if (permissionTimer) clearTimeout(permissionTimer)
  const hadStarted = state.value === 'recording'
  state.value = hadStarted ? 'analysing' : 'idle'
  try {
    const blob = await current.stop()
    if (blob?.size && hadStarted) { setAudio(blob); played.value = tracker.notes.map(note => ({ ...note })); state.value = 'complete' }
    else state.value = 'idle'
  } catch (cause) { error.value = (cause as Error).message; state.value = 'idle' }
  pitch.value = null
  if (message) error.value = message
}
async function startRecording() {
  clearResult(); resultSource.value = 'microphone'; tracker = new NoteTracker(); state.value = 'preparing'
  const current = new MicrophoneSession(); session = current
  permissionTimer = setTimeout(() => { if (session === current && state.value === 'preparing') void stopRecording('未获得麦克风授权。请检查浏览器权限后重试。') }, 15000)
  try {
    await current.start((value, time) => {
      if (session !== current) return
      pitch.value = value; elapsed.value = time
      if (tracker.push(value, time)) played.value = tracker.notes.map(note => ({ ...note }))
      if (time >= 120) void stopRecording('已达到本次 2 分钟练习上限，录音已保存。')
    }, () => { void stopRecording('麦克风连接中断，已结束本次录音。') })
    if (session !== current) return
    if (permissionTimer) clearTimeout(permissionTimer)
    state.value = 'recording'
  } catch (cause) {
    if (session !== current) return
    await stopRecording()
    const name = (cause as Error).name
    error.value = name === 'NotAllowedError' ? '麦克风权限未开启，请在浏览器的网站设置中允许录音后重试。' : name === 'NotFoundError' ? '没有找到麦克风，请检查设备连接。' : (cause as Error).message
  }
}
async function runExample() {
  clearResult(); state.value = 'analysing'; resultSource.value = 'example'; progress.value = 0
  try {
    const audio = createDemo(score.value)
    setAudio(encodeWav(audio.samples, audio.sampleRate))
    played.value = await analyseAudio(audio.samples, audio.sampleRate, value => { progress.value = value })
    elapsed.value = audio.samples.length / audio.sampleRate; state.value = 'complete'
  } catch (cause) { error.value = (cause as Error).message; state.value = 'idle' }
}
async function listen() {
  const previous = state.value
  player.value?.pause(); state.value = 'playing'; error.value = ''
  try { await playReference(score.value, bpm.value) }
  catch { error.value = '参考旋律播放失败，请再次点击试听。' }
  finally { state.value = previous }
}
function downloadRecording() {
  const extension = audioType.value.includes('wav') ? 'wav' : audioType.value.includes('webm') ? 'webm' : 'm4a'
  const link = document.createElement('a'); link.href = audioUrl.value; link.download = `PianoVal-${resultSource.value}-${Date.now()}.${extension}`; link.click()
}
function exportReport() {
  const report = { title: title.value, createdAt: new Date().toISOString(), source: resultSource.value, engine: 'YIN-monophonic-prototype', reference: score.value, played: played.value, comparison: comparisons.value, noteAccuracy: accuracy.value, rhythmEvaluated: false }
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = `PianoVal-report-${Date.now()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function onVisibility() { if (document.hidden && session) void stopRecording('页面切换到后台，本次录音已结束。') }
document.addEventListener('visibilitychange', onVisibility)
onBeforeUnmount(() => { if (permissionTimer) clearTimeout(permissionTimer); void session?.stop(); if (audioUrl.value) URL.revokeObjectURL(audioUrl.value); document.removeEventListener('visibilitychange', onVisibility) })
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <a class="brand" href="/" aria-label="PianoVal 首页"><span class="brand-mark">m<span>v</span></span><span>music<span class="brand-light">Val</span><small>每一次练习，都听得见进步</small></span></a>
      <div class="sidebar-section">我的音乐空间</div>
      <a class="nav-item active" href="#practice"><span>♬</span> 练琴工作室 <span class="nav-arrow">↗</span></a>
      <div class="practice-tip"><span class="tip-icon">✦</span><h3>慢一点，也很好。</h3><p>先把每一个音弹清楚，<br />再让旋律慢慢流动起来。</p><div class="mini-keyboard"><i v-for="key in 8" :key="key"></i></div></div>
      <div class="sidebar-bottom"><span class="local-dot"></span> 本地练习 · 音频不上传</div>
    </aside>

    <main id="practice">
      <header class="page-header"><div><div class="eyebrow">YOUR DAILY PIANO MOMENT</div><h1>练琴工作室<span>Practice studio</span></h1></div><span class="prototype-badge">单音练习 · 原型版</span></header>
      <div v-if="error" class="notice" role="alert"><span>{{ error }}</span><button type="button" aria-label="关闭提示" @click="error = ''">×</button></div>
      <section class="score-card">
        <div class="score-heading"><div class="score-name"><span class="score-cover">♫</span><div><div class="eyebrow">今日练习曲目</div><h2>{{ title }}</h2><p>高音谱号 <span>·</span> {{ score.length }} 个参考音符 <span>·</span> 单音旋律</p></div></div><div class="score-tools"><button :disabled="busy" @click="xmlInput?.click()">↥ 导入乐谱</button><button :disabled="busy" @click="showEditor = !showEditor">编辑音符</button></div></div>
        <input ref="xmlInput" type="file" accept=".musicxml,.xml" hidden @change="importScore" />
        <div class="score-controls"><label>练习曲目 <select v-model="selected" :disabled="busy" @change="choosePreset"><option v-for="preset in presets" :key="preset.id" :value="preset.id">{{ preset.title }}</option><option v-if="selected === 'custom'" value="custom">自定义旋律</option></select></label><label>试听速度 <input v-model.number="bpm" aria-label="试听速度" type="range" min="40" max="140" step="5" :disabled="busy" /><strong>{{ bpm }}</strong><span>BPM</span></label><button class="listen-button" :disabled="busy" @click="listen">{{ state === 'playing' ? '播放中…' : '▷ 试听旋律' }}</button></div>
        <div v-if="showEditor" class="note-editor"><label for="notes">输入参考音符，例如 C4 D4 E4 F#4（当前支持 C3～C6）</label><textarea id="notes" v-model="customNotes" :disabled="busy" rows="2"></textarea><button class="primary small" :disabled="busy" @click="applyCustom">应用旋律</button></div>
        <div class="score-paper"><div class="paper-heading"><span>旋律音高预览</span><span>按顺序，慢慢弹</span></div><ScoreStaff :notes="score" :comparisons="comparisons" /><div class="score-legend"><span><i class="legend-dot green"></i> 正确</span><span><i class="legend-dot orange"></i> 错音</span><span><i class="legend-dot muted"></i> 未弹 / 漏音</span><span class="legend-note">导入支持基础单音 MusicXML；此预览不还原原谱排版和节奏。</span></div></div>
      </section>

      <div class="workspace-bottom">
        <section class="record-card"><div class="section-top"><h2><span class="section-number">01</span> 开始你的演奏</h2><span class="listening-tag" :class="{ live: state === 'recording' }"><i></i>{{ state === 'recording' ? '录音中' : '麦克风待命' }}</span></div><div class="recorder-content"><div class="record-symbol" :class="{ live: state === 'recording' }">{{ state === 'recording' ? '●' : '♩' }}</div><h3>{{ statusLabel }}</h3><p>{{ state === 'complete' ? (resultSource === 'example' ? '示例音频已分析，包含一个刻意弹错的音符。' : '录音已保存在当前页面，可以回听或下载。') : '将 Pad 放在钢琴旁，按参考音符依次弹奏。' }}</p><div class="waveform" :class="{ live: state === 'recording' }"><i v-for="bar in 41" :key="bar" :style="{ height: `${8 + Math.abs(Math.sin(bar * 2.3)) * (state === 'recording' ? rms * 0.5 : 14)}px`, opacity: state === 'recording' ? '1' : '.4' }"></i></div><div class="record-clock">{{ clock }}<span> / 02:00</span></div><div class="record-actions"><button v-if="state === 'recording' || state === 'preparing'" class="primary record-stop" @click="stopRecording()">■ {{ state === 'preparing' ? '取消授权等待' : '结束并评测' }}</button><button v-else class="primary" :disabled="busy" @click="startRecording">● {{ state === 'complete' ? '再练一次' : '开始录音' }}</button><button class="example-button" :disabled="busy" @click="runExample">{{ state === 'analysing' ? `分析中 ${progress}%` : '体验示例录音' }}</button></div><p class="record-footnote">只在点击后开启麦克风 · 当前评测单音音高</p></div><div class="pitch-monitor"><div><span>当前识别音高</span><strong>{{ pitch ? midiToName(pitch.midi) : '—' }}</strong></div><div><span>频率</span><strong>{{ pitch ? `${pitch.frequency.toFixed(1)} Hz` : '等待弹奏' }}</strong></div><div><span>已识别音符</span><strong>{{ played.length }}<small> 个</small></strong></div></div><div v-if="audioUrl" class="audio-review"><audio ref="player" :src="audioUrl" controls :controlslist="busy ? 'nodownload' : undefined"></audio><button :disabled="busy" @click="downloadRecording">↓ 下载录音</button></div></section>

        <section class="feedback-card"><div class="section-top"><h2><span class="section-number">02</span> 练习反馈</h2><button v-if="state === 'complete'" class="text-button" @click="exportReport">导出报告 ↗</button></div><template v-if="state === 'complete'"><div class="result-score"><span>音符准确度</span><div>{{ accuracy }}<small>%</small></div><p>{{ correct }} / {{ score.length }} 个参考音符弹奏正确</p><span class="result-source">{{ resultSource === 'example' ? '示例音频评测' : '本次麦克风录音' }}</span></div><div class="feedback-divider"></div><div v-if="!played.length" class="empty-notes">没有识别到稳定单音。请确认麦克风正常，逐音弹奏；本原型不用于双手和弦评测。</div><div v-else-if="!issues.length" class="positive-feedback">✦ 音符顺序全部匹配！再慢慢巩固一次吧。</div><div v-else class="issue-list"><div v-for="(issue, i) in issues.slice(0, 12)" :key="i" class="issue"><span class="issue-index">{{ issue.expectedIndex !== null ? String(issue.expectedIndex + 1).padStart(2, '0') : '+' }}</span><div><strong>{{ issueNames[issue.status] }}</strong><p v-if="issue.expectedIndex !== null">应弹 {{ midiToName(score[issue.expectedIndex]!.midi) }}<template v-if="issue.actualIndex !== null">，识别到 {{ midiToName(played[issue.actualIndex]!.midi) }}</template><template v-else>，本次未匹配到</template></p><p v-else>多识别到 {{ midiToName(played[issue.actualIndex!]!.midi) }}</p></div><span class="issue-time">{{ issue.actualIndex !== null ? `${played[issue.actualIndex]!.start.toFixed(1)}s` : '—' }}</span></div></div><p class="feedback-note">本次仅对照音符顺序。节奏、力度、踏板和双手和弦尚未评分。</p></template><div v-else class="feedback-empty"><div class="empty-orbit"><span>♪</span><i>✦</i></div><h3>听见每一个小进步</h3><p>完成一段弹奏后，<br />这里会显示正确音符和需要重练的位置。</p><div class="empty-metrics"><span>音高对照</span><span>错音定位</span><span>录音回听</span></div></div></section>
      </div>

      <section class="keyboard-panel" aria-label="识别音高键盘"><div><strong>看见你的音符</strong><p>C4 — C5</p></div><div class="piano"><div v-for="midi in keyboard" :key="midi" :class="['piano-key', midiToName(midi).includes('#') ? 'black-key' : 'white-key', { pressed: pitch?.midi === midi }]"><span v-if="!midiToName(midi).includes('#')">{{ midiToName(midi) }}</span></div></div><span class="keyboard-caption">弹奏时实时点亮</span></section>
      <footer>PianoVal <span>·</span> 好好练琴，慢慢发光。<small>识别范围 C3～C6 · 双手与和弦评测在后续模型阶段接入</small></footer>
    </main>
  </div>
</template>
