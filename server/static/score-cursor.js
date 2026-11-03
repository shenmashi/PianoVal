/** Index the printed score, independently of the performance's repeat order. */
export class ScoreCursor {
  constructor(cursor) {
    this.cursor=cursor;
    this.quarters=[];
    cursor.reset();
    while(!cursor.Iterator.EndReached) {
      this.quarters.push(cursor.Iterator.CurrentSourceTimestamp.RealValue*4);
      if(this.quarters.length>100000)throw new Error('曲谱光标索引超出范围');
      cursor.Iterator.moveToNextVisibleVoiceEntry(false);
    }
    cursor.reset();
    this.index=0;
    this.iterator=cursor.Iterator;
  }

  seek(quarter) {
    let low=0,high=this.quarters.length;
    // Stay on the current entry until the next entry actually begins.
    while(low<high) {
      const middle=Math.floor((low+high)/2);
      if(this.quarters[middle]<=quarter+0.0001)low=middle+1;else high=middle;
    }
    const target=Math.max(0,low-1);
    // OSMD may reset its iterator when the browser resizes the score.
    if(this.cursor.Iterator!==this.iterator||target<this.index) {
      this.cursor.reset();this.index=0;this.iterator=this.cursor.Iterator;
    }
    while(this.index<target) {this.cursor.Iterator.moveToNextVisibleVoiceEntry(false);this.index++;}
    this.cursor.show();
  }
}
