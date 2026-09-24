# DeepCameraController 接线计划(2026-09-25)

状态:纯逻辑层已交付(`deepCameraController.ts` 5 单测、`deepCameraInputSession.ts` 3 单测,提交 38665a1e/f368b250);本文档是接线到 Studio 视口的施工图,对应"八条 Three 权威路径"第 2 条(引擎中立相机/输入缝)。

## 目标

Deep 演示后端(webgpu/wasm)激活时,视口手势(轨道/平移/推拉)的输入权威从 Three OrbitControls 切换为 `DeepCameraController`;Three 作者画布降级为拾取/gizmo 的事件透传目标;WebGL 兼容模式完整回落。

## 输入流(目标态)

```
用户指针/滚轮 → Deep 画布(pointerEvents=auto)
  ├─ DeepCameraInputSession → DeepCameraController → pose
  │     └─ pose 写回 viewer.camera.position + orbit.target(单一事实源不变)
  │         → 既有相机快照链(set_viewer_camera / WebGPU cameraSnapshot)照常消费
  └─ 同事件克隆 dispatchEvent 到作者画布(拾取/hover/gizmo 链照常,零感知)
OrbitControls.enabled = false(防双驱动);WebGL 回落时恢复 true。
```

关键决策:**pose 写回 viewer.camera 而非旁路**。相机单一事实源仍是 `viewer.camera`,两个输入源(OrbitControls/Controller)互斥启用,切换无缝(回 WebGL 时 OrbitControls 从 controller 留下的 pose 继续)。

## 已识别冲突与对策

1. **gizmo 拖拽 vs 视口手势**:pointerdown 命中 TransformControls(检查 `viewer.transform.axis !== null` 或 drag 状态)时 session 忽略本次拖拽,事件只透传。需要 ViewerEngine 暴露只读 `isTransformDragging`。
2. **第一人称/导航模式**:navigationMode !== "orbit" 时 session 禁用(PointerLockControls 链路暂不迁移,WebGL 硬门保持)。
3. **相机碰撞**:orbit.enabled=false 期间碰撞锚(updateCollisions)由 pose 写回路径触发(emitCameraChange 等价),接线时补调用。
4. **e2e 合同变更**:`engine-switch-integration-e2e.mjs:297` 现断言"作者画布 pointerEvents=auto";改为断言"输入持有画布 = 当前演示后端画布(webgl→author,webgpu/wasm→deep)"。
5. **触屏**:双指捏合已在 session;单指轨道默认开,与页面滚动手势冲突由 touch-action: none 保证(画布样式已有)。

## 施工顺序

1. ViewerEngine 暴露 `isTransformDragging`(只读)+ `setOrbitEnabled(bool)`。
2. 桥(webgpu/wasm 共用基类或各自)在 publish/publishWebGl 挂接 session attach/detach 与画布 pointerEvents 切换。
3. click 透传细节:pointerup 且位移 < 3px 时合成 click 到作者画布(pointermove 全量透传供 hover;OrbitControls disabled 下 move 无副作用)。
4. 单测:手势映射已有;补"gizmo 拖拽抑制""回落恢复"。
5. e2e:wasm/webgpu 模式加"拖拽改视角+断言后端帧变化"(复用 fair runner 协议)。

## 验收

- 三后端拖拽/滚轮手感一致(轨迹回放对比);WebGL 回落后视角连续无跳变;gizmo 拖拽期间相机静止;拾取/hover/gizmo 全部可用;engine-switch e2e 全过。
