import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectPitch } from '../src/audio/pitch.ts'
import { NoteTracker } from '../src/audio/events.ts'
import { alignNotes, midiToFrequency, midiToName, parseNotes } from '../src/music/notes.ts'
import type { PlayedNote } from '../src/music/notes.ts'

function signal(midi: number, rate: number, harmonics = false) {
  const frequency = midiToFrequency(midi)
  return Float32Array.from({ length: 2048 }, (_, i) => {
    const phase = 2 * Math.PI * frequency * i / rate
    return (Math.sin(phase) + (harmonics ? 0.4 * Math.sin(2 * phase) + 0.2 * Math.sin(3 * phase) : 0)) * 0.2
  })
}
const playedNotes = (notes: number[]): PlayedNote[] => notes.map((midi, i) => ({ midi, start: i * 0.6, duration: 0.4, cents: 0 }))

for (const rate of [22050, 44100, 48000]) for (const midi of [48, 60, 69, 84]) {
  test(`YIN estimates ${midiToName(midi)} at ${rate}Hz including piano-like harmonics`, () => {
    const result = detectPitch(signal(midi, rate, true), rate)
    assert.ok(result, 'must detect a stable harmonic signal')
    assert.equal(result.midi, midi)
    assert.ok(Math.abs(result.cents) < 12, `frequency should be within 12 cents: ${result.cents}`)
  })
}
test('silence, DC and out-of-range low pitches do not create valid notes', () => {
  assert.equal(detectPitch(new Float32Array(2048), 44100), null)
  assert.equal(detectPitch(new Float32Array(2048).fill(0.1), 44100), null)
  assert.equal(detectPitch(signal(36, 44100), 44100), null)
})
test('reference notes handle flats and reject invalid notes and unsupported ranges', () => {
  assert.equal(parseNotes('Bb4, F#4 C4')[0]!.midi, 70)
  assert.throws(() => parseNotes('H4'))
  assert.throws(() => parseNotes('C2'))
  assert.throws(() => parseNotes(''))
})
test('a missing note does not shift later matches', () => {
  const rows = alignNotes(parseNotes('C4 D4 E4 F4'), playedNotes([60, 64, 65]))
  assert.deepEqual(rows.map(row => row.status), ['correct', 'missed', 'correct', 'correct'])
  assert.equal(rows[1]!.expectedIndex, 1)
})
test('an extra note does not shift later matches', () => {
  const rows = alignNotes(parseNotes('C4 D4 E4'), playedNotes([60, 67, 62, 64]))
  assert.deepEqual(rows.map(row => row.status), ['correct', 'extra', 'correct', 'correct'])
})
test('wrong pitches, octave errors and unplayed notes remain visible', () => {
  assert.deepEqual(alignNotes(parseNotes('C4 D4'), playedNotes([72, 63])).map(row => row.status), ['wrong', 'wrong'])
  assert.deepEqual(alignNotes(parseNotes('C4 D4'), []).map(row => row.status), ['missed', 'missed'])
})
test('a sustained note is a single event, with a new event after silence', () => {
  const tracker = new NoteTracker(), pitch = detectPitch(signal(60, 44100), 44100)!
  for (let i = 0; i < 8; i++) tracker.push(pitch, i * 0.035)
  assert.equal(tracker.notes.length, 1)
  tracker.push(null, 0.5)
  for (let i = 0; i < 4; i++) tracker.push(pitch, 0.6 + i * 0.035)
  assert.equal(tracker.notes.length, 2)
})
test('nonconsecutive pitch glitches do not accumulate into a wrong note', () => {
  const tracker = new NoteTracker()
  const stable = detectPitch(signal(60, 44100), 44100)!, glitch = detectPitch(signal(62, 44100), 44100)!
  for (let i = 0; i < 4; i++) tracker.push(stable, i * 0.035)
  tracker.push(glitch, 0.15); tracker.push(stable, 0.19); tracker.push(glitch, 0.23); tracker.push(glitch, 0.27)
  assert.equal(tracker.notes.length, 1)
})
