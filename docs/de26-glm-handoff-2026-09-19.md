# DE26 资产 / readiness：GLM 可直接执行交接

## 目标

这是 DE26 完整交接，不只是资产 readiness。目标是沿既有任务卡把工程数据编译、运行时、Unity 对标、灯光/GI/材质、动画、工业场景、V11/V13 场景子切片和 readiness 收口；当前最先可直接实现的是第 8 项资产/readiness，但不能把它误写成 DE26 全部范围。

完整范围来自：

- `docs/specs/de26-high-value-scope-2026-09-17.md`
- `docs/specs/de26-reality-compiler-priorities-2026-09-18.md`
- `docs/specs/de26-unity-lighting-parity-2026-09-18.md`
- `docs/specs/deep-engine-execution-tasks-2026-09-16.json`

用户确认的 DE26 主线是：V1–V7 做扎实，V8 小而强，V9/V10/V11/V13 按真实场景补齐，V12 不做。

## 完整能力地图

| 组 | DE26 任务 | 当前应检查的交付 |
|---|---|---|
| A | A01–A04、A08 | Three/Babylon/Unity 统一基准、真实资产、跨端和可复现证据 |
| B | B01–B08 | 场景事务、执行图、GPU 预算、资源账本、质量策略 |
| C | C01–C08 | 资产/材质/实例/透明、场景搭建、来源追踪与质量报告 |
| D | D01、D04–D06 | 空间索引、大坐标、重基点、分区预取、LOD/meshlet |
| E | E01–E08 | 色彩/单位、多灯、GI、反射、材质受光、阴影和双端交付；Unity 只作对标，不作运行依赖 |
| F | F01、F04、F05 | 正式动画包、物理宿主、工业机械约束 |
| G | G01–G08 | 二维/三维数据一致、数据版本、标注和信息牌 |
| H | H02–H04、H07、H09 | GPU 诊断、Profiler、材质调试、原子回滚、受限 agent 事务 |
| I | I04、I05、I07 | 混合园区、双骨 IK、可复现故障包 |
| V | V1–V7、V8、V9、V10、V11、V13 | Reality Compiler 能力、真实灯阵、材质语义、场景拖拽搭建、数据驱动信息牌 |

V12（扫描现场对照/Splat）明确不建设。历史删除的 A05–A07、V01–V05 等不应重新计入 DE26 分母。

## Unity 对标口径

不是“有基础光照就算完成”。至少要逐项检查：多灯与灯/对象影响层、投影/接影、CSM/点光/聚光阴影、静态/动态 GI、反射探针、金属/粗糙度/法线/玻璃材质、实例/LOD/动画模型受光，以及作者→保存→发布→Web/Native 离线重开的一致性。功能、视觉、性能必须分别有证据；不能用 AO/Bloom/自发光冒充 GI，也不能用截图替代运行包证据。

权威入口：

- `docs/specs/de26-asset-readiness-2026-09-18.json`
- `docs/reports/de26-asset-readiness-2026-09-18.md`
- `test-output/de26-local-assets-readiness-20260918/readiness.json`
- `scripts/prepare-de26-local-benchmarks.mts`
- `scripts/inspect-de26-local-benchmarks.mts`
- `packages/deep-engine/src/benchmarkReadiness.ts`
- `packages/deep-engine/src/benchmarkSampleSchema.ts`

## 当前已确认能力

- manifest v1、资产唯一身份、源字节数/SHA-256、轨迹合同、缓存声明、许可边界已有校验。
- 当前本地清单有 5 份资产，均可复算来源 hash。
- 已有负载类：`heterogeneous-bim`、`far-origin-campus`、`dynamic-workcell`，以及现有 baked scene / BIM 任务夹具。
- 已有派生 packet 统计，但仅描述本地 glTF 派生件：`LocalBim` 为 651 geometries / 651 instances；`LocalPreheater` 为 204 geometries / 213 instances。不要把它们写成 RVT 源统计。
- V11 `fence_gate.glb` 已有 grounded 派生件，但真实拖放、插入、保存、刷新、重开仍属于第 ③ 项，不在本任务内伪造关闭。

## 现有硬缺口

readiness 当前应继续为 `blocked`，原因必须保留：

- 缺负载类：`factory-instances`、`mixed-dashboard`、`appearance-showcase`。
- 缺任务类型：`animation`。
- `asset.bim.bimface-demo-1` 与 `asset.bim.snowdon-towers-arch` 缺精确 `triangles/materials/meshes/textures/bounds`。

## 当前可独立完成的实现切片（本次 GLM 先做）

按以下顺序做，优先完成前两项：

1. **readiness 诊断增强**：为缺失 load class、缺失 task kind、缺统计字段输出稳定的 machine-readable reason/code；保证同一输入的 JSON 无时间戳和随机字段。
2. **三类负载的真实 manifest/fixture 接口**：如果本机或仓库已有可授权素材，补 `factory-instances`、`mixed-dashboard`、`appearance-showcase` 的 manifest 与任务引用；若找不到真实素材，只实现 schema/fixture contract 和明确 `unverified`，不要生成假资产。
3. **animation task contract**：补一个离线、确定性的 animation trajectory/task schema，引用真实 dynamic-workcell 资产；必须通过现有 identity/hash/trajectory 门禁。
4. **RVT 统计接入**：仅在已有本地解析链能输出 exact stats 时接入；解析失败就写清失败来源和下一步，保持 `unverified`。禁止用 RVT 文件大小、三角形估算或 glTF 派生件替代。
5. **报告与交接同步**：更新 `docs/reports/de26-asset-readiness-2026-09-18.md`，并把每项变化同步到 `docs/active-task-recovery-ledger.md`、`docs/codex-mainline-handoff-2026-09-19.md`。

完成上述切片后，若继续推进 DE26 全范围，优先顺序是：C07/C08 来源与变更链 → B03/B05 运行预算 → G06 数据版本 → E02/E03/E05 灯光/GI/阴影 → F01 动画 → H02/H09 诊断和受限事务 → V11/V13 场景子切片。不得只补 readiness 就宣称 Unity 对标完成。

## 验收命令

```powershell
pnpm exec vitest run --root packages/deep-engine src/benchmarkReadiness.test.ts
pnpm --filter @bim-studio/deep-engine typecheck
pnpm exec tsx scripts/prepare-de26-local-benchmarks.mts test-output/de26-local-assets-readiness-20260918
pnpm exec tsx scripts/inspect-de26-local-benchmarks.mts test-output/de26-local-assets-readiness-20260918
node scripts/verify-mainline-closure.mjs
```

若新增测试，使用同一 `--root packages/deep-engine` 方式，避免仓库 `test-output` 快照被 Vitest 当成重复测试树。

## 交付格式

完成后回报：

1. 修改的文件；
2. 新增的 schema/fixture/校验行为；
3. 精确测试命令及通过数量；
4. readiness 状态和每个 reason 的变化；
5. 仍然缺失的真实资产或源级统计。

## 禁止事项

- 不下载或提交客户/私有模型；入库素材必须记录来源、hash、授权边界和格式版本。
- 不把 V11 派生件当成产品验收。
- 不把 `preview` / `inspect` 当成 `productionReady`。
- 不修改第 ①–⑦ 项的状态来制造整体通过。
- 不删除 `blocked` / `unverified` reason 以让 JSON 变绿；只有权威证据消除缺口时才改变状态。
