class PcmCapture extends AudioWorkletProcessor {
  constructor(options={}) {
    super();
    this.packetFrames=options.processorOptions?.packetFrames||2048;
    this.buffer = new Float32Array(this.packetFrames);
    this.used = 0;
    this.started = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'flush') {
        if (this.used) this.port.postMessage(this.buffer.slice(0, this.used));
        this.used = 0;
        this.port.postMessage('flushed');
      }
    };
  }
  process(inputs, outputs) {
    // A sampled instrument has no active input channels between notes. Keep
    // transmitting silence so sample offsets and model lookahead still advance.
    const channel = inputs[0]?.[0] || outputs[0]?.[0];
    if (channel) {
      if (!this.started) {
        this.started = true;
        this.port.postMessage({type: 'capture-start', audioTime: currentFrame / sampleRate});
      }
      let offset = 0;
      while (offset < channel.length) {
        const count = Math.min(channel.length - offset, this.buffer.length - this.used);
        this.buffer.set(channel.subarray(offset, offset + count), this.used);
        offset += count;
        this.used += count;
        if (this.used === this.buffer.length) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(this.packetFrames);
          this.used = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
