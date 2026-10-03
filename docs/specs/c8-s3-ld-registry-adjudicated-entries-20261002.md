# C8-S3 LD registry 裁定条目落位（2026-10-02）

Owner 行：C8-S3 / I-C8（「材质/灯光数学真实消费与完整链分批对拍；直渲 ACES 不再重复」）。本刀是该行可独立闭合的 CPU 收口切片：把 root 已裁定的 LD-16/LD-17 与 LD-15 修订落进 J3-D 聚合器的合法差异矩阵（LD registry）。**无 GPU、无 cargo、无帧时测量、未 commit/push。**

## 现状核查（六步，2026-10-02 实测）

| 六步 | 已有（不重建） | 真实缺口 |
|---|---|---|
| 源与未跟踪文件 | LD registry 唯一载体 `scripts/lib/j3DFullLayerMatrix.mjs` 现有 LD-01–LD-15 共 15 条；`registerLegalDifference` 有撞号/未知层/证据存在性门；工作区已有他线的合同修复（normals 收据、空格拒绝、生产源 SHA 校验，与本刀互补不冲突） | 全仓 grep `LD-16`/`LD-17`：引擎 src/lab/scripts/apps 零命中——root 裁定**未落进代码**；LD-15 rule 仍是已废止的「邻域符号混合」旧表述 |
| 契约 | `registerLegalDifference` 七必填字段、`LD-\d{2,}` 格式、status 枚举、`docs\|packages\|scripts` 前缀证据存在性校验 | 条目登记必须走该合同；`test-output/` 前缀证据不被自动校验，需测试显式断言存在 |
| 依赖 | node:test / node:assert / node:fs 已在用 | 无新依赖 |
| 消费方 | `scripts/j3-d-full-layer-matrix.mjs` 经 `aggregateLayerMatrix` 间接消费；`aggregate.legalDifferenceMatrix` 引用同一冻结数组；runner 自身无条数/LD 断言（grep 证实）；lab `j3DFullLayerMatrix.ts` 无 LD matrix 副本 | 仅测试文件需同步 15→17 |
| 测试与证据 | 聚合器测试基线 11/11 绿；裁定依据证据全部在盘：`test-output/c8-eight-channel-convergence-20261002/{progress-02-attribution,progress-04-fresh-closure,consumed-mrt}.json`、`gpu-far-output/evidence.json`、`test-output/c8-input-chain-20261001/conclusion.json` | 测试未覆盖裁定条目；无 LD-16 撞号负例 |
| 规格 | 已读：`c8-ld16-ld17-adjudication-20261002.md`（root 裁定）、`c8-eight-channel-convergence-20261002.md`（8 通道归因+GPU 定向验证+fresh 闭环）、`c8-full-chain-closure-audit-20261001.md`、S3a/S3b/S3c 三切片规格、`c8-source-observer-fix-20261002.md`、61 行状态审计（C8 行 status=open, currentFresh=false） | — |

**同族排查**：LD-15 旧 rule 的「邻域符号混合」必要条件已被 owner 审计证伪（远斜 (198,64) 邻域 11 正/0 负/7 零，非混合）；裁定以 LD-16「全域符号混合+D 尖峰邻域增益解释」替代并保持 LD-15 原始适用域登记。全仓无其他断言矩阵条数或复制 LD 条目的文件（`c8-source-observer-fix-20261002.md` 第 71 行「LD-15 为 diagnostic、无 HDR 阈值豁免」的陈述与本刀落位兼容）。

## 实施

`scripts/lib/j3DFullLayerMatrix.mjs`（叠加在工作区既有合同修复之上，不回退任何已有 hunk）：

1. **LD-16 登记**（status=diagnostic）：直射 GGX 主瓣区双后端 fp32 算术调度差（点积 ≤4–6 ULP）× D 尖峰（denom≈1.6–2.0e-3）× D3D RTZ 存储。rule 采纳裁定全部四判据：(1) 数值源同源 ≤1e-7 相对；(2) 阶梯形态+RTZ 格点邻近 <1 step（F32 差 ≤1.5 ULP）；(3) 输入差 ≤6 fp32 ULP × D 灵敏度覆盖输出差；(4) 全域符号混合。显式效力边界：系统性 >1.5 ULP F32 同号差不得援引；**仅作归因，不构成 .002 门豁免**。
2. **LD-17 登记**（status=diagnostic）：后端 ddx helper-lane 关联差 × geometryRoughness（deep 0.088566518 vs three ≈0.0808–0.0823）→ 粗糙金属连贯区 ≤10 half-ulp@0.26。rule 四判据 + shader 语义层不可修（候选 A GPU 实测 6225 改善/6125 恶化零净修复、候选 B no-op）+ 后端行为变化（驱动/Chrome 升级）须重验条款 + 不豁免声明。
3. **LD-15 rule 修订**：废止「局部 3×3 邻域符号混合」必要条件，替换为全域符号混合 + D 尖峰邻域增益解释；跨域引用以 LD-16 为准；evidence 追加裁定文档。status 保持 diagnostic、原始适用域（point/spot 高光峰）不变。

`scripts/lib/j3DFullLayerMatrix.test.mjs`：

- 矩阵断言 15→17；新增「LD-15 修订与 LD-16/LD-17 登记」合同测：LD-15 rule 必含全域混合/废止/LD-16 引用且不再以局部 3×3 混合为必要条件；LD-16/17 status=diagnostic、必含「不构成 .002 门豁免」、rule 含 (1)–(4) 编号判据、LD-16 含效力边界、LD-17 含重验条款；两裁定条目的全部 evidence 文件（含 `test-output/` 前缀）存在性断言。
- `registerLegalDifference` 示例条目 LD-16→LD-18（撞号清理，同族排查项），并新增负例：已登记的真实 LD-16 再次追加被撞号门拒绝。

条目数字全部取自裁定文档与 `progress-02-attribution.json` 机读 verdict（near=fp32 调度×D 尖峰×RTZ、far=helper-lane×geometryRoughness、候选 A 已 GPU 否证、strict-emissive byte-equal），未自行改写任何判据数值。

## 验证与证据

- 聚合器合同测试 12/12 绿（基线 11 项 + 新增 1 项，改写 2 项）：`node --test scripts/lib/j3DFullLayerMatrix.test.mjs`，落盘 `test-output/c8-s3-ld-registry-20261002/test-output.log`。
- runner 语法：`node --check scripts/j3-d-full-layer-matrix.mjs` 通过。
- 基线核验：改动前 11/11 绿；14 个裁定引用证据文件存在性逐一核验（14/14 OK）。

## 边界与诚实条款（未做/不改）

- **质量门 RED 维持，qualityCertified=false 不动**：裁定效力为 diagnostic 归因，最终批准权留用户；本刀不豁免任何门、不提升双端方案。
- **无 GPU 对拍**：本切片是裁定条目的 registry 落位，无新的 GPU/像素证据；不重复 c8-s4 已验 parity 与 8 通道归因专线的 GPU 定向验证。
- `docs/specs/jc-i-continuation-20261001.md` 的 LD 记录回填属 root 专用，未碰。
- 工作区中他线的未提交修改（含本文件既有合同修复 hunk）原样保留，未 commit/push/reset/stash。
- 视觉评分：本切片纯 CPU 合同变更，无视觉输出，十维视觉评分不适用（按 skill 诚实条款如实声明，不以想象分充数）。
- LD-16/17 效力仅限裁定文书的四判据域；未来任何新增超门通道须逐通道重新满足全部判据，本 registry 只提供登记与撞号/证据守卫，不做自动豁免。
