export function soundingPitches(notes,seconds,hand='both') {
  return new Set(notes.filter(note=>(hand==='both'||note.hand===hand)
    &&note.onsetSeconds<=seconds&&seconds<note.onsetSeconds+(note.durationSeconds||.2)).map(note=>note.midi));
}

export function audioScoreTime(seconds,offset=0,speed=1) {
  return Math.max(0,(seconds-offset)*speed);
}
