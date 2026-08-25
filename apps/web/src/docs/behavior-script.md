# 编写和运行行为脚本

行为脚本用于实现编辑器内置面板无法覆盖的三维逻辑，例如操作摄像机、播放动画、拆解设备、切换第一或第三人称，以及根据实时数据驱动模型。脚本属于应用文档，可随版本保存和发布。

## 创建行为脚本

在三维编辑器打开“脚本”面板，点击“新建脚本”，设置名称、启用状态和允许使用的能力。脚本只通过受控的场景 API 操作当前场景，不直接访问服务器文件系统。

```ts
export async function onStart(context) {
  await context.scene.camera.flyTo("overview", { duration: 800 });
  context.log.info("已切换到总览视角");
}
```

## 响应数据和交互

使用生命周期函数订阅对象点击或数据产品更新。处理函数应保持短小；耗时任务放在数据中台，场景脚本只消费结果。

```ts
export function onData(event, context) {
  const speed = Number(event.value.speed ?? 0);
  context.scene.object("agv-01").setState({ speed });
}
```

## 操作摄像机和角色

- `camera.flyTo`：飞行到已保存视角。
- `camera.setProjection`：切换透视或正交相机。
- `navigation.setMode`：切换轨道、第一人称或第三人称。
- `navigation.setCollision`：开启第一人称碰撞并设置碰撞半径。
- `camera.setClipping`：设置近截面和远截面。

## 调试和故障隔离

先在编辑模式运行脚本，查看控制台日志和错误位置。单个脚本异常会被暂停，不应中断页面保存、数据刷新或其他脚本。发布前执行一次停止、启动和场景重载，确认资源清理完整。

需要二维联动时，先完成[创建 2D 并绑定 3D](/docs/dashboard-scene#绑定三维场景)。AGV 相关例子见[实时与仿真切换](/docs/agv-runtime-simulation#绑定实时数据)。
