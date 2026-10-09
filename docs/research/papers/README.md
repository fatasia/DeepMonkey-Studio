# 论文工作稿 / Working papers

作者 Wenpeng Zhang（张文鹏），Independent Researcher。以下为 2026-10-09 重写的技术报告，尚未在 arXiv 正式提交。

| 论文 | English | 中文 | LaTeX |
| --- | --- | --- | --- |
| Deep Monkey Studio：面向可编程三维世界的 AI 原生平台 | [PDF](deepmonkey-en.pdf) | [PDF](deepmonkey-zh.pdf) | [Source ZIP](deepmonkey-en-source.zip) |
| PINN–PINO TwinMoE：电池物理约束与专家协调 | [PDF](battery-en.pdf) | [PDF](battery-zh.pdf) | [Source ZIP](battery-en-source.zip) |

[平台代码](../../../README.md) · [引擎架构](../../../packages/deep-engine/README.md) · [AI 训练源码与运行命令](../../../research/battery-twin/README.md)

训练源快照：[`b76cbb1fbb36`](https://github.com/fatasia/DeepMonkey-Studio/tree/b76cbb1fbb36b484ddff56fa0e96020bff140c31/research/battery-twin)。论文中的历史实验保留各自的模型、数据与测量版本。新增训练冒烟检查没有用于替代论文结果。

英文源码包包含独立 TeX 和 PDF 矢量图，可使用 Tectonic 编译。中文 PDF 供阅读；字体未随包分发。文件哈希见 [SHA256.json](SHA256.json)。

当前仍需补充整体平台任务对照、共同参考下的专家路由评价和跨时间尺度耦合实验。稿件中的计划与已记录结果分别标明。

Deep Monkey 稿以 AI 原生可编程三维世界为主线，描述引擎、模型与协议接入、创作工具、智能体和运行时如何共同工作，并讨论 AI for Science 与世界模型研究接口。英文 10 页，中文 8 页。电池稿英文 7 页，中文 6 页。英文源码包已独立编译验证。
