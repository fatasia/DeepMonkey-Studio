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

