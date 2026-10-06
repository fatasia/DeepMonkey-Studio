# ADR-0010: 渲染引擎默认 Deep 与恢复语义、门禁画布定位合同、WGSL 控制流纪律

## Status

Accepted

## Context

2026-10-06/07 收官批次同时落下三组相互纠缠的决策,需要固化口径防止回归:

1. **默认引擎与恢复语义**:用户拍板"默认要使用 Deep"。实现上 `initialRendererBackend`(rendererCapabilities.ts)已按 `webGpuApiPresent()` 把无偏好新会话默认到 Deep WebGPU,但 `useAppRuntimeEffects` 的恢复 effect 把"无存储偏好"回退成 `"webgl"` 并强制切换——默认 Deep 活不过启动,用户看到"切换 Deep 失败"。
2. **Deep 双画布是设计**:`studioDeepPresentationCanvas.ts` 的合同是作者画布(three.js,持输入,zIndex 1)+ Deep 呈现画布(`data-renderer-backend` + `aria-hidden`,zIndex 0)。41 个浏览器门脚本曾用裸 `.viewport canvas` 定位,在 Deep 激活态 strict-mode 双命中。
3. **WGSL 跨宿主控制流**:megaLights RIS 核在 wgpu 30 naga 路径(Vulkan→SPIR-V)触发设备重置。嵌套循环携带状态(累加器)+ `continue` 是 naga 结构化控制流误编译的已知家族;同一 WGSL 单源同时喂 Dawn/tint(TS 生产)与 naga(Rust 真机)。

## Decision

1. **渲染偏好恢复只认显式保存值**:`localStorage` 无有效值(`webgpu`/`wasm`/`webgl` 之外)时恢复 effect 直接 return,不回退、不干预会话默认。会话默认 = `initialRendererBackend(null, null)` = WebGPU 可探即 Deep。用户显式保存过的偏好(含显式 WebGL)照常恢复。此语义不许回退;测试两条腿(无存储不干预+显式保存才恢复)钉死在 useAppLifecycleEffects.test.ts。
2. **门脚本画布定位合同**:浏览器门/探针定位主画布一律用 `.viewport canvas:not([aria-hidden="true"])`(作者画布);要指名 Deep 画布用 `[data-renderer-backend="deep-webgpu"]`。裸 `.viewport canvas` 禁止新增。41 个存量脚本已同族迁移。
3. **WGSL 控制流纪律**:跨宿主单源 WGSL(wgsl/ 目录 + native assets)中,**嵌套循环且携带循环外累加器的核禁用 `continue`**,一律写德摩根取反的结构化 `if`(逐位等价,求值顺序不变)。已落地:megaLightsRis.wgsl(spatial 块 4 处,校验和门含"spatial 块零 continue"防回归钉)。同模式存量(ltcAreaLighting/probeClipmapSampling/sdfBakeSceneGrid/volumetricGodRays 及 native assets)现有真机腿全绿,按"量化增益否则砍"不盲改,出现真机故障再按本 ADR 处置。改动任何共享 WGSL 必须同提交跑 `pnpm --filter @bim-studio/deep-engine wgsl:sync` 再生镜像与 `.sha256` 夹具,两半(TS/Rust)测试同时绿。

## Consequences

- 门 8/10 首次在 Deep 激活态运行,暴露 baseColorMapUrl 适配、渲染准备取消、headless WebGPU 节流超时等问题——这些是环境首次如实暴露,不是默认 Deep 的回归;修复方向见 docs/reports/closeout-report-20261007.md。
- `verify:release` 链为 10 门(license 审计按用户指令移除);门内强制与链字符串须同步改(712a3357/2668d324 教训:只改一半会让链继续调用已废弃门)。
- 真机 GPU 探针(#[ignore])在 GPU 串行窗口执行;多路并行期间只跑 CPU 验证。
