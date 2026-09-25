# GPT 接手现状核查（2026-09-25）

依据 `glm-to-gpt-2026-09-25.md`、`active-task-recovery-ledger.md` 末尾批次、`codex-to-glm-2026-09-25.md`、`engine-neutral-command-layer-design-2026-09-25.md`，并核对 `git log`、`git status --short`、`git diff --stat`。当前 HEAD `8ed6d5cf`；本轮新增切片已提交，工作树干净。

## 现状核查

1. **源码与未跟踪文件**：已搜 `packages/*/src`、`apps/*/src` 的 `customShader|shaderEffect|shaderPackages|pickScene|editorOverlay|probeGridBake`，并检查 `git status --short` 的 `??`。`ObjectAppearanceEditor` 仅有枚举式 `shaderEffect`；Deep `pickScene` 已存在；WebGPU `editorOverlay` 已接；烘焙持久化文件已有。未跟踪文件含 WASM、浏览器测试脚本及其他会话产物，禁止抢占。
2. **契约层**：`packages/contracts/src/scene.ts` 已有 `SceneMaterialState.shaderEffect`、`customShader`、`ScenePickingHit/Query`；`packages/deep-engine/src/runtimePackage/types.ts` 已有 `shaderPackages`（上限 128），`packages/deep-engine/src/webgpu/editorOverlayTypes.ts` 已有 WebGPU 顶点合同。WASM overlay 使用同一 8-float 顶点合同，探针字段沿既有 RuntimePackage 入口传递。
3. **依赖**：`package.json`、`apps/web/package.json`、`packages/deep-engine/package.json`、`packages/deep-engine-wasm/Cargo.toml` 已核对。Three、deep-engine Shader Package、wgpu/wasm-bindgen 已在用，以下切片无需新增库。
4. **消费方**：`viewerEngineObjectState.ts` 消费材质状态；运行包 builder 消费 `shaderPackages`/`materialBindings`；WebGPU/WASM 桥消费 `editorOverlay`；`probeGridBakePublicationSession` 被发布链消费；Deep WebGPU 点击已走 `pickScene` 并经实例映射恢复作者 `nodeId`，缺映射明确降级。
5. **测试证据**：交接冻结基线 API 1580、Web 4462、deep-engine 3855；`test-output/ui-consistency-audit-2026-09-25/` 有 UI 证据，`test-output/interaction-functional-audit-2026-09-25/` 有截图/探针但缺报告；已有 picking、runtimePackage、probeGridBake 测试。后续只跑受改动影响的最相关门禁，再进行必要的全量收口。
6. **规格**：以总账末尾 W1/W2/W3 队列和交接最新优先级为准；命令层设计的未实施公共合同议题不冒充已完成。工业格式计划与本轮切片无直接改动关系。

## 已完成 / 本轮剩余 / 明确阻塞 / 项目级后验收

