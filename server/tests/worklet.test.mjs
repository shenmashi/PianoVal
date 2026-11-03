import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('silent gaps keep the PCM clock moving and the final partial packet flushes',()=>{
  const messages=[];
  let Processor;
  vm.runInNewContext(readFileSync(new URL('../static/pcm-worklet.js',import.meta.url),'utf8'),{
    AudioWorkletProcessor:class {constructor(){this.port={postMessage:data=>messages.push(data)};}},
    registerProcessor:(_,processor)=>{Processor=processor;},
    currentFrame:4800,sampleRate:48000,Float32Array,
  });
  const processor=new Processor();
  const output=()=>[ [new Float32Array(128)] ];
  for(let i=0;i<16;i++)processor.process([[]],output());
  assert.equal(messages[0].type,'capture-start');
  assert.equal(messages[0].audioTime,0.1);
  assert.equal(messages[1].length,2048);
  assert.ok(messages[1].every(value=>value===0));
  processor.process([[new Float32Array(128).fill(.25)]],output());
  processor.process([[]],output());
  processor.port.onmessage({data:'flush'});
  assert.equal(messages[2].length,256);
  assert.ok(messages[2].slice(0,128).every(value=>value===.25));
  assert.ok(messages[2].slice(128).every(value=>value===0));
  assert.equal(messages[3],'flushed');
});

test('20 ms packets keep their duration at both Pad rates and 16 kHz',()=>{
  for(const rate of [16000,44100,48000]){
    const messages=[];let Processor;
    vm.runInNewContext(readFileSync(new URL('../static/pcm-worklet.js',import.meta.url),'utf8'),{
      AudioWorkletProcessor:class{constructor(){this.port={postMessage:data=>messages.push(data)};}},
      registerProcessor:(_,processor)=>{Processor=processor;},currentFrame:0,sampleRate:rate,Float32Array,
    });
    const frames=Math.round(rate*.02),processor=new Processor({processorOptions:{packetFrames:frames}});
    for(let i=0;i<Math.ceil(frames/128);i++)processor.process([[]],[[new Float32Array(128)]]);
    assert.equal(messages[1].length,frames);assert.ok(Math.abs(messages[1].length/rate-.02)<.0001);
  }
});
