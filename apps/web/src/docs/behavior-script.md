# 编写和运行行为脚本

行为脚本用于实现编辑器内置面板无法覆盖的三维逻辑，例如操作摄像机、播放模型动画，以及根据实时数据驱动模型。脚本属于应用文档，可随版本保存和发布。

## 创建行为脚本

在二维或三维编辑器选中组件，在交互面板展开“高级脚本”；需要逐帧和固定时间步时，在三维编辑器打开“脚本”工作台。默认 Worker 模式通过受控命令修改场景，避免耗时逻辑阻塞渲染；可信交互脚本才会开放 `THREE` 和 `studio.raw` 底层逃生口。

脚本工作台会从当前项目生成对象、组件、数据键、事件、页面、场景和相机视角提示。右侧“数据与事件”资源区可以搜索并一键插入读取、写入、监听和发出代码，同时自动补齐相应能力、权限或 `onEvent` 生命周期。工具栏的问题数可直接定位到失效 ID；“一键补齐声明”会根据代码补充生命周期、能力和权限。`Ctrl+Enter` 会先应用当前草稿再运行，不会运行上一次保存的代码。

```ts
studio.camera.applyView("camera:overview");
studio.log("已切换到总览视角");
```

## 响应数据和交互

使用生命周期函数订阅对象点击或数据产品更新。处理函数应保持短小；耗时任务放在数据中台，场景脚本只消费结果。

```ts
function onData(ctx) {
  const speed = Number(ctx.getData("agv.speed") ?? 0);
  const agv = ctx.object("agv-01");
  agv?.setPosition(speed * ctx.deltaTime, 0, 0);
  agv?.setColor(speed > 2 ? "#f59e0b" : "#22c55e");
  ctx.setData("agv.lastSpeed", speed);
  if (speed > 2) ctx.emit("agvOverspeed", { speed });
}
```

`getData` 需要 `data.read`，`setData` 需要 `data.write`。写回值会进入应用变量并继续驱动 2D、3D 和 Unity 数据绑定；`emit` 会作为 `bim-studio:behavior-event` 业务事件交给宿主。

三维对象的点击、双击、移入和移出等交互会进入 `onEvent`。事件携带稳定对象引用，脚本无需直接监听 DOM 或 Three.js 指针事件。

```ts
function onEvent(ctx) {
  if (ctx.event?.name === "click") {
    ctx.log("点击对象", ctx.event.target);
  }
}
```

一个脚本通过 `ctx.emit(name, payload)` 发出的事件也会以 `business.event` 分发给同一应用中其他启用了 `onEvent` 的行为，事件包含 `sourceModuleId`，可用于跨脚本解耦联动。

## Worker 高频 API

- `ctx.object(id)` / `studio.object(id)`：按稳定 ID 取得受控对象句柄。
- `object.setPosition/setRotation/setScale`：修改模型或 Primitive 变换。
- `object.show/hide/select/focus/setColor/setOpacity`：控制显隐、选择、聚焦和外观。
- `object.playAnimation/pauseAnimation/stopAnimation/seekAnimation`：控制导入模型的动画 Clip。
- `object.setScreenMedia/playScreen/pauseScreen/hideScreen`：把项目图片或视频映射到模型/构件表面，并控制自动播放、一次或循环播放。多材质模型应先选中屏幕构件。
- `object.getMaterial/setMaterial`：读取当前模型标准材质并增量修改 PBR、贴图和 UV 参数。Worker 行为脚本可用 `setMaterial` 驱动颜色、粗糙度、金属度、自发光与 UV 标量；贴图 URL 只允许通过素材库或可信脚本设置。
- `object.setSpatialAudio/playSpatialAudio/pauseSpatialAudio/stopSpatialAudio/replaySpatialAudio`：把音频挂载到模型位置，配置一次/循环、音量和距离衰减；首次播放需由用户点击三维视口解锁浏览器音频。
- `studio.camera.setPose` / `studio.camera.focus`：设置相机姿态或聚焦对象。
- `studio.component(id).update(...)`：从脚本修改二维组件。
- `ctx.getData/setData/emit` 与 `studio.getData/setData/emit`：读取变量、写回联动和发出业务事件。
- `studio.net.fetch/request`：通过服务器网关访问获准的数据接口。

第一/第三人称、场景环境、时间线、页面导航以及 `raw` 底层对象目前属于可信交互脚本 API，不应在 Worker 行为脚本中假设可用。编辑器会继续把已经具备宿主命令闭环的能力下沉到 Worker。

二维大屏中的实时三维组件会注册场景运行时，所以二维组件事件可以直接调用同一组对象、相机和动画 API。未加载的三维视口仍可执行导航、显隐、颜色、透明度和动画等可移植动作；需要直接操作 `THREE.Object3D` 时，应将组件设为“实时”或先载入视口。

## 原生 Three.js 逃生口

可信交互脚本中，高层 API 没覆盖到的长尾功能可使用 `studio.object("id")?.raw`、`studio.raw.scene`、`studio.raw.camera`、`studio.raw.renderer` 与全局 `THREE`。这条路径适合自定义 Mesh、材质、射线、骨骼和复杂动画；项目发布前应自行释放创建的纹理、几何体和监听器。Worker 行为脚本不会拿到底层对象。高频能力会继续沉淀回稳定 `studio` API。

## 调试和故障隔离

先在编辑模式运行脚本，查看控制台日志和错误位置。单个脚本异常会被暂停，不应中断页面保存、数据刷新或其他脚本。发布前执行一次停止、启动和场景重载，确认资源清理完整。

需要二维联动时，先完成[创建 2D 并绑定 3D](/docs/dashboard-scene#绑定三维场景)。AGV 相关例子见[实时与仿真切换](/docs/agv-runtime-simulation#绑定实时数据)。
