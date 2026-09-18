# Deep2D 场景相机合同 v1

状态：相机负载校验、双端运行包 v3 解析、Native 播放器相机接线、作者场景编译和 WebGPU 预热交付已实现；正式导出与窗口能力验收尚未完成。

## 字段

| 字段 | 约定 |
| --- | --- |
| schema / schemaVersion | `deep-engine.scene-camera` / `1` |
| id / revision | 沿用运行包资源 ID 字符集；revision 为 1 到 JS 安全整数上限 |
| position / target | 三个世界坐标，Y 向上，单位与 RenderPacket 一致；每分量绝对值不超过 10000000 |
| verticalFovDegrees | 垂直视野角，1–179 度 |
| near | 0.0001–10000 |
| far | 大于 near，不超过 10000000，far/near 不超过 10000000 |

字段全部必填，未知字段拒绝。位置与目标转成 float32 后的距离至少为 0.0001；裁面转成 float32 后仍必须有序。负载保留原 JSON 数值用于哈希，Native 在校验后转换为渲染数值。

这是无横滚的透视相机。正上方/正下方视角采用确定的水平轴；导航模式、角色显示和相机动画不属于该负载。

## 实现和证据

- TypeScript：`packages/deep-engine/src/runtimePackage/camera.ts`；公开导出 `validateRuntimeSceneCamera` 与 `RuntimeSceneCamera`，返回隔离的已校验快照。
- Rust：`packages/deep-engine-native/src/runtime_camera.rs`；serde 严格字段解码后调用 `validate()`。`PlayerView::from_camera` 生成 yaw、pitch、distance、focal 和裁面。
- 共享样本：`packages/deep-engine/fixtures/runtime-camera-v1.json`，由两端测试直接读取。
- TypeScript 相机专项17项、runtimePackage目录192项通过；Deep Engine类型检查和构建通过。Rust负载专项2项、位置/目标/极点视图转换1项通过。

## 运行包 v3

传入 builder 的 `camera` 时输出 schemaVersion 3；`entrypoints.camera` 为必填资源 ID，资源 kind 为 `scene-camera`，负载 id/revision 必须与索引一致。相机有独立内容哈希，变更影响包哈希与预热计划哈希。

v3 必填 `materialBindings`，没有自定义着色器时允许空数组；有着色器则仍必须全部绑定。v1/v2 原规则保持不变，不能通过降版本接受相机字段。

WebGPU 预热适配器在同一次 commit 回调中交付几何 projection 与 camera；旧包交付 camera=null。拒绝提交时释放新候选，保留原发布状态。当前消费者需在该回调中实际应用相机，不能将“回调已收到参数”当作画面验收。

专项验证：运行包和WebGPU适配器13文件208项通过，含相机单独变化、重签后身份/版本错误、拒绝提交、重试及返回旧包。

## 尚未接入

Native 包解析器已接受 v3 并返回 camera，资源差异计划识别相机单独变化。共享 `runtime-package-camera-v3.json` 由实际 TS builder 生成，TS 测试比较完整值，Rust 测试验证解码与视图转换。Native v1/v2 合同、材质绑定、JSON 和差异计划专项共26项通过。

PlayerView 已移到公共模块，修复渲染集成测试直接引用播放器私有模块的问题。全目标编译通过；显式运行6项LOD/材质GPU读回测试通过。

Native PlayerContent 保存校验后的作者视图，首次启动使用该视图；热更新仅在作者相机变化时重置用户视角。拖入不同视角的包，或热更新需要完整渲染器时，先离屏验证候选帧，再释放旧交换链并激活候选窗口表面。验证失败保留原视图。该次修改修复了同一窗口同时配置两个交换链导致的 GPU 进程退出。

真实GPU拖包事件测试覆盖v3视角帧参数、切回旧包、候选初始化失败后原场景继续呈现。v3首次启动64×64 smoke通过，记录位于 `test-output/deep2d/camera-startup/1ad10894-1f04-4d25-8b8d-a2ebf5083090/native.log`。热更新相机已接线，专项GPU热更新/失效候选测试仍待补。

`compileSceneCamera` 已复用发布查看器的默认cameraView选择、裁面归一化与orbit自适应裁面，输出初始位置/目标及50度垂直FOV。编译配方为 `deep-scene-static-compile-v2`，输出v3包；相机变化影响实际产物hash。

证据新增 `compiledSceneFields`，相机项为 `{field:"camera", capability:"deep.scene.camera.v1", resourceId:"scene.camera"}`。纯orbit、无角色显示及未知字段时移出camera deferred；其他导航语义仍保留。cameraViews、cameraConstraints等未完整编译字段仍独立deferred。发布适配器对相机生成独立能力项，要求匹配三hash的Windows Native窗口证据。

三组实际场景编译v3包的GPU smoke通过，报告 `test-output/deep2d/scene-interop/9c4a3f95-056d-4615-b1af-200060de9266/report.json`。此项不是正式窗口视觉证明。默认阴影距离与大near协调、Web宿主相机应用、正式导出和视觉验收仍需补齐。
