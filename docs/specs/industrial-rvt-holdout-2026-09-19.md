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

1. **版本覆盖缺口被独立语料证实**:builtin RVT 读取器已证明的布局上限为 2024(⑧ 车道 BIMFACE 2017/Snowdon 2024);本次 3 个独立 2026 样本全部正确 fail-closed(未伪造解析),容器级统计照实拿到。**RVT profile 升 productionReady 的硬前置 = 2026 布局逆向**,这是 S5 剩余工作里最具体的一块。
2. **剔重纪律的价值**:候选样本 1/4 是已知资产的改名副本——保留集不剔重就会拿旧语料冒充独立证据。SHA-256 比对应作为所有保留集构建的强制步骤。

## 边界

本保留集只证明版本覆盖缺口与容器级事实,不构成 RVT profile 生产化认证;上游证据(`evidence.json`)含 rvt-rs 离线构建、5 项单测、双跑确定性。生成脚本:`scripts/fixtures/write-rvt-holdout-report.mjs`(幂等,可重跑)。
