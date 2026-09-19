# 工业 S5 · RVT 独立保留集(2026-09-19)

目的:S1–S6 矩阵"独立保留集"要求的 RVT profile 落地切片。语料与既有 26 份绑定证据不重叠,全部来自 `test-model/` 本机样本。

## 结果(机器可读:`test-output/industrial-rvt-holdout-20260919/holdout-report.json`)

| 样本 | SHA-256(前缀) | 版本 | 状态 | 容器级事实 |
|---|---|---|---|---|
| racbasicsampleproject.rvt | bc547fe9… | **2026** | unsupported-version(fail-closed) | 声明元素 8,401;严格材质名 820;楼层名 4 |
| rmebasicsampleproject.rvt | (见报告) | **2026** | unsupported-version(fail-closed) | 声明元素 28,132;严格材质名 724;楼层名 5 |
| rstbasicsampleproject.rvt | (见报告) | **2026** | unsupported-version(fail-closed) | 声明元素 13,936;严格材质名 763;楼层名 4 |
| ~~B示例模型.rvt~~ | 8087a360… | 2017 | **剔除**:SHA-256 与 asset.bim.bimface-demo-1 完全一致(同文件改名),不构成独立样本 | — |

## 两个实质发现

1. **版本覆盖缺口被独立语料证实**:能力分层澄清(2026-09-19 对照上游核实):vendored rvt-rs 0.1.2 的 **2016-2026 覆盖是容器/分类层**(11 个版本流与 schema 分类已验证);我们的缺口在 **ElemTable 分区记录层**——探针只对已证明的 2024 40 字节形态做确定性再推导,'2024 之外不猜布局'是纪律而非缺陷。本次 3 个独立 2026 样本在分区层正确 fail-closed,容器级统计照实拿到。**RVT profile 升 productionReady 的硬前置 = 2026 ElemTable 分区布局逆向**(已列独立车道)。

**2026-09-19 深夜突破(观察→逐行验证)**:给探针加装布局观察器后,发现 2026 样本的 ElemTable framing 与已证明 2024 形态**逐字节同构**——racbasic 8401/8401 行、rmebasic 28132 行全部 40 字节 stride、id 主偏移 16/副偏移 36。据此把探针的 ElemTable 门从"按版本号拒绝"升级为"逐行字节不变量验证"(验证的是字节不是版本号),2026 的 ElemTable 段已诚实升级为 measured(framing source 明确标注本文件逐行验证;证据 test-output/industrial-rvt-observe-20260919-r3/)。**2026 缺口收窄为仅剩 partition-element-records 记录形态层**(库门 supports_revit_version 维持不变,独立把关)。
2. **剔重纪律的价值**:候选样本 1/4 是已知资产的改名副本——保留集不剔重就会拿旧语料冒充独立证据。SHA-256 比对应作为所有保留集构建的强制步骤。

## 边界

本保留集只证明版本覆盖缺口与容器级事实,不构成 RVT profile 生产化认证;上游证据(`evidence.json`)含 rvt-rs 离线构建、5 项单测、双跑确定性。生成脚本:`scripts/fixtures/write-rvt-holdout-report.mjs`(幂等,可重跑)。

**2026 分区记录观察结果(r1)**:在 racbasic 2026 样本(1 个 Partitions 流、107,689,125 字节 inflate)上，用已证明 2024 的 `decode_at` 逐偏移只读观察：ElemTable 声明 8,401 个 ID，裸流中可疑 ID join 候选 6,188(73.66%)，但 2024 记录形态完整解码数为 **0**，类别计数为 0。结论档位 = **c) 记录形态未证/存在重写或边界差异，保持 fail-closed**；不能把 73.66% 候选当实例支持。已保留观察证据:`test-output/rvt2026-record-observe-20260919-r1/`。下一步不是放宽门，而是针对 2026 的 marker/字段偏移和跨压缩 chunk 边界做专门逆向；这项大于今晚的轻量切片,继续列为 S5 深水任务。
