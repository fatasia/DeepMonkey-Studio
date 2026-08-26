# `studio` 应用 API

`studio` 是二维看板、三维场景和发布页面共用的高层 JavaScript API。优先使用它完成常见逻辑；需要 Three.js 长尾能力时，再使用可信脚本的 `THREE` 与 `studio.raw`。

## 查询和操作对象

```js
const agv = studio.object("AGV-01");
agv?.setPosition(12, 0, 6);
agv?.setRotation(0, Math.PI / 2, 0);
agv?.setCollision(true);
agv?.setColor("#22c55e");
agv?.focus();
```

`studio.object` 支持稳定 ID 和完整名称；`studio.objects("AGV")` 可按 ID 或名称模糊查询多个对象。

## 相机和漫游

```js
studio.camera.setPose([12, 6, 12], [0, 1, 0], {
  near: 0.05,
  far: 100000,
  fov: 55
});
studio.camera.setMode("firstPerson");
studio.camera.setCollision(true, 0.32);
```

模式支持 `orbit`、`firstPerson`、`thirdPerson`。也可以用 `applyView` 切换保存的镜头，或用 `setStandardView` 切换前、后、左、右、上、下视图。

## 场景、物理和动画

```js
studio.scene.setWeather("sunny");
studio.scene.setPhysics({
  enabled: true,
  playing: true,
  gravity: { x: 0, y: -9.81, z: 0 }
});
studio.animation.play();
```

场景 API 还包含环境、后处理、统计和当前渲染后端。对象句柄可控制碰撞、拆解和模型动画。

## 二维组件和数据

```js
studio.component("设备状态")?.update({
  visible: true,
  frame: { x: 80, y: 60, width: 420, height: 240 }
});
studio.setData("device.temperature", 68.5);
studio.page.open("page:detail");
```

二维页面中的实时三维组件会注册真实场景运行时，所以同一段对象和相机代码可由二维组件事件调用。三维组件尚未载入时，应先将其设为“实时”或由用户点击载入。

## Three.js 逃生口

```js
const object3d = studio.object("robot")?.raw;
object3d?.traverse((child) => {
  if (child.isMesh) child.castShadow = true;
});

const raycaster = new THREE.Raycaster();
const scene = studio.raw.scene;
```

`raw` 只在可信实时脚本中开放。脚本创建的几何体、材质、纹理和监听器需要在停止或销毁时主动释放。

## 编辑器快捷键

- `Ctrl+Space`：智能提示。
- `F1`：命令面板。
- `Alt+Shift+F`：格式化。
- `Ctrl+S`：应用修改。
- `Ctrl+Enter`：测试当前事件或运行脚本。

完整的行为脚本说明见[编写和运行行为脚本](/docs/behavior-script)。
