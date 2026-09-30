# J2-B4 多物理设备矩阵与完整场景帧时 —— CPU 侧准备

日期：2026-10-01。本切片只交付 CPU 侧可验证部分：设备/后端矩阵声明与展开、证据校验骨架（含负例）、完整场景帧时计量方案。GPU 实跑全部留给主线程串行执行，本切片未运行任何 GPU。

## 现状核查（六步）

| 六步 | 已有（不重建） | 真实缺口 → 本切片交付 |
|---|---|---|
| 1. 源码与未跟踪 | 检索 packages/apps 与未跟踪文件：`j2CsmTimingProbe/Resources/Source`、`j2CsmBoundaryGpuProbe`、`j2-csm-timing-parity.mjs`、`j2CsmTimingParity.mjs`、`benchmarkSampleSchema`、`benchmarkWindowComparison` 均已在用；本次新增文件与在途 J3 纹理/B5/HDR 文件无交集。 | 设备矩阵只有散落的 `adapter`/`adapterInfo` 字段，没有"行×宿主"的声明与校验骨架。 |
| 2. 契约层 | `benchmarkSampleSchema.ts`（SampleWindow/unavailable 必须带原因/禁止伪零）、`benchmarkWindowComparison.ts`（≥5 成对窗）、`shadows/types.ts`（TS 624B/1–8 级）、native 336B/2–4 级 ABI。 | 无跨设备矩阵合同；新增 `fixtures/j2-b4-device-matrix-v1.json`（`deep-engine.j2-b4-device-matrix.v1`），不改动既有 ABI/SampleWindow。 |
| 3. 依赖 | node:test、esbuild、Playwright/Chrome、wgpu 30 已在用。 | 零新增依赖。 |
| 4. 消费方 | receiver 函数级计时入口 `node scripts/j2-csm-timing-parity.mjs`（每宿主 960 样本，五成对窗）已由主线程跑通；native `GpuContext.adapter_info`、Web `DeviceSession.adapterInfo` 是现成设备身份来源。 | 两个宿主 receipt 各自携带身份，但没有交叉校验与"单机不得宣称跨设备"的机器判定。 |
| 5. 测试与证据 | `test-output/interrupted-0930/csm-timing/evidence.json`：passed/timingComplete/currentRun 全 true，inactive 两负载双宿主 P95 差区间为负、blend-uniform 跨零。 | 全部为单 RTX4060 Laptop 证据；无第二台设备、无完整场景帧时。 |
| 6. 规格与台账 | `j2-b4-current-state`、`j2-b4-linear-native`、`j2-b4-timing-followup-audit`、remaining 估时表、恢复台账 0930 各节已读。 | 估时表 J2-B4 剩余即"多物理设备矩阵与完整场景帧时"，与本文对应。 |

**已有（不重建）**：三族生产 CSM 采样、共享混合核 `cascadedShadowMath.wgsl`、七点/linear 边界门（`f848945e`）、receiver 五成对 GPU 窗计时、SampleWindow/compareBenchmarkWindows 统计口径、T00 车间三档 fixture 与 `competitiveBenchmarkRunner` 全帧链。

**真实缺口**：多物理设备矩阵（声明/展开/校验）与完整场景帧时方案；GPU 侧执行不在本切片。

## 交付一：设备/后端矩阵（CPU 侧完成）

### 矩阵清单（fixture：`packages/deep-engine/fixtures/j2-b4-device-matrix-v1.json`）

| 维度 | 值 |
|---|---|
| 设备行（物理 GPU） | `rtx4060-laptop`（declared vendor=nvidia / architecture=lovelace；当前唯一可用行）。新设备在 `devices` 追加行即可，骨架不改。 |
| API 宿主 | `web-chrome-webgpu`（Chrome/Dawn）、`native-wgpu-vulkan`、`native-wgpu-dx12`、`native-wgpu-gl`（wgpu 三后端）。 |
| CSM 采样族 | `ts-built-in` / `ts-deepsl-package` / `native-production-wgsl` 三族不变。 |
| 宿主级联数差异 | 保留：TS 内建 1–8 级（624B），DeepSL/native 2–4 级（336B）。矩阵只对齐共同两级输入，不升 ABI。 |

