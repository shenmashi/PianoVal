import type { Pitch } from './pitch.ts'
import type { PlayedNote } from '../music/notes.ts'

/** Require stable frames; release on silence. Very short/repeated notes need a learned onset model. */
export class NoteTracker {
  notes: PlayedNote[] = []
  private candidate: { midi: number; start: number; last: number; count: number; cents: number } | null = null
  private active: PlayedNote | null = null
  private lastPitchAt = -1
  private previousRms = 0

  push(pitch: Pitch | null, time: number): boolean {
    if (!pitch) {
      if (time - this.lastPitchAt > 0.1) { this.active = null; this.candidate = null }
      this.previousRms = 0
      return false
    }
    const newAttack = this.active && time - this.active.start > 0.22 && pitch.rms > Math.max(0.025, this.previousRms * 2.8)
    if (newAttack) { this.active = null; this.candidate = null }
    this.previousRms = pitch.rms
    this.lastPitchAt = time
    if (this.active?.midi === pitch.midi) {
      this.active.duration = time - this.active.start
      this.candidate = null
      return false
    }
    if (!this.candidate || this.candidate.midi !== pitch.midi) {
      this.candidate = { midi: pitch.midi, start: time, last: time, count: 1, cents: pitch.cents }
      return false
    }
    this.candidate.count++
    this.candidate.cents += pitch.cents
    this.candidate.last = time
    if (this.candidate.count < 3 || time - this.candidate.start < 0.05) return false
    this.active = { midi: pitch.midi, start: this.candidate.start, duration: time - this.candidate.start, cents: this.candidate.cents / this.candidate.count }
    this.notes.push(this.active)
    this.candidate = null
    return true
  }
}
