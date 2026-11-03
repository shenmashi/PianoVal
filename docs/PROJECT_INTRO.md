# PianoVal 项目介绍

## 仓库简介

PianoVal 是面向钢琴教学的 AI 听音与跟弹评测工作台，支持浏览器录音、WebSocket 流式复音识别、左右手与双手曲谱对照、虚拟钢琴自动测试、录音标注、模型微调和误拦复核。

## English description

AI piano listening and practice evaluation workbench with streaming transcription, score following, virtual piano tests, annotation, model fine-tuning and latency diagnostics.

## 项目介绍

PianoVal 面向“学生弹奏、系统听音、对照曲谱、实时反馈”的钢琴教学场景。学生使用电脑或 Pad 浏览器采集声音，服务端钢琴模型识别实际音符，跟弹引擎根据参考曲谱判断当前音组是否匹配，并驱动谱面游标和键盘提示。

项目将真实弹奏、虚拟钢琴测试、教师复核和训练数据整理放在同一工作台，既用于验证识别效果，也便于分析漏音、误识别、误拦和反馈延迟。模型误拦时，教师可以人工放行并继续演奏，操作单独留痕。

识别模型支持自行部署，不需要付费大模型 API；训练需要人工核验标签，日常测试不会自动改变权重。项目处于实验评测阶段，实际准确率与并发能力需要在目标钢琴、设备和网络环境中验证。

自有代码采用 Apache-2.0；第三方模型、代码和曲谱保留各自授权。
