# DisplayContract 统一显示合约（2026-10-03）

目标：阶段 1 只统一 Deep（WebGPU/WASM/Native 发布路径）与 three 的显示默认值来源，不改 WGSL 算子数学，不新增依赖，不引入首屏体积增长型资源。

## 现状核查

1. **全仓 grep（含未跟踪状态）**
   - 关键词：`tonemap|exposure|toneMapping|three-aces-r185|displayContract|environmentIntensity|shadow softness|PCFShadowMap|PCFSoftShadowMap`。
   - 已有但分散：
     - three 主视图：`apps/web/src/viewer/viewerEngineCore.ts` 写死 `ACESFilmicToneMapping`、`toneMappingExposure=1.05`、`PCFShadowMap`。
     - three 动态曝光：`apps/web/src/viewer/viewerEngineEnvironment.ts` 写死 `0.72 + intensity * weather * 0.33`，夹紧 `0.55..1.55`。
     - web 默认：`apps/web/src/appDefaults.ts` 写死 `environmentIntensity=1`、SMAA/GTAO/Bloom 参数。
     - Deep WGSL：`packages/deep-engine/wgsl/displayColor.wgsl` 已有 `deepAcesFit` 与 `deepThreeAcesFit`，用 `settings.toneMapping > 0.5` 选择；不需要改数学。
     - Deep 引擎默认：`packages/deep-engine/src/webgpu/pbrRendererFeatures.ts` 默认仍是 `deep-aces`，与产品 three 路径不一致。
     - 发布编译：`apps/web/src/delivery/compileSceneRuntimePackage.ts` 只有显式 `displayProfile` 时才写环境载荷；默认发布包不声明 three ACES。
   - `git status` 显示并行会话有大量在途改动；本阶段只触碰显示合同、viewer/delivery/deep display 默认与定向测试相关文件，避开 AI、vite、新场景样例文件。

2. **契约层与公共类型**
   - `packages/contracts/src/scene.ts` 已有 `SceneEnvironmentState.environmentIntensity`、`ScenePostProcessingState`、局部 `SceneLightState.shadowSoftness`，但没有 DisplayContract 或 tone mapping 统一默认。
   - `packages/contracts/src/rendererCapabilityManifest.ts` 只登记能力清单，`tonemap-display` 文案仍写 `deep-aces 默认 | three-aces-r185`。
   - `packages/deep-engine/src/webgpu/pbrRendererFeatures.ts` 已有 `PbrToneMapping = "deep-aces" | "three-aces-r185"`，可复用词汇；`packages/deep-engine` 明确不依赖 `@bim-studio/contracts`，所以产品共享合约放 contracts，Deep 引擎核心保留自己的公共类型。

3. **依赖**
   - `apps/web/package.json` 已固定 `three@0.185.1`、`@bim-studio/contracts`、`@bim-studio/deep-engine`。
   - `packages/deep-engine/package.json` 无 `@bim-studio/contracts` 依赖，且代码内说明本包不依赖 contracts。
   - 本阶段是纯 TypeScript 常量/类型接线，不新增依赖、不新增资源。

4. **消费方**
   - three 消费方：`viewerEngineCore.ts`、`viewerEngineEnvironment.ts`、`postProcessingRuntime.ts`、`appDefaults.ts`。
   - Deep 产品消费方：`StudioDeepWebGpuBridge.ts` 已显式传 `features.toneMapping: "three-aces-r185"`，但不是从单一合约读取。
   - Native/WASM 发布消费方：`compileSceneRuntimePackage.ts` 仅在调用方显式传 `displayProfile` 时落包；默认路径缺少产品显示合约。
   - Lab/benchmark 消费方：`packages/deep-engine/lab/benchmarkProfile.ts` 只记录 0.92 感知分口径，不是严格 three-vs-deep 像素门。

