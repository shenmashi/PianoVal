import { detectPitch } from './pitch'
import type { Pitch } from './pitch'

export class MicrophoneSession {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private frame = 0
  private stopped = false
  private chunks: BlobPart[] = []
  private recordingResult: Promise<Blob> | null = null

  async start(onPitch: (pitch: Pitch | null, elapsed: number) => void, onEnded: () => void) {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('麦克风需要安全连接。电脑可用 localhost；Pad 请通过可信任的 HTTPS 地址访问。')
    }
    if (typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持录音，请使用较新的 Safari 或 Chrome。')
    this.context = new AudioContext()
    await this.context.resume()
    if (this.stopped) return
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false })
    if (this.stopped) { stream.getTracks().forEach(track => track.stop()); return }
    this.stream = stream
    const source = this.context.createMediaStreamSource(stream)
    const analyser = this.context.createAnalyser()
    analyser.fftSize = 2048
    source.connect(analyser)
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type))
    this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    this.recordingResult = new Promise((resolve, reject) => {
      this.recorder!.ondataavailable = event => { if (event.data.size) this.chunks.push(event.data) }
      this.recorder!.onstop = () => resolve(new Blob(this.chunks, { type: this.recorder!.mimeType || 'audio/mp4' }))
      this.recorder!.onerror = () => { reject(new Error('浏览器录音中断，请重新尝试。')); onEnded() }
    })
    // Install a rejection handler immediately; stopping will still receive the error.
    void this.recordingResult.catch(() => {})
    this.recorder.start(1000)
    stream.getAudioTracks()[0]!.onended = onEnded
    const started = this.context.currentTime
    const samples = new Float32Array(analyser.fftSize)
    let lastSample = -1
    const tick = () => {
      if (this.stopped || !this.context) return
      const elapsed = this.context.currentTime - started
      if (elapsed - lastSample >= 0.035) {
        analyser.getFloatTimeDomainData(samples)
        onPitch(detectPitch(samples, this.context.sampleRate), elapsed)
        lastSample = elapsed
      }
      this.frame = requestAnimationFrame(tick)
    }
    tick()
  }

  async stop(): Promise<Blob | null> {
    this.stopped = true
    cancelAnimationFrame(this.frame)
    if (this.recorder?.state === 'recording') this.recorder.stop()
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop() })
    if (this.context && this.context.state !== 'closed') await this.context.close()
    return this.recordingResult
  }
}
