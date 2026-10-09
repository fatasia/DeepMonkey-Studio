# 论文工作稿 / Working papers

作者 Wenpeng Zhang（张文鹏），Independent Researcher。以下为 2026-10-09 重写的技术报告，尚未在 arXiv 正式提交。

| 论文 | English | 中文 | LaTeX |
| --- | --- | --- | --- |
| Deep Monkey：引擎、工业数字孪生构建、执行与交付 | [PDF](deepmonkey-en.pdf) | [PDF](deepmonkey-zh.pdf) | [Source ZIP](deepmonkey-en-source.zip) |
| PINN–PINO TwinMoE：电池物理约束与专家协调 | [PDF](battery-en.pdf) | [PDF](battery-zh.pdf) | [Source ZIP](battery-en-source.zip) |

[平台代码](../../../README.md) · [引擎架构](../../../packages/deep-engine/README.md) · [AI 训练源码与运行命令](../../../research/battery-twin/README.md)

训练源快照：[`b76cbb1fbb36`](https://github.com/fatasia/DeepMonkey-Studio/tree/b76cbb1fbb36b484ddff56fa0e96020bff140c31/research/battery-twin)。论文中的历史实验保留各自的模型、数据与测量版本。新增训练冒烟检查没有用于替代论文结果。

英文源码包包含独立 TeX 和 PDF 矢量图，可使用 Tectonic 编译。中文 PDF 供阅读；字体未随包分发。文件哈希见 [SHA256.json](SHA256.json)。

当前仍需补充整体平台任务对照、共同参考下的专家路由评价和跨时间尺度耦合实验。稿件中的计划与已记录结果分别标明。

本轮重写了摘要、贡献、架构与方法论证和结论，加入平台/专家架构图、物理损失及条件执行公式。英文分别 9 / 7 页，中文分别 8 / 6 页；两份英文源码包均已解压独立编译验证。现有实验数值保持原记录，未把后续实验写成已完成结果。
