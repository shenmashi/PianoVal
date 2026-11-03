import {appPath} from './paths.js';
const $ = (id) => document.getElementById(id);
$('endpoint').value = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${appPath('/ws/transcribe')}`;
let connection = null;
let lastRun = null;

async function cleanup(run) {
  clearInterval(run.pingTimer);
  run.source?.disconnect();
  run.worklet?.disconnect();
  run.stream?.getTracks().forEach((track) => track.stop());
  run.customInput?.dispose?.();
  await run.context?.close().catch(() => {});
  if (connection === run) {
    connection = null;
    $('start').disabled = false;
    $('stop').disabled = true;
    run.options?.onEnd?.(Boolean(run.completed));
    window.dispatchEvent(new Event('pianoval:listening-end'));
  }
  run.resolveClosed?.();
}

async function fail(run, error) {
  if (connection !== run) return;
  $('error').textContent = error.message || String(error);
  run.options?.onError?.(error);
  run.socket?.close();
  await cleanup(run);
}

function sendSamples(run, samples) {
  if (run.socket.readyState !== WebSocket.OPEN) throw new Error('连接已中断，请重新开始录音');
  if (run.socket.bufferedAmount > 2 * 1024 * 1024) throw new Error('网络发送积压，录音已停止，请检查网络后重新开始');
  const packet = new ArrayBuffer(12 + samples.length * 2);
  const view = new DataView(packet);
  view.setUint32(0, run.sequence, true);
  view.setBigUint64(4, BigInt(run.samples), true);
  samples.forEach((sample, index) => {
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(12 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  });
  run.socket.send(packet);
  const audioNow=run.captureAudioTime===undefined?null:run.context.currentTime-run.captureAudioTime;
  run.lastPacketTiming={lastPacketSequence:run.sequence,lastPacketSentAtUnixMs:Date.now(),
    lastPacketAudioEndSeconds:(run.samples+samples.length)/run.context.sampleRate,
    captureToSendMs:audioNow===null?null:Math.max(0,(audioNow-run.samples/run.context.sampleRate)*1000)};
  run.sequence += 1;
  run.samples += samples.length;
}

async function capture(run) {
  if (run.options.inputFactory) {
    run.customInput = await run.options.inputFactory(run.context);
    run.source = run.customInput.node;
  } else {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    } });
    if (connection !== run) { stream.getTracks().forEach((track) => track.stop()); return; }
    run.stream = stream;
    run.source = run.context.createMediaStreamSource(stream);
  }
  await run.context.audioWorklet.addModule(appPath('/static/pcm-worklet.js'));
  if (connection !== run) return;
  run.worklet = new AudioWorkletNode(run.context, 'pcm-capture', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 1, channelCountMode: 'explicit',
    processorOptions: {packetFrames:Math.round(run.context.sampleRate*.02)},
  });
  run.worklet.port.onmessage = ({ data }) => {
    if (data === 'flushed') { run.flushed?.(); return; }
    if (data?.type === 'capture-start') {
      run.captureAudioTime = data.audioTime;
      run.customInput?.onCapture?.(data);
      run.options?.onCapture?.(data);
      window.dispatchEvent(new Event('pianoval:listening-start'));
      return;
    }
    if (connection !== run) return;
    try { sendSamples(run, data); } catch (error) { void fail(run, error); }
  };
  run.source.connect(run.worklet);
  run.worklet.connect(run.context.destination); // Output stays silent; keep the capture graph running.
  await run.context.resume();
  run.stream?.getTracks().forEach((track) => track.addEventListener('ended', () => {
    if (!run.stopping) void fail(run, new Error('麦克风已断开'));
  }));
  $('status').textContent += `\n正在采集：${run.context.sampleRate} Hz → 服务端连续重采样至 16000 Hz`;
  $('stop').disabled = false;
}

export async function startLive(options = {}) {
  if (connection) throw new Error('已有录音会话，请先停止录音');
  $('error').textContent = '';
  if (!window.isSecureContext || !navigator.mediaDevices || !window.AudioWorkletNode) {
    $('error').textContent = '请使用支持 AudioWorklet 的现代浏览器，并通过 HTTPS 或本机 localhost 打开。';
    options.onError?.(new Error($('error').textContent));
    options.onEnd?.(false);
    return;
  }
  // Create/resume audio directly in the click gesture, before network awaits (Safari).
  const run = { context: new AudioContext(), sequence: 0, samples: 0, stopping: false, options };
  run.closed=new Promise(resolve=>{run.resolveClosed=resolve;});
  connection = run;
  lastRun = run;
  $('start').disabled = true;
  $('notes').replaceChildren();
  $('status').textContent = '正在连接模型服务…';
  try {
    await run.context.resume();
    const authResponse=await fetch(appPath('/auth/session'),{credentials:'same-origin',cache:'no-store'});
    if(!authResponse.ok)throw new Error('无法确认登录状态，请刷新后重新登录');
    const auth=await authResponse.json();
    if(auth.required&&!auth.authenticated){
      await fail(run,new Error('登录已失效，请重新登录后开始听琴'));
      window.dispatchEvent(new Event('pianoval:login-required'));
      return;
    }
    if(connection!==run)return;
    run.socket = new WebSocket($('endpoint').value);
    run.socket.onopen = () => run.socket.send(JSON.stringify({
      type: 'start', version: 1, sampleRate: run.context.sampleRate,
      channels: 1, format: 'pcm_s16le', token: $('token').value,
      modelId: options.modelId || 'active',
      saveRecording: Boolean(options.saveRecording),
      recordingKind: options.inputFactory ? 'simulated' : 'microphone',
      testId:options.testId||'',testContext:options.testContext||{},
    }));
    run.socket.onerror = () => void fail(run, new Error('WebSocket 连接失败，请检查地址和 HTTPS/WSS 配置'));
    run.socket.onclose = () => {
      if (connection === run) {
        if (!run.completed) {
          $('error').textContent ||= '连接已断开，本次录音已停止。';
          run.options?.onError?.(new Error($('error').textContent));
        }
        void cleanup(run);
      }
    };
    run.socket.onmessage = ({ data }) => {
      try {
        const handlerBegan=performance.now();
        const message = JSON.parse(data);
        if(message.type==='pong'&&Number.isFinite(message.clientSentAt)){run.rttMs=performance.now()-message.clientSentAt;run.rttSampleId=message.clientSentAt;}
        if(message.type==='notes')message.clientTiming={
          receivedAtUnixMs:Date.now(),receivedAtPerformanceMs:handlerBegan,
          audioAtReceiptSeconds:run.captureAudioTime===undefined||run.context.state!=='running'?null:Math.max(0,run.context.currentTime-run.captureAudioTime),
          rttMs:run.rttMs??null,
          rttSampleId:run.rttSampleId??null,
          browserBufferedBytes:run.socket.bufferedAmount,sentPackets:run.sequence,sentSamples:run.samples,
          ...run.lastPacketTiming,
        };
        if(message.clientTiming)message.clientTiming.analysisLagMs=message.clientTiming.audioAtReceiptSeconds===null?null:Math.max(0,(message.clientTiming.audioAtReceiptSeconds-message.processedThroughSeconds)*1000);
        run.options?.onMessage?.(message);
        if(message.clientTiming){
          message.clientTiming.handlerMs=performance.now()-handlerBegan;
          if(!run.stopping&&run.socket.readyState===WebSocket.OPEN){
            run.socket.send(JSON.stringify({type:'telemetry',windowId:message.windowId,...message.clientTiming}));
          }
        }
        if (message.type === 'error') {
          const explanation={server_busy:'当前已有两路听琴连接，请结束其中一路后重试',unauthorized:'访问令牌无效，请检查连接设置',model_unavailable:'识别模型暂未就绪，请稍后重试'};
          void fail(run, new Error(explanation[message.code]||message.message||'识别服务发生错误'));return;
        }
        if (message.type === 'ready') {
          const ping=()=>{if(run.socket.readyState===WebSocket.OPEN)run.socket.send(JSON.stringify({type:'ping',clientSentAt:performance.now()}));};
          ping();run.pingTimer=setInterval(ping,2000);
          $('status').textContent = `模型已就绪：${message.model.name} / ${message.model.device}\n右侧上下文：${message.model.rightContextSeconds} 秒`;
          void capture(run).catch((error) => fail(run, error));
        } else if (message.type === 'notes') {
          $('status').textContent = `已接收 ${message.receivedAudioSeconds.toFixed(2)} 秒；已分析至 ${message.processedThroughSeconds.toFixed(2)} 秒\n本窗推理 ${message.inferenceMs} ms；含排队 ${message.queueAndInferenceMs} ms`;
          for (const event of message.events) {
            const row = $('notes').insertRow(0);
            for (const value of [event.note, event.midi, event.onsetSeconds, event.velocity, event.onsetProbability]) {
              row.insertCell().textContent = String(value);
            }
          }
          while ($('notes').rows.length > 300) $('notes').deleteRow(-1);
        } else if (message.type === 'complete') {
          run.completed = true;
          $('status').textContent = `处理完成：${message.audioSeconds.toFixed(2)} 秒，${message.receivedPackets} 包，识别 ${message.noteCount} 个起音事件。`;
          void cleanup(run);
        }
      } catch (error) { void fail(run, error); }
    };
  } catch (error) { await fail(run, error); }
}
$('start').onclick = () => void startLive().catch((error) => { $('error').textContent = error.message; });

export async function stopLive() {
  const run = connection;
  if (!run || run.stopping) return;
  run.stopping = true;
  $('stop').disabled = true;
  try {
    run.source?.disconnect();
    if (run.worklet) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('音频尾包未能发送，请重新开始')), 2000);
      run.flushed = () => { clearTimeout(timer); resolve(); };
      run.worklet.port.postMessage('flush');
    });
    run.stream?.getTracks().forEach((track) => track.stop());
    run.worklet?.disconnect();
    await run.context.close();
    run.socket.send(JSON.stringify({ type: 'stop', packets: run.sequence, samples: run.samples }));
    $('status').textContent = '录音结束，正在处理剩余音频…';
  } catch (error) { await fail(run, error); }
}
$('stop').onclick = () => void stopLive();

export function hasLiveConnection(){return Boolean(connection);}

export function liveAudioSeconds(){
  const run=connection;
  if(!run||run.stopping||run.captureAudioTime===undefined)return null;
  return Math.max(run.samples/run.context.sampleRate,run.context.currentTime-run.captureAudioTime);
}

export async function stopLiveAndWait(){
  const run=connection||lastRun;
  if(!run)return;
  if(connection===run&&!run.stopping)await stopLive();
  let timer;
  try{
    await Promise.race([run.closed,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('听琴记录仍在处理中，请稍等后再次退出')),30000);
    })]);
    // The practice page may still be saving its final report after the stream completes.
    await run.options?.afterSave?.();
  }finally{clearTimeout(timer);}
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && connection) void fail(connection, new Error('页面进入后台，录音已停止，请回到页面重新开始'));
});
