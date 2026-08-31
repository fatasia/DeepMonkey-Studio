# `studio` API 覆盖矩阵

`studio` 是二维看板、三维场景和发布运行时共用的应用 API。设计参考 [ThingJS App](https://docs.thingjs.com/cn/apidocs/THING.App.html)、[ThingJS Thing](https://docs.thingjs.com/cn/apidocs/THING.Thing.html)、[Unity Animator](https://docs.unity3d.com/ScriptReference/Animator.html) 与 Three.js 公共 API，但不照搬引擎内部类名。

## 公开面分层

1. `studio`：稳定、带智能提示、跨 WebGL/WebGPU、跨二维/三维的首选 API。
2. `studio.object(id)?.raw`、`studio.raw.*`、`THREE`：可信脚本的完整 Three.js 逃生口。
3. Worker 行为脚本：固定时间步与隔离执行，只用 `ctx.command/query/data`，不持有渲染对象。
4. 插件 SDK：模型转换器、数据连接器和编辑器扩展使用的版本化能力。

## 当前已贯通（API 1.0 第一批）

| 域 | API | 二维实时三维组件 | 三维编辑/运行 |
| --- | --- | --- | --- |
| 查询 | `object`、`objects`、`query`、`selection.get/clear` | 是 | 是 |
| 对象 | 显隐、选择、聚焦、重命名、位置/旋转/缩放、颜色、透明度、PBR 材质读取/增量修改 | 是 | 是 |
| 工业场景 | 碰撞、拆解、模型动画 | 是 | 是 |
| 相机 | Pose、轨道/第一/第三人称、近远截面、相机碰撞、标准视图、视角书签 | 是 | 是 |
| 场景 | 天气、环境、后处理、物理、统计、渲染后端 | 是 | 是 |
| 时间线 | 播放、暂停、跳转、播放状态 | 是 | 是 |
| 二维 | 组件查询、更新、显隐、页面跳转 | 是 | 是 |
| 数据/动作 | 应用变量、类型化交互动作、场景跳转 | 是 | 是 |
| 底层 | `THREE`、Object3D、Scene、Camera、Renderer、ViewerEngine | 可信实时脚本 | 可信实时脚本 |

二维视口通过场景运行时注册表取得真实 `ViewerEngine`，所以对象句柄不是离线快照。视口尚未加载时，导航、显隐、颜色、透明度和动画等动作走可移植交互总线；直接 Three.js 操作要求先载入实时视口。

材质写入分两级：可信实时脚本的 `getMaterial/setMaterial` 可使用编辑器完整材质合同；Worker 行为脚本和数据绑定只接受经过验证的颜色、PBR 数字、双面/线框与 UV 标量，不接受外部贴图 URL。模型材质会进入现有保存与发布快照，跨场景材质写入需要先加载目标三维场景，避免把未执行操作伪装成成功。

## 后续覆盖顺序

### P0：ThingJS/Unity 高频等价能力

- 对象创建、克隆、销毁的持久化命令，以及父子层级、Tag、用户属性、批量查询。
- `lookAt`、世界/局部坐标转换、Quaternion、矩阵、包围盒、射线和拾取结果。
- 动画 Clip 选择、速度、循环、反向、混合、状态机与动画事件。
- Primitive/Mesh/材质/纹理/灯光创建器和统一资源释放。
- 场景异步加载/卸载、进度、取消、缓存和错误恢复。
- `on/off/once` 事件总线、定时器、逐帧与固定时间步。

### P1：专业编辑与工业仿真

- 骨骼、Morph、机器人关节、约束、路径、AGV/物流运动控制器。
- 物理刚体、触发器、碰撞回调、射线/形状查询和角色控制器。
- 裁剪、测量、标注、楼层、拆解、选择集和 BIM 属性查询。
- 数据订阅、HTTP/WebSocket、公式、脚本模块导入和对外接口调用。
- 编辑器窗口、菜单、Inspector、Gizmo、Undo/Redo、Selection 与插件生命周期。

### P2：底层渲染扩展

- InstancedMesh/BatchedMesh、RenderTarget、TSL/NodeMaterial、Compute。
- WebGPU 后处理与 WebGL 等价降级诊断。
- XR、输入映射、音频、视频纹理和云渲染客户端控制。

## 验收门槛

每一项进入“已支持”必须同时满足：运行时真实可调用、Monaco 类型与提示同步、二维/三维语义一致、保存发布后仍有效、至少一个合同测试；涉及视觉或输入的能力还要有 WebGL/WebGPU 浏览器测试。仅存在 `ViewerEngine` 私有方法不算公开 API 已完成。
