# 编写和运行行为脚本

行为脚本用于实现编辑器内置面板无法覆盖的三维逻辑，例如操作摄像机、播放动画、拆解设备、切换第一或第三人称，以及根据实时数据驱动模型。脚本属于应用文档，可随版本保存和发布。

## 创建行为脚本

在二维或三维编辑器选中组件，在交互面板展开“高级脚本”；两处使用同一个高层 `studio` API。需要逐帧和固定时间步时，在三维编辑器打开“脚本”工作台：默认 Worker 模式使用 `ctx.command(...)`，避免耗时逻辑阻塞渲染；可信交互脚本才会开放 `THREE` 和 `studio.raw` 底层逃生口。

```ts
studio.camera.applyView("camera:overview");
studio.log("已切换到总览视角");
```

## 响应数据和交互

使用生命周期函数订阅对象点击或数据产品更新。处理函数应保持短小；耗时任务放在数据中台，场景脚本只消费结果。

```ts
function onData(ctx) {
  const speed = Number(studio.getData("agv.speed") ?? 0);
  const agv = studio.object("agv-01");
  agv?.setPosition(speed * ctx.deltaTime, 0, 0);
  agv?.setColor(speed > 2 ? "#f59e0b" : "#22c55e");
}
```

## `studio` 高频 API

- `studio.object(idOrName)` / `studio.objects(query)`：按稳定 ID 或名称取得对象句柄。
- `object.setPosition/setRotation/setScale/setTransform`：修改模型或 Primitive 变换。
- `object.show/hide/toggle/focus/setColor/setOpacity`：控制显隐、聚焦和外观。
- `object.setCollision/explode/playAnimation/stopAnimation`：碰撞、拆解和模型动画。
- `studio.camera.setPose/setMode/setClip/setCollision/setStandardView`：控制相机、第一/第三人称和防穿模。
- `studio.scene.setWeather/setEnvironment/setPostProcessing/setPhysics`：控制场景环境、渲染和物理状态。
- `studio.animation.play/pause/seek`：控制应用时间线。
- `studio.component(idOrName).update(...)`：从脚本修改二维组件；`studio.page.open(...)` 与 `studio.scene.open(...)` 负责统一导航。
- `studio.getData/setData`：读取和写入应用变量，可与数据中台、HTTP 或 WebSocket 数据联动。

二维大屏中的实时三维组件会注册场景运行时，所以二维组件事件可以直接调用同一组对象、相机和动画 API。未加载的三维视口仍可执行导航、显隐、颜色、透明度和动画等可移植动作；需要直接操作 `THREE.Object3D` 时，应将组件设为“实时”或先载入视口。

## 原生 Three.js 逃生口

可信交互脚本中，高层 API 没覆盖到的长尾功能可使用 `studio.object("id")?.raw`、`studio.raw.scene`、`studio.raw.camera`、`studio.raw.renderer` 与全局 `THREE`。这条路径适合自定义 Mesh、材质、射线、骨骼和复杂动画；项目发布前应自行释放创建的纹理、几何体和监听器。Worker 行为脚本不会拿到底层对象。高频能力会继续沉淀回稳定 `studio` API。

## 调试和故障隔离

先在编辑模式运行脚本，查看控制台日志和错误位置。单个脚本异常会被暂停，不应中断页面保存、数据刷新或其他脚本。发布前执行一次停止、启动和场景重载，确认资源清理完整。

需要二维联动时，先完成[创建 2D 并绑定 3D](/docs/dashboard-scene#绑定三维场景)。AGV 相关例子见[实时与仿真切换](/docs/agv-runtime-simulation#绑定实时数据)。
