# 场景事件、二维看板与多场景设计

## 可信事件脚本

模型、图层、BIM 构件和二维看板组件共用一套事件定义，随场景快照保存、导入、导出和发布。当前触发器包括：

- 加载完成
- 点击
- 鼠标进入、鼠标离开
- 动画开始、动画结束

脚本通过 `AsyncFunction` 直接在浏览器主线程运行，不使用沙箱。它可以访问浏览器全局对象，并获得以下参数：

```js
// 当前对象或二维组件
ctx.target;
// 事件类型、拾取坐标和原始 DOM 事件
ctx.event;
// 完整 ViewerEngine、Three.js 场景和渲染器
ctx.engine;
ctx.scene;
ctx.camera;
ctx.renderer;
// OrbitControls、PointerLockControls、TransformControls
ctx.controls;
// 模型、图层、标注、灯光、Fragments 和空间的运行时集合
ctx.objects;
// 同时直接提供 THREE 和 engine 参数
THREE;
engine;
```

示例：点击后将当前普通 Three.js 对象设为红色，并移动相机。

```js
const object = ctx.target.object;
if (object) {
  object.traverse((child) => {
    if (child.isMesh && child.material?.color) child.material.color.set("#ff334f");
  });
  ctx.engine.focusObject?.(object);
}
```

脚本拥有完整页面权限，也会占用渲染主线程。只应向可信场景编辑者开放；死循环或长时间同步计算会阻塞页面，业务数据查询应交给 Node-RED 或异步接口。

## 二维看板

手填数据键仍是正式绑定方式，并保留运行期数据键自动补全。URL 网页是独立组件，不要求数据键，支持 `http://`、`https://` 和 `/` 开头的站内地址。

数据接入统一由 Node-RED 完成：HTTP、WebSocket、MQTT 使用核心节点；PLC 首期使用 OPC UA、Modbus TCP 和 BACnet；数据库和设备数据都转换为相同的场景消息。浏览器不直接保存 PLC 地址或凭据。西门子 S7、EtherNet/IP 可按现场设备作为可插拔节点安装，不进入默认轻量包。

网页能否嵌入还取决于目标站点的 `X-Frame-Options` 和 CSP `frame-ancestors`。被目标站点禁止嵌入时，应改用对方提供的嵌入地址，或通过受控反向代理部署同源页面。

二维组件事件和 3D 对象事件使用同一个脚本运行时，因此可以从图表控制模型，也可以从模型控制看板。二维图表收到数据并刷新时会触发动画开始/结束。

## 多场景

当前系统已经能在一个项目下保存和切换多个独立场景，但运行页面一次只挂载一个场景。这是合理的性能基线。

后续应增加 `SceneApplication`（多场景应用），而不是同时创建多个 Viewer：

```text
SceneApplication
├── defaultSceneId
├── scenes[] -> 固定到已发布的 SceneSnapshot 版本
├── sharedDashboard -> 跨场景保持的左右看板
├── sharedVariables -> 当前设备、楼层、时间范围等
└── navigation -> 菜单和场景跳转规则
```

推荐运行方式：

1. 一个页面只保留一个 ViewerEngine 和 WebGL/WebGPU 上下文。
2. 切换时卸载旧场景实例，复用相同模型资源的浏览器缓存和后续 GPU 资源缓存。
3. 应用级看板和变量不卸载；场景级看板随场景切换。
4. 发布时固定每个子场景的发布版本，避免某个场景更新导致整个应用表现漂移。
5. 提供 `scene.open` 动作和 `ctx.app.openScene(sceneId)` 脚本 API，并支持淡入、直接切换和相机匹配三种过渡。

分屏同时比较两个场景应作为独立的“场景对比”功能，最多两个 Viewer，并明确显存预算；不应成为普通多场景浏览的默认实现。