| 状态 | 项目 | 实现入口与证据 | 未满足条件 / 预计文件域 |
| --- | --- | --- | --- |
| 已完成 | 命令层八原语与 20 UI 写点 | 总账批次 15，`apps/web/src/viewer/engineEditCommand*` | 不重建 |
| 已完成 | 烘焙 UI 接线、服务端持久化、发布一致性 | 总账批次 16，`probeGridBake*` | 不重建 |
| 已完成 | Shader 正式工具链 | `CustomShaderEditor`、`sceneCustomShader`、`compileSceneRuntimePackage`、`shaderPackages/materialBindings` | DeepSL 编辑/诊断/绑定/解除绑定/快照保存/发布阻断；预览只显示真实诊断与 PassCacheKey，不伪造像素 |
| 已完成 | Deep 拾取消费 | `pickScene`、`ScenePickingHit`、Deep WebGPU 桥、`ThreeProjectionBridge` | Deep 编辑点击消费命中，实例映射恢复作者 `nodeId`；无映射明确 degraded/fallback；聚焦 38+33 项通过 |
| 已完成 | WASM overlay 与探针消费 | `deep-engine-wasm/src/lib.rs`、Native editor overlay、Web WASM 桥 | overlay FFI/渲染 pass、探针 runtime package 编译接线；Rust/WASM/bundle/freshness 门禁通过 |
| 已完成 | W1 辅助图形 | `deepOverlayPrimitives`、`deepOverlayPrimitiveSource`、`viewerEngineInteraction` | 选择盒、两点/角度测量、剖切盒、标注 pin/marker、灯光代理 native overlay；标注文字保留作者标签投影 |
| 已完成 | W1 gizmo 交互数学 | `deepGizmoInteraction`、`deepCameraInputSession`、WebGPU/WASM bridge | translate/rotate/scale 命中与操纵在 Deep 侧消费，TransformControls 事件不再转发；3 项纯数学测试通过 |
| 已完成 | W3 诊断上层 | `StudioDeepPerformance` → `FramePerformanceSnapshot` → `RendererDiagnosticsPanel` | clustered light、DDGI budget、residency scale、temporal camera-cut、资源/瞬态纹理、probe clipmap 真实字段可见 |
| 本轮剩余 | 交互/视觉全检收口 | `test-output/interaction-functional-audit-2026-09-25/` | M2/M3/M4 主路径通过；M1 旧脚本仍点击当前 disabled 的无模型爆炸按钮，需按新语义重录；Shader/gizmo/WASM 新 UI 需两轮截图与评分 |
| 按用户指令移除 | W3 音频长稳 soak | Native `dashboard_video_media_foundation` | 本轮明确不做长时稳定性 soak；保留 focused、20s/60s 结果和已知 Windows 输出队列瞬态，不作为当前发布阻断 |
| 明确限制 | Native clustered lighting 视觉证据、temporal validity ratio | 现有 Native/Hi-Z 诊断 | 运行链已有能力，但缺真实 GPU 像素/validity ratio 生产证据；不伪造指标，需外部 GPU capture/设备样本 |
| 项目级后验收 | 全站统一体验、性能长稳、对外发布 | `bim-studio/AGENTS.md` 最终门禁 | 需全部核心功能闭合后的整体验收 |

## 并行文件边界与产物

- Shader 车道：`packages/contracts/src/scene.ts`、`apps/web/src/components/ObjectAppearanceEditor*`、材质作者态/发布转换器及其测试；交付保存→恢复→编译发布证据和 UI 视觉报告。不得修改拾取、WASM 和 GPU 计时文件。
- 拾取车道：Web viewer/Deep 桥的拾取输入与发布查看器拾取及测试；交付 Deep 模式 nodeId 命中和降级证据。不得修改 Shader、WASM 和 GPU 计时文件。
- WASM 车道：`packages/deep-engine-wasm/src`、Web WASM 桥及测试；交付 overlay/探针消费证据。不得修改 Shader、拾取和 GPU 计时文件。
- 主线程：交互/视觉复验、音频 soak 证据、统合验证和总账更新。遇到共享文件先按文件域暂存，不交叉暂存。

## 2026-09-25 15:08 验收更新

- W2 发布闭环补证：`compileSceneRuntimePackage` 对带 `customShader` 的模型生成 `shaderPackages` 与 `materialBindings`，绑定的 `packageId/entrypoint` 一致；定向发布/烘焙/持久化测试 15/15，通过新增发布验证 1/1。
- W3 姿态命令补齐：`RobotJointPreview` 与 `RobotSceneInspector` 经 `robotPoseCommand` 进入 `CommandBus`；`setRobotPose` 的 `false` 拒绝结果由 UI 消费并显示错误；命令/姿态定向测试 64/64。
- 当前命令层撤销仍由 `SceneAuthoringHistory` 的整快照路径承载；规格中的“每条命令携带 inverse”是后续目标态，不计入本轮已完成能力。
- 总验收：artifact freshness 通过；Web 全量剩余架构扫描超时与电池样本 manifest 校验环境失败，W1/W2/W3 定向集均通过；Native 1800 秒音频 soak 正在运行。

## 2026-09-25 15:26 性能与全量门禁更新

- WebGPU 队列收敛优化：`2e79f328` 让 TAA settle 帧按 GPU completion 背压；`61635808` 的相机/settle 强串行化因输入延迟回归已由 `589187af` 回退；保留 `2e79f328` 的 settle GPU completion 背压，定向调度/桥测试 59/59，命令/桥综合集 102/102。
- 安静窗口公平对比证据：`test-output/deep-fair-comparison-backpressure-2026-09-25/`；120 静置 + 120 输入，WebGPU GPU 完成 P50/P95 15.1/31.1ms（旧证据约 53.7/103.8ms），黑帧 0、拖拽 distinct 1.0、50fps、位姿 SSIM 1。输入 P95 仍略高于 WebGL，暂不宣称全面领先。
- 第二轮 `deep-fair-comparison-serialized-2026-09-25` 受 WebGL 并发 long task 污染，已明确丢弃，不用于性能结论。
- 电池制品 EOL 修复后 API battery/capability 8/8、Web battery sample 3/3；根因与复现写入 `docs/reports/battery-manifest-eol-audit-2026-09-25.md`。
- 当前全量 API 仍有 JT/X_T worker 时序、临时目录锁、嵌入纹理解码超时、Windows ZIP 进程路径和 local bare Git 清理失败；这些不是本轮 W1/W2/W3 变更回归，需在独立稳定环境收口。

