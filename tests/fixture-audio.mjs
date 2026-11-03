import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function makeMicrophoneFixture() {
  const rate = 48000, notes = [60, 62, 64, 65, 67, 69, 71, 72], length = Math.round(6.2 * rate)
  const buffer = Buffer.alloc(44 + length * 2)
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + length * 2, 4); buffer.write('WAVE', 8); buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36); buffer.writeUInt32LE(length * 2, 40)
  notes.forEach((midi, index) => {
    const hz = 440 * 2 ** ((midi - 69) / 12)
    for (let i = 0; i < rate * 0.43; i++) {
      const t = i / rate, phase = 2 * Math.PI * hz * t
      const envelope = Math.min(1, t / 0.008) * Math.exp(-t * 4) * Math.min(1, (0.43 - t) / 0.035)
      const value = (Math.sin(phase) + 0.35 * Math.sin(2 * phase) + 0.16 * Math.sin(3 * phase)) * envelope * 0.23
      buffer.writeInt16LE(Math.round(value * 32767), 44 + (Math.floor((0.6 + index * 0.65) * rate) + i) * 2)
    }
  })
  const directory = join(tmpdir(), 'pianoval-test'); mkdirSync(directory, { recursive: true })
  const path = join(directory, 'scale.wav'); writeFileSync(path, buffer); return path
}
