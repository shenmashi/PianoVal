/** Event-driven waiting mode. Wrong/extra pitches never advance the score. */
export function makeSteps(notes, {hand = 'both', startSeconds = 0, endSeconds = Infinity} = {}) {
  // MIDI's integer microsecond tempo drifts slightly from the displayed BPM.
  // Keep notes on a bar boundary in that bar after second rounding.
  const ordered = notes.filter((note) => note.onsetSeconds >= startSeconds - .001 && note.onsetSeconds < endSeconds - .001
    && (hand === 'both' || note.hand === hand)).sort((a, b) => a.onsetSeconds - b.onsetSeconds || a.midi - b.midi);
  const steps = [];
  for (const note of ordered) {
    let step = steps.at(-1);
    if (!step || note.onsetSeconds - step.onsetSeconds > 0.002) {
      step = {onsetSeconds: note.onsetSeconds, pitches: []}; steps.push(step);
    }
    if (!step.pitches.includes(note.midi)) step.pitches.push(note.midi);
  }
  return steps;
}

export class WaitingFollower {
  constructor(steps, windowSeconds = 0.12) {
    this.steps = steps;
    this.windowSeconds = windowSeconds;
    this.index = 0;
    this.pending = [];
    this.trace = [];
    this.lastBoundary = -Infinity;
    this.ignoreThroughSeconds = -Infinity;
  }
  get current() { return this.steps[this.index] || null; }
  get complete() { return this.index >= this.steps.length; }
  get manualSteps() { return this.trace.reduce((total, row) => total + (row.action === 'manual-advance' ? row.skippedSteps : 0), 0); }

  // A teacher override changes position, never the model's recognized notes.
  // Ignore delayed results from audio captured before the teacher resumed.
  manualAdvance({audioOnsetSeconds, toScoreSeconds, reason = 'teacher-release'} = {}) {
    if (this.complete) return null;
    if (!Number.isFinite(audioOnsetSeconds) || audioOnsetSeconds < 0) throw new Error('听琴尚未就绪，请稍等');
    if (toScoreSeconds !== undefined && !Number.isFinite(toScoreSeconds)) throw new Error('无效的谱面位置');
    let next = this.index + 1;
    if (toScoreSeconds !== undefined) {
      next = this.steps.findIndex((step, index) => index > this.index && step.onsetSeconds >= toScoreSeconds - .001);
      if (next < 0) next = this.steps.length;
    }
    const last = this.trace.at(-1);
    const observed = last?.step === this.index + 1 ? [...last.observed] : [];
    const expected = [...this.current.pitches];
    const decision = {step:this.index + 1, expected, observed,
      missing:expected.filter(pitch => !observed.includes(pitch)), extra:observed.filter(pitch => !expected.includes(pitch)),
      audioOnsetSeconds, scoreOnsetSeconds:this.current.onsetSeconds, action:'manual-advance',
      reason, skippedSteps:next - this.index, nextStep:next < this.steps.length ? next + 1 : null,
      createdAt:new Date().toISOString(), excludedFromRecognitionAccuracy:true};
    this.index = next;
    this.ignoreThroughSeconds = Math.max(this.ignoreThroughSeconds, audioOnsetSeconds);
    this.pending = this.pending.filter(note => note.onsetSeconds > this.ignoreThroughSeconds);
    this.trace.push(decision);
    return decision;
  }

  push(events, processedThroughSeconds, flush = false) {
    // Process by AUDIO time; arrival order/batch boundaries cannot change decisions.
    this.pending.push(...events.filter(note => note.onsetSeconds > this.ignoreThroughSeconds).map((note) => ({...note})));
    this.pending.sort((a, b) => a.onsetSeconds - b.onsetSeconds || a.midi - b.midi);
    const decisions = [];
    while (this.pending.length && !this.complete) {
      const first = this.pending[0].onsetSeconds;
      const stop = first + this.windowSeconds;
      if (!flush && processedThroughSeconds < stop) break;
      const attack = [];
      while (this.pending.length && this.pending[0].onsetSeconds <= stop + 1e-9) attack.push(this.pending.shift());
      const observed = [...new Set(attack.map((note) => note.midi))].sort((a, b) => a - b);
      const expected = this.current.pitches;
      const missing = expected.filter((pitch) => !observed.includes(pitch));
      const extra = observed.filter((pitch) => !expected.includes(pitch));
      const advance = !missing.length && !extra.length;
      const decision = {step: this.index + 1, expected: [...expected], observed, missing, extra,
        audioOnsetSeconds: first, scoreOnsetSeconds: this.current.onsetSeconds,
        action: advance ? 'advance' : 'wait'};
      this.trace.push(decision); decisions.push(decision); this.lastBoundary = stop;
      if (advance) this.index++;
    }
    return decisions;
  }
}
