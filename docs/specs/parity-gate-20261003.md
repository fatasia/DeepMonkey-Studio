# three ↔ Deep(WebGPU) 像素一致性门（2026-10-03）

目标：把 `c8-shared-scene-parity` 声明"排除"的范围（完整 BRDF、纹理/透射/透明、IBL/后处理、阴影）补成可进 CI 的 three↔Deep 像素对拍门，对标 Unity/UE/Babylon 的渲染一致性回归。不改生产渲染代码，只加门与 lab probe；真实渲染差距如实记录。

## 现状核查（前置）

### 已有（不重建，直接复用）

| 能力 | 位置 | 本门如何复用 |
|---|---|---|
| 同一作者根经正式投影桥进 Deep、three 并排渲染的整套基建 | `packages/deep-engine/lab/c8SharedScene{Fixture,Probe,Readback}.ts`、`scripts/c8-shared-scene-parity.mjs` | 沿用 `sharedProjection()`（ThreeProjectionBridge）、`DeepWebGpuBackend.create/sync/render`、`readSharedDeepFrame`（正式 HDR 快照 + 真实 swapchain 字节）、`bounded`、fresh-realm 双轮稳定性、源码/bundle SHA 取证 |
| 显示合约单一来源 | `packages/contracts/src/displayContract.ts` `DEFAULT_DISPLAY_CONTRACT` | 曝光 1.05、`three-aces-r185`、sRGB、阴影 2048/bias/normalBias/radius、bloom 强度/半径/阈值、环境强度全取合约，不 hardcode |
| 生产光照/阴影投影 | `apps/web/src/viewer/studioDeepEnvironmentLights.ts` `projectStudioDeepLights`、`studioDeepDirectionalShadow.ts`、`sceneShadowQuality.ts` | 阴影场景用与产品完全相同的 three 灯 → Deep `authored shadow` 映射 |
| three 侧产品后处理链 | `apps/web/src/viewer/postProcessingRuntime.ts`（RenderPass→UnrealBloom→SMAA→OutputPass） | AA+Bloom 场景的 three 侧按同链重建 |
| 像素度量工具 | `scripts/lib/pixelParity.mjs`（分块 SSIM）、`scripts/lib/j3DisplayParity.mjs`（先例） | SSIM 直接用 `computeBlockSsim`，不新增依赖 |
| Deep 侧引擎能力 | radiance-hdr 预滤波 IBL、authored 方向光阴影、`authorBloom`、`spatialAa`、加权 OIT 透明 | 全部走正式 `PbrRenderer`，不加测试专用路径 |
| 对拍先例（与本门互补，不重复） | `c8-three-output/-material-math/-direct-display/-ggx-visibility-parity`（算子级）、`j3-display/bloom-texture/shadow-visibility/normal-shadow-parity`（Deep↔Deep/Native 或 fixture 级）、`e2-z4-visual-regression`（全页面） | 这些不是"同一场景 three 渲染 vs Deep 渲染"的整帧门 |

### 真实缺口（本次补上）

1. `c8-shared-scene-parity` 只严格覆盖自发光 HDR 与输出算子，直射 BRDF 仅诊断；`excluded` 明文排除 完整 BRDF 等价 / 纹理·透射·透明 / IBL·后处理 / 阴影。
2. `benchmarkImage.ts` 的 0.92 感知分只是基准口径，不是 three-vs-deep 严格像素门（见 `display-contract-unification-20261003.md` 缺口）。
3. 没有统一的"分级阈值 + 已知缺口基线 + 回归守卫"框架：现有 parity 要么全过要么只出数。
4. 没有 CI 入口：无 GPU 时是否 fail-closed 无统一约定。
5. `omission-audit-20261004.md` 的 "aniso/transmission IBL split-sum 消费（核已有，补 IBL 分支+双端对拍）"、C8 qualityCertified RED 等条目依赖这类整帧证据。

### 已知前提（核查中发现，影响门的设计）

- `projectThreeWorldLights`（桥内灯光投影）对方向光 `castShadow=true` fail-closed（只支持聚光灯局部阴影）；方向光阴影在产品里走 `projectStudioDeepLights`。因此阴影场景用产品投影器，不用桥内投影器。
- Deep 方向光 `castShadow` 缺省 = 预览默认**开启**（`worldLights.ts` 注释）。c8 probe 用 `projectThreeWorldLights`（不写 `castShadow`），其 `castShadow=false` 的 three 灯在 Deep 里仍默认投影阴影——c8 场景恰好没有遮挡关系所以未暴露。本门统一走 `projectStudioDeepLights`，显式写 `castShadow:false`。
- `ThreeProjectionBridge` 对扩展 PBR 瓣（transmission/sheen/iridescence/clearcoat/anisotropy/dispersion）任一非中性值整体 fail-closed（`MeshPhysicalMaterial non-neutral extensions`）。

