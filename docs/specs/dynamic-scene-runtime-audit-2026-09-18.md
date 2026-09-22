# 动态场景剩余项运行时审计（2026-09-18）

## 结论

本轮已接通受限动态 payload 的正式 Runtime Package v7 resource/entrypoint、编译器 TRS 映射、Native 解码以及 `PlayerContent` 消费入口，但仍保持 WebGPU/Native 帧驱动实播、非空 `dataBindings`、非空 `interactions` 为 `deferred`。现有 Web 编辑/预览运行时已经具备三类能力；直接从 `sceneInactiveFields` 移除 deferred 会使静态编译证据误报支持，并被 Native 归档门禁拒绝。新增的例外仅限于结构完整且全部 `enabled: false` 的数据绑定/交互，它们没有运行效果，仍保留在源快照和 hash 中；含 `directBinding` 的条目继续 deferred。

本轮新增 `packages/deep-engine/src/runtimePackage/dynamicSceneRuntime.ts` 与 Native `packages/deep-engine-native/src/runtime_package/dynamic_scene.rs`：两端冻结 `deep-engine.dynamic-runtime` v1 的动画关键帧、离线数据回放和声明式交互 payload 校验，使用严格未知字段拒绝、排序/单调 revision、有限数值、目标形状和预算门禁；Runtime Package v7 增加 `dynamic-runtime` 索引项与 `dynamicRuntime` 入口，Native 可验证并解码到 `LoadedRuntimePackage.dynamic_runtime`。Web 端新增 `dynamicRuntimePlayback.ts`，从实际编译产物的 v7 entrypoint 校验 payload、按时间采样 TRS、归一化四元数并把帧/回放事件交给宿主 sink；`ViewerEngineRuntimeSupport.applyDynamicRuntimeFrame` 已把该消费者接到实际 WebGPU/WebGL 模型对象，`startDynamicRuntimePlayback` 复用引擎 presentation frame scheduler 提供循环/单次时钟播放；编译器测试覆盖“编译 → Web 采样 → 帧应用”。仍没有 Native 真窗口播放和跨端确定性回放证据，因此不能把动态场景标为完成。TS ABI 4 项、Native runtime-package 21 项与 Web 编译消费测试通过。

## 证据矩阵

| 字段 | 作者/编辑运行时 | 编译器现状 | Runtime Package / Native 证据 | 判定 |
|---|---|---|---|---|
| `animation`（非空相机/对象轨迹） | `ViewerEngineTimelineRuntime.applySceneAnimationFrame` 对相机、模型 TRS、GLTF clip 采样；`apps/web/src/viewer/timeline.test.ts` 覆盖采样；`ViewerEngineRuntimeSupport.startDynamicRuntimePlayback` 复用 presentation frame scheduler | 编译器已把确定性模型 TRS 降为 v7 tracks；相机/clip 策略仍 deferred | Runtime Package v7 `dynamic-runtime` resource；Native 可校验/解码并携带到 `PlayerContent`；`dynamicRuntimePlayback.ts` 消费实际包 entrypoint 并应用采样帧 | **partial**；WebGPU/WebGL 宿主播放已接线，仍缺 Native 真窗口帧驱动和发布实窗/跨端重放证据 |
| `dataBindings`（非空） | `normalizeSceneDataBindings`、`sceneDataBindingMessage`、`ViewerEngineInteraction.applySceneDataMessage` 已有 Web 数据事件链；场景恢复时 `setSceneDataBindings`/`setInteractionScripts` 接线 | 结构完整且全部禁用的条目可判为无运行效果；启用项或含 `directBinding` 的条目仍被 `collectDeferredSceneFields` 标记 | v7 dynamic payload 可承载离线 `dataReplay`；Native 只做结构解码，不联网、不轮询 | **deferred**（禁用 no-op 除外）；仍缺编译器映射和实际回放消费者 |
| `interactions`（非空） | `ViewerEngineInteraction` 支持 trigger/action/script；`sceneScriptProtocol.ts` 定义能力/权限兼容性；恢复控制器调用 `engine.setInteractionScripts` | 结构完整且全部禁用的条目可判为无运行效果；启用交互（含可信脚本）被标记 deferred | v7 dynamic payload 可承载受限声明式 interaction；Native 只做结构解码，无脚本沙箱/触发总线 | **deferred**（禁用 no-op 除外）；仍缺编译映射、触发消费和跨端 golden |

## 最小可接线缺口（后续切片，不在本轮实现）

1. 已完成统一 `dynamic-runtime` v1 resource/entrypoint、预算、hash、未知字段拒绝和确定性模型 TRS 编译映射。
2. 动画先做静态确定性回放（关键帧/clip 选择/时间策略），再接 Native 播放时钟；要求 WebGPU/Native 同机位成对实图和两轮确定性。
3. `dataBindings` 必须编译成离线事件/快照或显式保持 inspect；不得将 endpoint、轮询、凭据或任意脚本带入发布包。对实时在线场景另立协议和权限门。
4. `interactions` 先限于声明式 action/trigger 子集，脚本继续 `inspect`，并为对象目标失效、事件顺序、取消和重放建立跨端 golden；共享 Scene API 协议不能作为 Native 消费证明。

5. 禁用 no-op 的判定必须保持严格结构校验；未知字段、启用项和网关直连绑定不得借此绕过 deferred。该收口只减少无效发布阻断，不改变动态 ABI 待办。

## 已执行验证

命令：

```text
pnpm --filter @bim-studio/web exec vitest run src/delivery/sceneInactiveFields.test.ts src/sceneDataBindings.test.ts src/viewer/timeline.test.ts --reporter=dot
```

结果：3 files / 48 tests passed，2.26s（2026-09-18 21:18:43）。该结果证明 Web 侧作者/预览内核，不证明静态 Runtime Package 或 Native 发布能力。

补充验证：`sceneInactiveFields.test.ts` 34/34 通过（2026-09-18 21:58），覆盖禁用数据绑定/交互的编译证据、启用回退和未知字段拒绝。

## 边界

- 本审计已修改 Runtime Package TS/Rust 合同与 prewarm 排序；没有宣称动态播放已完成。
- `sceneInactiveFields` 的空数组豁免是已验证的无运行效果优化，不能扩展到非空动态字段。
- 归档 Native 校验要求 `deferredSceneFields` 与 `deferredObjectFields` 为空；因此当前含动态字段的场景必须保持非 Native-ready，除非完成上述 ABI 和消费证据。
