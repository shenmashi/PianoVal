/** The score's actual bar grid includes pickups, repeats and changing meters. */
export function measureStart(score, number) {
  return score.measureStartsSeconds[number - 1];
}
export function measureAt(score, seconds) {
  let low=0,high=score.bars;
  while(low<high){const middle=Math.ceil((low+high)/2);if(score.measureStartsSeconds[middle]<=seconds+.001)low=middle;else high=middle-1;}
  return Math.min(score.bars,low+1);
}
export function quarterSeconds(score, quarter) {
  const grid=score.measureQuarters;
  let index=0;
  while(index<score.bars-1&&grid[index+1]<=quarter)index++;
  const ratio=(quarter-grid[index])/(grid[index+1]-grid[index]);
  return score.measureStartsSeconds[index]+ratio*(score.measureStartsSeconds[index+1]-score.measureStartsSeconds[index]);
}

/** Map elapsed performance time back to the printed measure, including repeats. */
export function printedPosition(score, seconds) {
  const measure=measureAt(score,Math.max(0,seconds));
  const sourceMeasure=score.sourceMeasures?.[measure-1]||measure;
  const grid=score.sourceMeasureQuarters||score.measureQuarters;
  const start=score.measureStartsSeconds[measure-1],end=score.measureStartsSeconds[measure];
  const progress=Math.max(0,Math.min(1,(seconds-start)/(end-start)));
  return {measure,sourceMeasure,quarter:grid[sourceMeasure-1]+progress*(grid[sourceMeasure]-grid[sourceMeasure-1])};
}
