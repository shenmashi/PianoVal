/** Compare known simulator input with model output for display only. Never advances the score. */
const unique = (pitches) => [...new Set(pitches)].sort((a, b) => a - b);
const difference = (a, b) => a.filter((pitch) => !b.includes(pitch));
const name = (midi) => ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'][midi % 12] + (Math.floor(midi / 12) - 1);
const names = (pitches) => pitches.map(name).join(' + ') || '未识别到音';

export function recordPianoAttempt(previous, event, expected, step) {
  // The same 120 ms attack window as the follower; a later retry is a new attempt.
  if (previous && event.onsetSeconds - previous.start >= 0 && event.onsetSeconds - previous.start <= .12) {
    return {...previous, end: event.onsetSeconds, played: unique([...previous.played, event.midi])};
  }
  return {start:event.onsetSeconds, end:event.onsetSeconds, played:[event.midi], expected:[...expected], step};
}

export function pianoAttemptFeedback(attempt, observedNotes, processedThroughSeconds, decisions) {
  if (!attempt) return {state:'idle', title:'点下琴键后，这里会显示按键和识别结果。', played:'—', heard:'—', detail:'真实采样音频送入模型；是否前进取决于模型听音。'};
  // Audio time, not WebSocket arrival time. Allow onset estimation around the actual attack.
  const begin=attempt.start-.12, end=attempt.end+.12;
  const observed=unique(observedNotes.filter((note)=>note.onsetSeconds>=begin && note.onsetSeconds<=end).map((note)=>note.midi));
  const base={played:names(attempt.played), heard:names(observed)};
  if (processedThroughSeconds < end) return {...base, state:'listening', title:'已收到你的按键，正在等模型识别。', detail:'先松开琴键，等待几秒；不需要连续重复点击。'};
  const decision=decisions.findLast((item)=>item.step===attempt.step+1 && item.audioOnsetSeconds>=begin && item.audioOnsetSeconds<=end);
  const missing=difference(attempt.played,observed), extra=difference(observed,attempt.played);
  const pressedCorrectly=!difference(attempt.expected,attempt.played).length && !difference(attempt.played,attempt.expected).length;
  if (pressedCorrectly && (missing.length || extra.length)) {
    const differences=[missing.length?`没有识别到 ${names(missing)}`:'',extra.length?`额外识别出 ${names(extra)}`:''].filter(Boolean).join('；');
    return {...base,state:'model-mismatch', title:'你已按对，模型识别出现偏差。', detail:`当前目标 ${names(attempt.expected)}。${differences}。${decision?.action==='wait'?'跟弹因此停住，这次不是你点错。':'结果与实际按键不一致，请查看判定明细。'}`};
  }
  if (decision?.action==='advance') return {...base,state:'passed', title:'这次识别通过。', detail:'蓝色提示已更新。继续按下一个目标琴键；片段完成后可结束并对照。'};
  if (!pressedCorrectly) return {...base,state:'wrong-key',title:'这次按键与当前目标不同。',detail:`当前需要 ${names(attempt.expected)}，你按下了 ${names(attempt.played)}。请点蓝色箭头指示的琴键。`};
  if (decision?.action==='wait') {
    const reason=[decision.missing.length?`缺少 ${names(decision.missing)}`:'',decision.extra.length?`多出 ${names(decision.extra)}`:''].filter(Boolean).join('；');
    return {...base,state:'waiting',title:'按键已收到，跟弹仍在等待。',detail:`本次判定${reason}。可在判定明细复核。`};
  }
  return {...base,state:'listening',title:'模型已返回音符，正在等待完整判定。',detail:'先松开琴键；判定完成后才会切换目标。'};
}