### CPU 骨架与命令

- `scripts/lib/j2DeviceMatrix.mjs`：`parseDeviceMatrix`（fixture 形状校验，非法即抛）、`expandDeviceMatrix`（行×宿主展开，期望值结构：case 数/21 点/5 窗/16 样本、身份要求）、`parseNativeAdapterInfo`（wgpu `AdapterInfo` 调试串→结构化身份）、`validateDeviceMatrixEvidence`（纯 CPU 证据校验）。
- `scripts/j2-b4-device-matrix.mjs`（纯 CPU，已跑通）：
  - `node scripts/j2-b4-device-matrix.mjs` —— 展开 + 空-证据自检（空证据必须 matrixComplete=false），写 `test-output/j2-b4-matrix/expansion.json`；
  - `node scripts/j2-b4-device-matrix.mjs --validate <receipts.json>` —— 校验主线程 GPU 实跑落盘的 receipts；不完整退出码 1，写 `validation.json`。
- 校验规则（全部有负例测试锁住，`scripts/lib/j2DeviceMatrix.test.mjs` 10 项全绿）：
  1. receipt 身份必须匹配声明行（web：vendor/architecture 大小写不敏感、`isFallbackAdapter=true` 拒绝为软件渲染；native：backend 必须落在宿主 token 内、name/pciBus 必须可解析）；wgpu 调试串解析不出 name 即拒。
  2. fixture/plan 哈希必须与当次一致（漂移→invalid）；宿主 errors 非空或 passed≠true→invalid。
  3. case 矩阵逐条核对（未知 case、21 点缺失、maxError>2e-6、非 5 窗、零量化样本、timestamp unavailable）逐项 invalid。
  4. `status:"unavailable"` 的宿主 receipt 使该行显式 unavailable（不计 passed），矩阵必不完整，原因逐字保留。
  5. 重复 (row,host)、未声明行、行未覆盖的宿主在结构层直接抛错。
  6. 物理身份按宿主命名空间去重（native=`name@pciBus`、web=`vendor/architecture`）；**CPU 无法跨 API 证明两宿主同物理设备**——同机双宿主归同一行是声明事实不是推导事实，`physicalIdentity.note` 逐字写明；两行声明不同但 native 身份同键时物理键合并、不得灌水设备数。
  7. 空 receipts / 缺行 → `matrixComplete=false`，runner 退出码 1（已实测）。

### GPU 实跑（主线程串行，本切片未执行）

1. 每台设备上先跑既有 receiver 函数计时（同机两 API 宿主）：

   ```text
   node scripts/j2-csm-timing-parity.mjs          # Chrome + cargo --ignored，各 960 样本
   ```

2. 把两宿主 `web.json`/`native.json` 的字段折算成矩阵 receipts（rowId=声明行、host、`adapter`、`fixtureHash`、`planHash`、`passed`、`errors`、`results` 原样），落一个 receipts JSON 后：

   ```text
   node scripts/j2-b4-device-matrix.mjs --validate <receipts.json>
   ```

3. Native 侧后端变体（DX12/GL）在对应设备上用既有具名测试 `j2_b4_actual_native_csm_timing` 的环境变量/后端选择执行后重复第 2 步；`--compare` 模式明确 currentRun=false，不当当次门。
4. 跨设备比较纪律（沿用 timing-followup-audit 口径）：GPU 绝对耗时只在同宿主内比较优化前后；不同宿主各自报告 p50/p95 与成对差区间；单台设备补齐不等于矩阵完成，`matrixComplete` 只认声明行全覆盖。

## 交付二：完整场景帧时计量方案（CPU 侧定义，GPU 待主线程）

### 冻结场景定义