5. **测试与证据**
   - 已有测试：
     - `apps/web/src/appDefaults.test.ts` 验证默认工业视觉基线。
     - `apps/web/src/viewer/postProcessingRuntime.displayOutput.test.ts` 验证 three OutputPass 使用 r185 ACES。
     - `apps/web/src/delivery/compileSceneDisplayProfile.test.ts` 仅验证显式 profile。
     - `packages/deep-engine/src/webgpu/pbrRendererFeatures.test.ts` 验证 feature 默认与显式覆盖。
   - 缺口：没有“three 默认 / Deep 产品桥 / 发布编译载荷都等于同一 DisplayContract”的测试；没有严格 three-vs-deep 像素门。

6. **规格文档**
   - `docs/reports/z1-default-quality-p0-p1-p3-wiring-2026-09-28.md` 记录 Deep authored-shadow 硬合同：带作者阴影时级联数必须 1 且 mapSize 精确匹配；PCFSoftShadowMap 被登记为 WebGL 侧主线项而非该切片。
   - `docs/specs/i-c21-production-hdr-display-20260930.md` 与 `docs/reports/deep-core/I-C21-hdr-display-output-2026-09-29.md` 已覆盖 HDR 输出链，但不是 three/Deep 默认显示合约。
   - `docs/specs/e2-z4-visual-regression-20261003.md` 是全页面视觉回归证据，不含 renderer 端 three-vs-deep 像素门。

## 已有（不重建）

- Deep WGSL 的 `deepAcesFit` / `deepThreeAcesFit` 两个算子和 `toneMapping` 选择通道。
- three r185 OutputPass 片元替换测试。
- Scene 环境强度、后处理状态、局部 shadowSoftness 字段。
- Deep authored-shadow 分配/会话合同与 Z1 阴影档位接线。

## 真实缺口

- 缺一个产品级 `DisplayContract` 单一来源，覆盖 tone mapping、曝光、输出色彩空间、环境/IBL 强度、阴影过滤/bias、AA 与 Bloom。
- three 主视图、three 默认状态、Deep WebGPU 产品桥、发布编译载荷默认值需要从同一合约读取。
- Deep 引擎公共默认应从 `deep-aces` 改为 `three-aces-r185`；`deep-aces` 保留为显式可选。
- 像素级门禁仍缺：当前 lab 只有 0.92 感知评分，没有标准场景和严格阈值的 three-vs-deep 对拍。

## 阴影过滤裁决

本阶段保留 `PCFShadowMap`，不切 `PCFSoftShadowMap`。原因：Z1 报告已记录 authored-shadow 硬合同和 WebGL PCFSoft 属后续主线项；当前任务目标是显示合约统一，不把阴影滤波语义与性能风险合入本切片。合约中显式登记当前产品值为 `pcf`，后续若切 `pcf-soft` 必须配套性能与视觉回归证据。


## 实施结果（2026-10-03）

**核实**：合约已接线项（先前会话完成）——appDefaults（环境强度/GI/SMAA/FXAA/GTAO/Bloom）、viewerEngineCore（输出色彩空间/曝光/阴影滤波）、viewerEngineEnvironment（动态曝光 base/scale/min/max）、sceneShadowQuality（mapSize/radius/blurSamples/bias/normalBias）、postProcessingRuntime（Bloom 参数）、StudioDeepWebGpuBridge / studioDeepEnvironment / pathTraceAuthorPreview / compileSceneRuntimePackage（Deep 显示算子 `three-aces-r185`）；Deep 引擎 `DEFAULT_PBR_RENDERER_FEATURES.toneMapping` 已改为 `three-aces-r185`，`deep-aces` 保留为显式可选。