## 设计

- 新增 stage 而非另起炉灶：`lab/parityGateScenes.ts`（场景）、`lab/parityGateThree.ts`（three 侧渲染/读回/后处理链）、`lab/parityGateProbe.ts`（Deep 侧 + 编排，复用 c8 的投影桥/读回/`bounded`）。c8 自身文件与 `compareSharedScene` 不改，其 evidence 不受影响。
- 画布 320×192、深色、曝光/算子/阴影/泛光参数取合约。
- 度量（`scripts/lib/parityGateMetrics.mjs`，纯函数，带单测，ΔE2000 用 Sharma 参考对校验）：
  - RMSE：整帧 RGB8；`byteMax`：RGBA 最大绝对字节差；`over8/over32Fraction`：像素最大通道差超阈占比；
  - 色差：sRGB(D65)→CIELAB，**同时给 CIEDE2000 与 ΔE76**（均值/p99/max）；
  - SSIM：亮度（0.2126/0.7152/0.0722）20×16 分块 SSIM（`computeBlockSsim`）均值/最小；
  - 线性域：有 HDR 读回的场景给 `hdr.rmse / max / relativeRmse`；`lumaBias`（Deep−three 亮度均值差，解释偏亮偏暗）；`coverage`（任一侧非黑像素数，拦截"两边都画空帧"）。
- 分级阈值（`PARITY_TIERS`，全部满足才算该档）：

| 档 | RMSE | ΔE00 均值 | ΔE00 p99 | SSIM 均值 | 含义 |
|---|---|---|---|---|---|
| 严格 strict | ≤ 1.5 | ≤ 0.5 | ≤ 3 | ≥ 0.995 | 实现级等价（肉眼不可辨） |
| 容许 tolerant | ≤ 6 | ≤ 2 | ≤ 10 | ≥ 0.97 | 视觉等价（并排可辨但无质量缺陷） |
| 诊断 diagnostic | — | — | — | — | 仅记录；受回归守卫约束 |

- 判定（`evaluateParityRun`）：场景集合必须与声明完全一致；`coverage ≥ minCoverage`；实测档位 ≥ 声明 `expectedTier`；并且不得超出相对**已提交基线**的回归守卫（RMSE/ΔE00 均值/p99/over8 超 `基线×(1+10~15%)+绝对余量` 或 SSIM 下降 >0.005 或 HDR 相对 RMSE 恶化即失败）。已知缺口场景 `expectedTier=diagnostic`、阈值=当前基线+守卫；若实测档位**高于**声明，门输出 `ratchet` 提示要求上调声明，防止基线陈旧。
- 稳定性：fresh 页面双轮，两轮全部帧字节必须完全一致，否则失败。
- fail-closed：Chrome 缺失、`navigator.gpu` 不可用、仅有软件 fallback 适配器、任何 GPU validation/OOM/internal 错误或页面异常都会 `exit 1` 并删除旧 `evidence.json`，不会静默通过。

## 场景（5 个标准 + 3 个诊断）

| id | 角色 | three 侧 | Deep 侧 |
|---|---|---|---|
| `pbr-matrix` | 标准 (a) | 2×5 球：电介质（红）/金属（金）× 粗糙度 .1/.3/.5/.7/.95；主光 + 冷色背光，无环境 | 同根，`environment:false`，直射光 |
| `ibl` | 标准 (b) | 同矩阵，仅 IBL：同一份 128×64 线性 HDR 全景（含太阳盘 14×、橙色方位标记）→ `PMREMGenerator.fromEquirectangular` | 同一份 `Float32` 作 `radiance-hdr` 预滤波（生产默认 128/32/128） |
| `directional-shadow` | 标准 (c) | 地面 + 球/方块/细柱，方向光 `castShadow`，`configureDirectionalShadow` 同款参数：2048、bias −1e‑4、normalBias .015、radius 3、intensity .38、PCFShadowMap | `projectStudioDeepLights` → authored directional shadow（exact 1 级联 2048） |
| `aa-bloom` | 标准 (d) | RenderPass→UnrealBloom(.35/.25/.9)→SMAA→OutputPass（HalfFloat 目标） | `bloom:true` + `authorBloom{strength,threshold}` + `spatialAa:true` |
| `transparency` | 标准 (e) | 3 个 alpha .45 玻璃球（`transparent`、`depthWrite:false`）叠 4 根不透明背板；three 默认排序混合 | 加权 OIT（BLEND） |
| `ibl-hq`（诊断） | `ibl` 对照 | 同 `ibl` | specular 256 / diffuse 64 / 256 样本，验证 IBL 噪点来源 |
| `bloom-only`（诊断） | `aa-bloom` 对照 | 同场景关 SMAA | 关 `spatialAa`，只剩 Bloom，隔离 AA 与泛光 |
| `transparency-linear`（诊断） | `transparency` 对照 | 先在线性 HDR 目标混合，再 OutputPass（ACES+sRGB） | 同 `transparency` |

