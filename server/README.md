# PianoVal 钢琴识别服务

基于 FastAPI、WebSocket 和 O&V 的钢琴复音识别工作台，包含浏览器页面、曲谱跟弹、虚拟钢琴、标注、训练、报告和可选账号登录。

完整功能、启动命令和能力边界见 [项目 README](../README.md)，部署见 [通用部署指南](../docs/DEPLOYMENT.md)，模型与资源授权见 [第三方说明](THIRD_PARTY_NOTICES.md)。

## WebSocket 协议

连接 `/ws/transcribe`，先发送 JSON：

```json
{"type":"start","version":1,"sampleRate":48000,"channels":1,"format":"pcm_s16le","saveRecording":true}
```

收到 `type=ready` 后再发送 PCM。启用站内登录时，需要有效会话 Cookie；如另外配置 `PIANOVAL_TOKEN`，首条消息还须包含 `token`。可通过 `modelId` 选择 `base`、`active` 或候选模型。

二进制包按小端排列：

| 字节 | 类型 | 含义 |
| --- | --- | --- |
| 0–3 | uint32 | 从 0 开始递增的包序号 |
| 4–11 | uint64 | 本包在输入音频中的起始采样位置 |
| 12–末尾 | int16 | 单声道 PCM，无 WAV 文件头 |

声明 AudioContext 的实际采样率，服务端连续重采样到 16 kHz。浏览器默认约 20 ms 一包，单包最长 250 ms，包号与采样计数必须连续。

服务端返回 `notes`：

```json
{
  "type":"notes",
  "sessionId":"example-session",
  "events":[{"midi":60,"note":"C4","onsetSeconds":1.214,"velocity":80,"onsetProbability":0.91}],
  "processedThroughSeconds":1.44,
  "receivedAudioSeconds":1.92,
  "inferenceMs":150,
  "queueAndInferenceMs":152,
  "tailPadded":false
}
```

字段值为协议示意，不是性能结论。`events=[]` 表示该区间没有检测到起音；起音概率不等于学生弹对概率。模型不根据目标曲谱过滤输出。

发完尾部 PCM 后发送真实包数与采样数：

```json
{"type":"stop","packets":100,"samples":96000}
```

服务端处理尾部后返回 `complete` 并关闭连接。断线不支持续传，但启用录音保存时会保留已收到且满足最小时长的音频。

`ping` / `pong` 用于应用层往返测量；`telemetry` 传递浏览器时间和缓冲统计。逐窗服务端与浏览器日志用于区分推理耗时、接收积压和界面处理时间。