- 场景：T00 多资产车间（`lab/factoryWorkshop.ts`，8 类资产、bay 确定性布局），三档实例数 1,000/5,000/10,000，fixture SHA-256 冻结（10k 档 `64e1526b…4c0`，见 `docs/reports/deep-core/T00-s1-workshop-fixture-2026-09-27.md`）。
- 轨迹：`fixture.factory.workshop-tour-20s`（`fixtures/benchmark-assets/trajectories-v1.json`，20s 环绕+推拉+俯仰，loopClosed×3 已证）；长稳相位按既有 600 帧一圈循环回放，避免画面冻结。
- CSM 因子：同 fixture × {生产 CSM 默认, 关闭阴影} 两配置，回答"CSM 生产设置对全帧的影响"；不得从 1024×512 receiver 微测量外推 FPS。

### 帧时采集点（全部复用既有通道，零新采集设施）

| 通道 | 采集点 | 归属 |
|---|---|---|
| `cpu-frame` | `performance.now()` 包夹 `backend.render()`（warmup 20 / cpu 90 帧） | `competitiveBenchmarkRunner` 现有 |
| `gpu-timestamp` | 每帧序列化时间戳（Deep=`GpuTimer` 有界异步查询；Three=`WebGPUTimestampQueryPool`），单位 ms | 现有，`pairedTimestampSupport` 门 |
| `frame-interval` | 长稳相位帧间隔（含调度让步），30 分钟墙钟上限 60 | 现有 `longRunMinutes` |
| 上传/资源 | `upload`/`cpu-submit` 通道按 `benchmarkSampleSchema` 记录；unavailable 必须带原因，禁止伪零 | 现有 schema |

### 统计口径

- 分位数用既有 `summarize()`：最近秩法（`sorted[ceil(p*n)-1]`），报告 p50/p95/p99；≥5 轮成对、奇偶轮交换执行顺序（`validateOptions` 已锁下限）。
- 公平基线关系：沿用 T11 既有 Deep-vs-Three 配对判据（`cpu/gpu-frame-p95-ms` 回归分数 0.05、`visual-similarity` ≥0.92 绝对下限，相似度 0.968 首过线的那条链）；J2-B4 的增量判据是 **CSM-on/off 的同机同宿主成对 P95 差区间**（`compareBenchmarkWindows`），跨宿主/跨设备只各自报告、不做绝对值换算。
- 每轮证据必须携带：设备身份（web `adapterInfo` / native `AdapterInfo`）、lab 构建 SHA-256、fixture/轨迹哈希、`deviceErrors` 空与非空如实记录。

### GPU 实跑命令（主线程）

```text
pnpm --filter @bim-studio/deep-engine lab:build
pnpm --filter @bim-studio/deep-engine lab:serve   # benchmark 页选 FactoryWorkshop × 档位 × CSM 开关
```

配对轮次与长稳由 `benchmarkMain.ts` 现有 UI/参数驱动；结果 JSON 落 `test-output/` 后按上节口径归档。

## 本切片验证（CPU，已全部跑绿）

```text
node --test scripts/lib/j2DeviceMatrix.test.mjs   # 10/10 passed
node scripts/j2-b4-device-matrix.mjs              # 展开 + 空证据自检通过
```

`--validate` 双向退出码已用带真实 fixture/plan 哈希的骨架自测 receipt 验证（完整=0、陈旧身份=1），自测文件验后即删，未留任何伪 GPU 证据。

## 范围与诚实声明

- 本切片未运行任何 GPU；矩阵 completeness 当前只能对声明行给出 `missing`，这是事实不是缺陷。
- 单机双 API 宿主不构成跨设备完成；native DX12/GL 行在当前机器未测。
- 完整场景帧时未测；CSM-on/off 全帧差、多设备 P95、长稳 p99 全部留主线程，命令与判据如上，不许事后改口径。
- `native-wgpu-dx12/gl` 宿主 token 依据 wgpu `AdapterInfo.backend` 调试串；若上游输出形态变化，`parseNativeAdapterInfo` 的负例会先失败，属于预期防护。
