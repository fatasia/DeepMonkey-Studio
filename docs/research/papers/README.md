# 论文工作稿 / Working papers

作者 Wenpeng Zhang（张文鹏），Independent Researcher。Deep Monkey Studio 稿件已进入 arXiv 处理；TwinMoE 稿件当前等待 `cs.LG` 背书。

| 论文 | English | 中文 | LaTeX |
| --- | --- | --- | --- |
| Deep Monkey Studio：面向可编程三维世界的 AI 原生平台 | [PDF](deepmonkey-en.pdf) | [PDF](deepmonkey-zh.pdf) | [Source ZIP](deepmonkey-en-source.zip) |
| PINN–PINO TwinMoE：电池物理约束与专家协调 | [PDF](battery-en.pdf) | [PDF](battery-zh.pdf) | [Source ZIP](battery-en-source.zip) |

[平台代码](../../../README.md) · [引擎架构](../../../packages/deep-engine/README.md) · [AI 训练源码与运行命令](../../../research/battery-twin/README.md)

训练源码入口：[`research/battery-twin`](https://github.com/fatasia/DeepMonkey-Studio/tree/main/research/battery-twin)。论文中的历史实验保留各自的模型、数据与测量版本；`evidence/` 收录本轮冻结的统一外部基线与多电芯决策统计。

英文源码包包含独立 TeX 和 PDF 矢量图，可使用 Tectonic 编译。中文 PDF 供阅读；字体未随包分发。文件哈希见 [SHA256.json](SHA256.json)。

本版本包含 64 条最终场确认、48 条连续工况确认、跨来源电压/SOH/SOC 对照和五个健康来源电芯的决策统计；各子系统结果按目标分别报告。

Deep Monkey 稿以 AI 原生可编程三维世界为主线，描述引擎、模型与协议接入、创作工具、智能体和运行时如何共同工作，并讨论 AI for Science 与世界模型研究接口。电池稿以守恒专家、状态集合和预算感知决策为主线。英文源码包已独立编译验证。