## 2026-09-25 15:33 脱离 Three 迁移切片

- `7be6f77c`：作者 `ApplicationDocument → SceneSnapshot` 持久化边界统一经过 `SceneTransformGraph` 与 `validateSceneSnapshotTransforms`，非法有限值在进入 Deep runtime 前拒绝；定向 factory/graph 测试 8/8。
- 该切片只收紧作者快照的 Deep graph 合同，不宣称全面脱离 Three。材质/骨骼 setter 与 WebGPU projection bridge 仍需后续按依赖矩阵迁移。

## 2026-09-25 15:40 音频与材质迁移更新

- Native 音频 `b73790ec`：重同步阈值从 100ms 前移到 50ms，避免 Windows 输出缓冲完整逃逸；focused 2/2，20s DX12 soak：max 96.4ms、mean 40.5ms、p99 92.7ms、escapes 0。1800s 正式 soak 的旧结果 p99 156.2ms，需后续长跑复验修复收益。
- `cd115556`：runtime render packet 编译按稳定 `SceneSnapshot.models[].modelId` 读取并复制材质作者态，Deep/WASM/Native 不再从 ViewerEngine/Three 材质 setter 读取；定向编译测试 23/23，Web tsc 已通过。
- API 串行全量：1580 passed / 13 skipped；Web 全量：4485 passed / 3 skipped。串行运行消除了 JT/X_T 的资源竞争假失败。

## 2026-09-25 追加：当前开源前置核查

- Three 脱离：`78e28943` 已把 `ViewerEngine` 作者变换状态从 Three 矩阵中分离；`23edb71c` 将作者变换注入 Deep RenderPacket；`5cdde88e`/`e1015ef6` 让 Deep 后端和 Studio WebGPU bridge 可接收预编译 RenderPacket，绕过 Three 场景遍历，且无 provider 时保留 Three fallback。默认生产 provider 仍需由上层传入现有 `compileSceneRenderPacket` 结果；材质、层级和骨骼的完整作者态迁移仍未完成。
- Native 发布：Cargo 单测 10/10；本地 API runtime bundle 已生成。MSI/NSIS 仍需按当前 Web 产物重打并通过 `verify:bundle` 与 local publication smoke，完成后才可收口。
- 开源治理：`pnpm audit:licenses`、`pnpm docs:wiki:check`、`pnpm quality:public-brand` 通过；`pnpm gate:repository` 当前失败项为许可证元数据与治理口径不一致，以及 37.6 MB 介绍视频缺少大文件发布例外。许可证目标和大文件分发策略需在公开前统一。
- 当前不宣称性能全面超过 Three：WebGPU GPU completion 已显著改善（P50/P95 15.1/31.1ms），但输入 P95/submit gap 仍略高于 WebGL；需继续完成 Deep RenderPacket 路径脱 Three 后再重跑公平矩阵。

## 2026-09-25 追加：独立路径、漏洞与安全治理

- `a33f03c4`：当 Studio 提供 `authorRenderPacket` 时，Deep 创建路径不再创建或持有 Three projection/root；拾取通过 RenderPacket `objectBindings` 恢复 `modelId`。Three 仅保留兼容回退；离线 primitive 编译仍可使用 Three，不属于运行时权威依赖。
- `90571b89`：独立 RenderPacket 稳定帧跳过已提交 packet 的无效异步 sync/promise turn；保留旧 Three sync、GPU backpressure 与 16 帧 TAA settle。StudioDeepWebGpuBridge focused 36/36；全面超过 Three 仍需重跑同场景公平 benchmark 证明。
- `d1601273`：生产依赖升级后 `pnpm audit --prod` 为 0 high / 0 moderate / 0 low / 0 critical；API typecheck 通过，数据集成/生产预检 17/17。
- `69626c36`：新增 `.github/CODEOWNERS`，更新 PR 模板和 CHANGELOG；仓库治理通过。许可证按用户指令保持 DMCSL/source-available，不改法律目标。