另有"扩展 PBR 瓣"机器证据（不需 GPU）：对 transmission/sheen/iridescence/clearcoat/anisotropy/dispersion 各建一个根交给投影桥，必须 `ok:false` 且 `code:"unsupported"`，门以 `lobeGapsStillFailClosed` 守卫（桥将来支持某瓣时门会提示需新增对拍场景）。透射因此只验证 alpha 简化（场景 e）。

## 运行

```
pnpm gate:parity          # = node scripts/gate-parity.mjs；约 2.7 分钟（8 场景 × 2 轮）
pnpm test:parity-gate     # 度量库单测（无 GPU）
node scripts/gate-parity.mjs --calibrate          # 全部场景只出数，写 calibration.json（刷新基线用）
node scripts/gate-parity.mjs --only=ibl,ibl-hq    # 单场景调试（隐含 calibrate，不判定）
```

环境：`BIM_STUDIO_CHROME_PATH`（默认 Windows Chrome 路径）、`BIM_STUDIO_CHROME_ARGS`（空格分隔的额外启动参数）。输出目录 `test-output/parity-gate/`：`evidence.json`、`overview.png`（three / Deep / |Δ|×4 并排）、每场景 `<id>-{three,deep,diff}.png`、`probe.mjs`（bundle）。基线声明在 `scripts/lib/parityGateThresholds.mjs`；刷新流程见该文件头注释。

## 实施结果

环境：NVIDIA RTX 4060（Lovelace，非 fallback），Chrome WebGPU，Windows，深色，320×192，`two fresh rounds identical`。`pnpm gate:parity` 退出码 0；`node scripts/c8-shared-scene-parity.mjs` 仍通过（passed/stable true）。

### 指标表（实测，`evidence.json`）

| 场景 | 档位（实测/声明） | RMSE(0‑255) | ΔE00 均值 / p99 / max | ΔE76 均值 / max | byteMax | SSIM 均值 / 最小 | HDR 相对 RMSE |
|---|---|---|---|---|---|---|---|
| pbr-matrix | strict / strict | 0.258 | 0.02 / 0.51 / 7.8 | 0.02 / 11.6 | 26 | 0.99989 / 0.9837 | 0.0012 |
| ibl | tolerant / tolerant（已知缺口） | 4.730 | 0.77 / 7.72 / 20.0 | 1.00 / 21.1 | 57 | 0.98503 / 0.8326 | 0.243 |
| directional-shadow | strict / strict | 0.092 | 0.02 / 0.87 / 1.2 | 0.01 / 1.9 | 4 | 0.99995 / 0.9982 | 0.0003 |
| aa-bloom | diagnostic / diagnostic（已知缺口） | 6.313 | 0.29 / 5.69 / 66.1 | 0.34 / 69.1 | 178 | 0.99335 / 0.8950 | — |
| transparency | diagnostic / diagnostic（已知缺口） | 13.414 | 2.49 / 27.79 / 34.9 | 3.61 / 45.2 | 84 | 0.97870 / 0.5958 | 0.027 |
| ibl-hq（诊断） | tolerant / tolerant | 4.536 | 0.72 / 7.84 / 19.7 | 0.94 / 20.8 | 57 | 0.98863 / 0.8406 | 0.244 |
| bloom-only（诊断） | strict / strict | 0.183 | 0.05 / 1.03 / 6.1 | 0.04 / 7.5 | 20 | 0.99989 / 0.9982 | — |
| transparency-linear（诊断） | tolerant / tolerant | 1.497 | 0.20 / 8.61 / 14.4 | 0.26 / 14.9 | 20 | 0.99929 / 0.9543 | — |

解读：byteMax/ΔE max 来自轮廓单像素（几何覆盖率差一个像素边缘），所以严格档用 RMSE+ΔE 均值/p99+SSIM 判定，不用 max；max 仍全部落盘。

