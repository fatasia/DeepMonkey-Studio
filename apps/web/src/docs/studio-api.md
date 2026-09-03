# `studio` 应用 API 手册

`studio` 是二维、三维、Unity 嵌入和数据联动共用的高层脚本 API。编辑器会根据当前项目生成对象 ID、组件 ID、数据键、事件和镜头补全；优先选用补全项，不在代码里猜名称。

## 先确认脚本运行时

平台有两个明确边界：

- Worker 行为脚本是默认方式。它不访问 DOM、浏览器存储或原始渲染器，只提交受控场景命令；适合数据驱动、对象动作、Unity 控制和网络网关调用。
- 可信交互脚本在主线程执行，可使用页面导航、场景环境、时间线与 `studio.raw`。只在高层动作无法覆盖且代码已经人工审查时使用。

Worker 脚本必须在生命周期函数内调用会修改状态的 API。能力和权限由脚本声明控制；编辑器的“一键补齐声明”只补声明，不替代人工检查目标与业务逻辑。

## 生命周期与上下文

可定义 `onStart`、`onUpdate`、`onFixedUpdate`、`onData`、`onEvent`、`onStop` 和 `onDispose`。处理函数可异步，但逐帧函数应保持短小。

```ts
function onStart(ctx) {
  ctx.log("脚本启动", { sceneId: ctx.sceneId });
}

function onUpdate(ctx) {
  ctx.object("fan-01")?.setRotation(0, ctx.elapsedTime, 0);
}

function onDispose(ctx) {
  ctx.log("脚本资源已释放");
}
```

`ctx.deltaMs` / `ctx.elapsedMs` 使用毫秒，`ctx.deltaTime` / `ctx.elapsedTime` 使用秒。挂载到对象或组件时，`ctx.self` 指向当前目标；事件触发时从 `ctx.event` 读取名称、来源和数据。

## Worker 对象 API

`studio.object(id)`、`ctx.object(id)` 返回受控句柄。当前 Worker 运行时可用方法：

- `show()`、`hide()`、`select()`、`focus()`。
- `setPosition(x, y, z)`、`setRotation(x, y, z)`、`setScale(x, y?, z?)`。
- `setColor(color)`、`setOpacity(opacity)`、`setMaterial(patch)`。
- `playAnimation(clip?)`、`pauseAnimation(clip?)`、`stopAnimation(clip?)`、`seekAnimation(seconds, clip?)`。

```ts
function onData(ctx) {
  const temperature = Number(ctx.getData("motor.temperature") ?? 0);
  const motor = ctx.object("motor-01");
  motor?.setColor(temperature > 80 ? "#ef4444" : "#22c55e");
  motor?.setOpacity(temperature > 80 ? 1 : 0.82);
}
```

可信脚本在目标三维运行时已加载时，还可使用 `toggle`、`rename`、`setTransform`、`getMaterial`、碰撞、火焰、爆炸、屏幕媒体、空间音频、路线控制和 `remove`。若场景尚未加载，应只使用显隐、聚焦、颜色、透明度和基础动画等可移植动作。

## 相机、场景与时间线

Worker 可使用 `studio.camera.setPose(position, target, options)` 和 `studio.selection.clear()`；聚焦目标使用对象句柄的 `focus()`。可信脚本还提供：

- `camera.getState()`、`setMode()`、`setClip()`、`setCollision()`、`setStandardView()`、`applyView()`。
- `scene.open()`、`statistics()`、`rendererBackend()`，以及天气、环境、后处理和物理的读取与设置。
- `animation.play()`、`pause()`、`seek()`、`isPlaying()`。

```js
studio.camera.setPose([12, 6, 12], [0, 1, 0], {
  near: 0.05,
  far: 100000,
  fov: 55
});
studio.camera.setMode("firstPerson");
studio.camera.setCollision(true, 0.32);
```

导航模式为 `orbit`、`firstPerson` 或 `thirdPerson`；标准视图为 `top`、`bottom`、`left`、`right`、`front` 或 `back`。

## 二维组件、页面和数据

Worker 与可信脚本都可用 `studio.component(id)` 更新二维组件；Worker 句柄包含 `update`、`show`、`hide` 和 `rename`。可信脚本可用 `studio.components()` 枚举组件，并用 `studio.page.open(pageId)` 打开项目内页面。

```js
studio.component("status-card")?.update({
  visible: true,
  value: 68.5,
  color: "#22c55e"
});
studio.setData("device.temperature", 68.5);
```

读取数据需要 `data.read`，写入需要 `data.write`。Worker 中可使用 `ctx.getData` / `ctx.setData` 或对应的 `studio` 方法；`ctx.emit(name, payload)` / `studio.emit` 发出同一应用内的业务事件。

## Unity 控制

Worker 使用 `studio.unity(componentId)` 获取 Unity 组件句柄。可调用 `setProperty`、`setProperties`、`invoke` 和 `switchScene`；属性键、动作和目标对象会按 Unity 构建清单校验。

```ts
function onEvent(ctx) {
  if (ctx.event?.name !== "startLine") return;
  const unity = ctx.studio.unity("unity-line-01");
  unity.setProperty("line.speed", 1.25);
  unity.invoke("play", "conveyor-01");
}
```

## 通过服务器网关请求数据

Worker 使用 `studio.net.fetch`、`ctx.net.fetch` 或受控全局 `fetch`。必须声明 `network.connect`；请求由服务器网关执行，凭据只引用服务端 `credentialRef`，不要把令牌写进脚本。

```ts
async function onStart(ctx) {
  const response = await ctx.net.fetch("https://api.example.com/telemetry", {
    method: "GET",
    credentialRef: "factory-api",
    params: { line: "A" },
    select: { field: "temperature" }
  });
  ctx.setData("line.temperature", response.value);
}
```

`request(binding, variables)` 适合复用已有直接绑定配置。网络调用只能发生在行为生命周期内；超时、权限或网关错误会拒绝 Promise，应由脚本记录并保留上一个稳定值。

## Three.js 逃生口

只有可信且已加载的交互脚本能通过 `studio.object(id)?.raw`、`studio.raw.scene`、`studio.raw.camera`、`studio.raw.renderer` 和全局 `THREE` 访问原始对象。

```js
const object3d = studio.object("robot-01")?.raw;
object3d?.traverse((child) => {
  if (child.isMesh) child.castShadow = true;
});
```

脚本创建的几何、材质、纹理、计时器和监听器必须在停止或销毁时释放。Worker 行为脚本不会得到这些原始对象。

## 编辑、运行与排错

- `Ctrl+Space`：智能提示。
- `F1`：命令面板。
- `Alt+Shift+F`：格式化。
- `Ctrl+S`：应用当前修改。
- `Ctrl+Enter`：应用后运行当前草稿。

先处理编辑器问题列表中的失效 ID、能力和权限，再运行脚本。完整创建流程见[编写和运行行为脚本](/docs/behavior-script)，失败恢复见[数据、脚本或拓扑没有运行](/docs/troubleshooting#数据-脚本或拓扑没有运行)。