**本轮补齐（仅 apps/web，deep-engine 零改动、无新依赖、WGSL 未动）**
- 新增 `apps/web/src/viewer/displayContractThree.ts`：合约枚举 → three 枚举的唯一映射（`threeToneMappingFor / threeOutputColorSpaceFor / threeShadowMapTypeFor` 及 `DISPLAY_THREE_TONE_MAPPING / DISPLAY_THREE_SHADOW_MAP_TYPE`）。
- `viewerEngineCore.ts`：删除本地 `THREE_OUTPUT_COLOR_SPACE`，toneMapping / 阴影滤波类型改取映射（此前 `toneMapping` 仍写死 `ACESFilmicToneMapping`、阴影类型内联三元）。
- `studioDeepEnvironment.ts`（作者 tone-mapping 等价校验）、`studioDeepEnvironmentLights.ts`、`StudioDeepRenderView.ts`（阴影滤波兜底）：移除写死的 `ACESFilmicToneMapping / PCFShadowMap`，改取映射。
- 新增 `apps/web/src/viewer/displayContractParity.test.ts`（5 例）：Deep 引擎默认算子/环境强度 = 合约；three 枚举由合约派生；动态曝光在 intensity=1 时等于静态曝光 1.05 且在 [min,max] 内；appDefaults 与方向光阴影参数 = 合约；Studio Deep 投影取合约算子且接受 three 默认。

**校验**
- contracts：`tsc -p .`（dist 已重建）+ vitest 51 文件 / 465 例全绿。
- deep-engine：`tsc --noEmit` 通过；`vitest run src/webgpu` 1825 过 / 5 败（pbrFrameGraph×2、pbrPipelineSet×2、pbrCameraProjection×1，均为并行会话在途的帧图/接触阴影/投影改动，与显示合约无关，相关源文件未被本任务触碰）。
- web：`tsc --noEmit -p .` 0 错误；相关测试 34 文件通过；`StudioDeepWebGpuBridge.test.ts` 2 例失败（帧调度计数 `frames.size`、WebGL 交接），与显示合约无关（并行会话的帧调度改动）。

**遗留**
- Deep 引擎 `bloom/vignette` 能力开关默认仍为 true（仅为分配闸门；Studio 实际启停由 `view.postProcess` 按合约 Bloom=false 驱动）。
- `deep-aces` 在 three 侧无等价算子，映射回落 ACES。
- OptimizerPreview（曝光 0.9）/ParametricModelPreview/resourcePreviewRuntime 为独立预览渲染器，未并入合约。
- 真实 GPU three↔Deep 像素对拍与严格阈值门禁仍未建（沿用前述缺口）。

## 审查修复（2026-10-03，code-review）

- **[Medium] GI 缺省三处不一致**：`viewerEngineEnvironment.ts`、`viewerEngineRig.ts`（原 `?? 0.45`）与 `compileSceneLighting.ts`（原 `?? 1`）现全部取 `DEFAULT_DISPLAY_CONTRACT.environment.globalIlluminationIntensity`（0.32）。three 侧经 `displayContractThree.ts#resolveGlobalIlluminationIntensity`；Deep 发布编译直接读合约（delivery 不引入 three）。
- **同类硬编码**：`compileSceneLighting.ts` 的 `0.72 + intensity*0.33 / 0.55 / 1.55` 改读合约 `dynamicExposure`（base/intensityScale/min/max）；three 动态曝光抽为 `resolveDynamicExposure`，与编译侧同公式。
- **`threeToneMappingFor`** 改为按参数 switch 返回；`deep-aces` 无 three 等价算子，明确回落 ACESFilmic（已注释）。
- **vite.config.ts**：确认全仓无对 `monaco-editor/esm/vs/editor/editor.worker.js`、`.../typescript/ts.worker.js` 裸说明符的引用（`monacoWorkerEnvironment.ts` 用 `new URL` 相对路径），删除这两条 alias（`resolve.alias` 块整体移除）。
- **回归测试**：`displayContractParity.test.ts` 新增 2 例——缺 `globalIlluminationIntensity` 时 three 解析与 Deep 编译同为合约值（显式值与 0 透传）；动态曝光公式 three 与编译在多档强度/禁用/上限夹紧下一致，且 intensity=1 等于静态曝光。
- 验证：`tsc --noEmit -p .` 0 错误；parity 7 例、`src/delivery`、`appDefaults`、`viewerEngine*` 共 108 文件通过；唯一失败 `viewerEngineRootMotion.test.ts`（播放头相位）为他会话在途改动，与本修复无关。