### 已知缺口与根因（证据均由门内诊断场景给出）

1. **`aa-bloom` = 边缘 AA 算法差异（不是泛光）**：`bloom-only`（两侧都关 AA）达到严格档（RMSE 0.18 / ΔE00 均值 0.05），说明 Deep `authorBloom` 在合约参数下与 three `UnrealBloomPass` 已一致；`aa-bloom` 的差异图只剩高对比轮廓（three SMAAPass vs Deep `spatialAa`）。动作：对齐 Deep spatialAa 与 SMAA，或作者视图换用同一算法。
2. **`transparency` = 混合空间不同（不是着色差）**：three 默认帧缓冲对每个透明片元先 ACES+sRGB 编码再 alpha 混合（显示空间混合）；Deep OIT 在线性 HDR 合成后统一色调映射。`transparency-linear`（three 改为线性 HDR 混合 + OutputPass）降到 RMSE 1.50 / ΔE00 均值 0.20；线性域 HDR 相对 RMSE 仅 2.7% 也印证这一点。表现为 Deep 的玻璃球更亮（lumaBias +4.05）。**需要产品决策**：以线性合成为准（Unity/UE 口径，作者视图透明材质改走 OutputPass），或 Deep 提供显示空间混合开关。透射（transmission）桥层直接拒绝，门只覆盖 alpha 简化。残余 `transparency-linear` p99 ΔE00 8.6 未逐像素归因，推测为加权 OIT 与精确排序混合的近似差。
3. **`ibl` = 预滤波质量/滤波核差异**：同一份 HDR 下 Deep 默认档（128 样本、漫反射 32²）在小而亮的太阳盘上产生橘皮噪点；`ibl-hq`（256/64/256）噪点基本消失（SSIM 0.985→0.9886）。仍有的差异来自 Deep GGX split‑sum 预滤波链与 three PMREM cubeUV 滤波核不同（低粗糙度金属反射最明显，HDR 相对 RMSE 24% 由太阳反射主导）。方位/亮度/太阳位置一致（无朝向错误）。动作：提高默认漫反射预滤波样本或改确定性卷积，或统一同一 PMREM 产物（引擎改动，本任务不做）。
4. **扩展 PBR 瓣（sheen/iridescence/transmission/clearcoat/anisotropy/dispersion）**：投影桥全部 fail-closed，无法进入对拍；`lobeGapsStillFailClosed` 守卫，桥放开后需新增场景。
5. **未覆盖**：纹理采样、各向异性/透射 IBL split‑sum（omission-audit 第 95 行）、多光源/点光·聚光阴影、雾、AO/SSR、动态分辨率、设备丢失、性能。

### 门能拦什么

- 严格场景（pbr-matrix / directional-shadow / bloom-only）任何 BRDF、阴影偏置/PCF、色调映射、泛光回归都会掉出严格档或超基线守卫；
- 已知缺口场景只能不变或变好（超出 基线×1.1+余量 即失败），变好会提示 ratchet；
- 无 GPU / 软件适配器 / 任一 GPU 校验错误 / 空帧 / 场景集合漂移 / 两轮不一致 一律失败。

### 局限与遗留

- 基线来自单一硬件（RTX 4060/Windows/Chrome）；其它 GPU/驱动首次接入需 `--calibrate` 重新标定并在文档登记。
- 8 场景 × 2 轮约 2.7 分钟；CI 如需缩短可在 CI 配置中去掉诊断场景或单轮（会降低稳定性证据）。
- 本任务未触碰引擎/生产渲染；上述 1–3 项属引擎/产品侧修复，修复后门会提示 ratchet，届时上调 `expectedTier` 与基线。
- 发现但未处理：c8 probe 的方向光 `castShadow` 缺省语义（见"已知前提"）——当前 c8 场景无遮挡所以无影响，若扩展 c8 场景需改用 `projectStudioDeepLights`。
- `tsc -p tsconfig.lab.json` 仅余与本任务无关的他人在途文件错误（`src/shader/materialAdvancedReference.ts`）。

## 改动文件

- 新增：`packages/deep-engine/lab/parityGateScenes.ts`、`parityGateThree.ts`、`parityGateProbe.ts`、`parityGateScenes.test.ts`；`scripts/gate-parity.mjs`、`scripts/lib/parityGateMetrics.mjs`、`parityGateMetrics.test.mjs`、`parityGateThresholds.mjs`；本文档。
- 修改：根 `package.json`（`gate:parity`、`test:parity-gate`）。
