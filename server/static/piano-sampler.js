/** Sampled piano. Its audio bus, not its MIDI events, feeds the recognition model. */
export class PianoSampler {
  constructor(context, onTrigger) {
    this.context=context;this.onTrigger=onTrigger;this.buffers=new Map();this.voices=new Map();
    this.events=[];this.origin=null;this.pedal=false;
    this.node=context.createGain();this.node.channelCount=1;this.node.channelCountMode='explicit';
    this.node.gain.value=0.65;this.node.connect(context.destination);
  }
  async load(onProgress) {
    const response=await fetch(appPath('/static/piano-samples/manifest.json'));
    if(!response.ok)throw new Error('钢琴采样清单载入失败');
    const manifest=await response.json();let count=0;
    await Promise.all(manifest.assets.map(async (asset)=>{
      const response=await fetch(appPath(`/static/piano-samples/${asset.file}`));
      if(!response.ok)throw new Error(`钢琴采样 ${asset.file} 载入失败`);
      const buffer=await this.context.decodeAudioData(await response.arrayBuffer());
      this.buffers.set(asset.midi,buffer);count++;onProgress?.(count,manifest.assets.length);
    }));
  }
  onCapture({audioTime}) {this.origin=audioTime;}
  noteOn(midi,velocity=80,time=this.context.currentTime+0.006) {
    if(this.origin===null||this.context.state!=='running')return null;
    const sampled=[...this.buffers.keys()].reduce((best,pitch)=>Math.abs(pitch-midi)<Math.abs(best-midi)?pitch:best);
    if(sampled===undefined)throw new Error('钢琴采样尚未就绪');
    const source=this.context.createBufferSource();source.buffer=this.buffers.get(sampled);
    source.playbackRate.value=2**((midi-sampled)/12);
    const gain=this.context.createGain();gain.gain.setValueAtTime(Math.max(.02,velocity/127)*0.85,time);
    source.connect(gain);gain.connect(this.node);source.start(time);
    const identifier=Symbol(midi);const voice={source,gain,midi,released:false};this.voices.set(identifier,voice);
    source.onended=()=>{source.disconnect();gain.disconnect();this.voices.delete(identifier);};
    const event={midi,onsetSeconds:Number(Math.max(0,time-this.origin).toFixed(6)),velocity};
    this.events.push(event);this.onTrigger?.(event);
    return identifier;
  }
  noteOff(identifier) {
    const voice=this.voices.get(identifier);if(!voice)return;
    voice.released=true;if(!this.pedal)this.release(identifier);
  }
  release(identifier) {
    const voice=this.voices.get(identifier);if(!voice)return;
    const time=this.context.currentTime;voice.gain.gain.cancelScheduledValues(time);
    voice.gain.gain.setTargetAtTime(0,time,.045);
    try{voice.source.stop(time+.24);}catch{/* Already ended. */}
  }
  setPedal(value) {this.pedal=value;if(!value)for(const[id,voice]of this.voices)if(voice.released)this.release(id);}
  dispose(){for(const[id]of this.voices)this.release(id);this.node.disconnect();}
}
import {appPath} from './paths.js';
