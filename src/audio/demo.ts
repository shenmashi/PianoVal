import { midiToFrequency } from '../music/notes'
import type { ScoreNote, PlayedNote } from '../music/notes'
import { detectPitch } from './pitch'
import { NoteTracker } from './events'

export function createDemo(score: ScoreNote[]): { samples: Float32Array; sampleRate: number } {
  const sampleRate = 22050, noteLength = 0.65
  const samples = new Float32Array(Math.ceil((score.length * noteLength + 0.3) * sampleRate))
  score.forEach((note, index) => {
    const midi = index === Math.min(4, score.length - 1) ? note.midi + 1 : note.midi
    const frequency = midiToFrequency(midi)
    for (let n = 0; n < sampleRate * 0.43; n++) {
      const t = n / sampleRate
      const envelope = Math.min(1, t / 0.008) * Math.exp(-t * 4) * Math.min(1, (0.43 - t) / 0.035)
      const wave = Math.sin(2 * Math.PI * frequency * t) + 0.35 * Math.sin(4 * Math.PI * frequency * t) + 0.16 * Math.sin(6 * Math.PI * frequency * t)
      samples[Math.floor((index * noteLength + 0.15) * sampleRate) + n] = wave * envelope * 0.23
    }
  })
  return { samples, sampleRate }
}

export async function analyseAudio(samples: Float32Array, sampleRate: number, progress: (value: number) => void): Promise<PlayedNote[]> {
  const tracker = new NoteTracker(), size = 2048, hop = Math.round(sampleRate * 0.035)
  let frame = 0
  for (let offset = 0; offset + size <= samples.length; offset += hop) {
    tracker.push(detectPitch(samples.subarray(offset, offset + size), sampleRate), offset / sampleRate)
    if (++frame % 20 === 0) {
      progress(Math.round(offset / samples.length * 100))
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    }
  }
  progress(100)
  return tracker.notes
}

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer)
  const text = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples.length * 2, true)
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true))
  return new Blob([buffer], { type: 'audio/wav' })
}

export async function playReference(score: ScoreNote[], bpm: number): Promise<void> {
  const context = new AudioContext()
  try {
    await context.resume()
    let at = context.currentTime + 0.08
    for (const note of score) {
      const oscillator = context.createOscillator(), gain = context.createGain()
      oscillator.type = 'triangle'; oscillator.frequency.value = midiToFrequency(note.midi)
      oscillator.connect(gain); gain.connect(context.destination)
      const length = note.beats * 60 / bpm
      gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(0.15, at + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.001, at + length * 0.8)
      oscillator.start(at); oscillator.stop(at + length); at += length
    }
    await new Promise(resolve => setTimeout(resolve, (at - context.currentTime) * 1000 + 100))
  } finally { await context.close() }
}
