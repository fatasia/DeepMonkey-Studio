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

这段旧式脚本只属于管理员签名的可信扩展路径；普通项目脚本进入 Worker 沙箱并通过公开 Scene SDK 批量提交命令。死循环、长时间同步计算和未授权网络请求必须被预算与权限系统终止。

## 二维看板

手填数据键、Data Hub 数据产品和直接接口都是正式绑定方式，并保留运行期数据键自动补全。URL 网页是独立组件，不要求数据键，支持管理员策略允许的 `http://`、`https://` 和 `/` 开头的站内地址。

常用治理路径通过内嵌 Data Hub 完成；已有 HTTP(S) 或 WebSocket 服务可以直接绑定，无需先创建数据集。直接绑定由同源 `ConnectorGateway` 代理：浏览器不直接请求外部域名，所以不产生 CORS 问题；服务器负责凭据、超时、限流、重连和错误诊断，并把外部 WebSocket 复用到应用级同源 channel。2D 与 3D 使用同一 `DirectBindingSpec`，避免两个编辑器重复连接。

MQTT、OPC UA、Modbus TCP、BACnet 等现场协议由 Data Hub 原生连接器或按需插件接入；浏览器不保存 PLC 地址或凭据。西门子 S7、EtherNet/IP 仍按现场需要安装，不进入默认轻量包。

网页能否嵌入还取决于目标站点的 `X-Frame-Options` 和 CSP `frame-ancestors`。被目标站点禁止嵌入时，应改用对方提供的嵌入地址，或通过受控反向代理部署同源页面。

二维组件事件和 3D 对象事件使用同一个脚本运行时，因此可以从图表控制模型，也可以从模型控制看板。二维图表收到数据并刷新时会触发动画开始/结束。

## 多场景

多场景不是多个孤立编辑器。`ApplicationDocument` 是唯一真源，通过轻量
`spatialNavigation` 把同一业务空间的 2D 页面、3D 场景和设备对象连成一棵树：

```text
智造园区（scene-campus + page-campus）
└── 一号车间（scene-workshop + page-workshop）
    └── 总装线（scene-line + page-line）
        └── 机器人 A（复用 scene-line，聚焦 model:robot-a）
```

空间导航不规定业务层级或深度。节点 `kind` 是项目自定义语义，可表示园区、楼层、展厅、病区、
仓区、系统、工艺段或任何业务对象。节点可关联 3D 场景、2D 页面、当前场景对象，也可只作为分组。
`focus / replace / additive` 只描述加载行为，不解释业务含义。工业模板中的设备默认在当前场景内
聚焦、隔离、拆解和定位；其他行业可按自己的内容组织层级。

### 统一导航

左侧空间树、视口双击、面包屑、二维组件跳转、交互动作、`Esc` 和浏览器返回必须调用
同一个 `SpatialNavigationSession`，禁止各自维护返回逻辑。顶部持续显示当前路径，例如
`园区 / 一号车间 / 总装线 / 机器人 A`。

进入下一层前，导航会保存当前层的临时工作状态：相机、第一/第三人称模式、选择、显隐覆盖、
过滤器、活动面板和编辑器页签。返回时精确恢复这些状态，而不是重新使用默认视角。
2D 与 3D 共用同一个空间节点：在 3D 进入楼层后切到 2D，直接打开该楼层页面；切回 3D 仍在
同一楼层和设备上下文。

### 加载与故障恢复

一个页面只保留一个主 ViewerEngine 和渲染上下文。宿主根据节点 `loadPolicy` 执行：

- `focus`：不切场景，聚焦当前场景内对象；设备节点默认使用。
- `replace`：卸载当前高精度内容后切到完全独立的场景。
- `additive`：保留园区或父级低精度上下文，异步挂载子级高精度内容。

切换时父级继续显示，子级准备完成后再以 0.4–0.8 秒镜头过渡激活。失败时保留父级并提供重试，
不得清空画布。场景资源使用当前路径、父级缓存和相邻节点预取；超出 `cacheLimit` 后按 LRU 回收。
数据订阅、告警、共享变量和 M8 仿真时钟属于应用级运行状态，不随场景资产卸载。

### 发布与验收

发布时固定应用文档及其场景、页面、数据和脚本版本。普通场景浏览不创建多个 Viewer；只有明确的
“场景对比”功能允许最多两个 Viewer，并单独设置显存预算。

必过验收：

1. 园区 → 车间 → 产线 → 设备 → 返回连续 20 次，无空白、错层或明显内存增长。
2. 返回后相机、视角模式、选择、显隐、过滤和面板状态全部恢复。
3. 慢网或子场景加载失败时父场景保持可用。
4. 面包屑、返回、`Esc`、浏览器返回和二维跳转得到相同结果。
5. 深链接直接打开设备时可构建完整路径并加载目标层级。
6. 2D/3D 往返不丢失楼层、产线、设备或数据时间范围。
