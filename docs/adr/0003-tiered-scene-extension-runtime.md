# ADR-0003: 采用分级场景扩展与确定性工业运动运行时

## Status

Accepted

## Context

Industrial Studio 需要支持自定义脚本、相机操作、第一/第三人称、near/far 截面、模型与 Mesh、材质、动画、设备拆解、AGV 和机器人实时运动、物流节拍等高度定制场景。

把所有功能硬编码进编辑器会快速扩大核心；直接把 Three.js、DOM、网络和 Tauri 权限暴露给任意项目脚本，又会导致版本耦合、卡死、越权和不可发布。Worker 沙箱适合业务逻辑，但不能直接执行主线程渲染和高频图形扩展。

## Decision

- 建立版本化 `SceneCapabilitySDK`，覆盖对象树、Transform、Mesh、材质、相机、控制器、动画、时间线、输入、数据和仿真时钟。
- Three.js 保持在 Scene Adapter 内部；普通项目脚本只操作稳定对象 ID 和 capability，不持有 Three.js 或 React 实例。
- 场景扩展分三级：
  1. 公式/配置，不执行任意代码；
  2. Worker 中的项目行为脚本，以批量命令修改主线程场景；
  3. 管理员安装、签名并授权的可信 Scene Extension，可注册主线程 Mesh、材质、后处理、控制器和高频渲染行为。
- 行为脚本使用 `onStart`、`onUpdate`、`onFixedUpdate`、`onData`、`onEvent`、`onStop`、`onDispose` 生命周期。
- 运动和物流仿真使用单一 simulation clock、fixed timestep、带时间戳遥测缓冲、插值、有限外推、暂停、倍速、记录和回放。
- 设备拆解、AGV、机器人和物流节拍作为公开 API 的参考实现与测试夹具，不进入引擎核心特例。
- 第一/第三人称控制器通过 `studio.collision` capability 使用稳定的碰撞层、角色胶囊、扫描移动和接触结果；Rapier、`three-mesh-bvh` 或其他实现只存在于 Scene Adapter/插件，项目脚本不持有物理世界或 BVH 私有对象。
- 第一人称碰撞按项目启用，包含重力、地面吸附、台阶、最大坡度、滑墙、连续扫描防高速穿透和非法出生点脱困；编辑器提供碰撞代理、接触点和忽略层的调试视图。
- 每个脚本和扩展声明能力权限；发布包记录 SDK/Extension API 版本和权限清单。
- 将“达到 ThingJS 级可编程性”作为 M0-M6 的持续架构门禁：公开 SDK 必须覆盖应用/对象、事件、相机与控制器、Mesh/材质、动画/时间线、数据和组件扩展，不以暴露 `ViewerEngine` 或 Three.js 私有对象充数。
- M0 固化 `SceneCapabilitySDK 1.0` 的纯协议、命令/查询/事件、生命周期、插件 manifest 与兼容性协商；M3 实现 Worker 行为 SDK 和调试工具；M4 接通三维运行时与双渲染后端；M5 开放转换/地图/拓扑扩展；M6 发布稳定 SDK、文档、模板与第三方插件门禁。
- `SceneExtensionManifest` 必须声明扩展 ID、语义版本、SDK API 版本、入口、执行级别、能力/权限、宿主和渲染后端兼容范围；加载前完成确定性兼容检查。
- 保留轻量 GIS，并将云渲染放在最终阶段；不建设 3D Tiles、倾斜摄影、海量地形/点云或完整 Unity 兼容层。

## Non-Functional Requirements

- 项目行为脚本死循环、异常或连续超预算时可被终止，不阻塞编辑器和其他行为。
- `onUpdate`/`onFixedUpdate` 的 CPU 时间、消息数量和场景命令数量可观测并有预算。
- 相同初始状态、固定步长和输入事件应得到可重复的仿真结果。
- 遥测短时抖动或断流时运动连续；超过外推上限后明确进入 stale/offline 状态。
- 第一人称控制器在低帧率、高速移动、薄墙、台阶、斜坡和初始重叠黄金场景中不得穿模、持续抖动或永久卡死；关闭碰撞时不加载可选物理插件。
- B/S 与 Tauri 使用同一 Scene Runtime 和脚本语义。
- Scene Capability API 采用语义版本；破坏性变化必须提供迁移器或兼容适配层。
- TypeScript 类型、自动补全、API 参考、最小示例、日志和兼容诊断与 SDK 同版本交付。
- 设备拆解、AGV、机器人、物流节拍四个参考应用只能导入公开 SDK；架构测试禁止其深层导入 Scene Adapter 或 `ViewerEngine`。
- 第三方示例插件无需修改核心代码即可安装、禁用和卸载；插件异常可被独立熔断且不损坏项目文档。

## Consequences

### Positive

- 常规项目获得安全、可调试的脚本能力，复杂项目仍有底层扩展出口。
- 渲染引擎升级不会直接破坏所有业务脚本。
- AGV、机器人和物流动画共享时钟、数据缓冲和回放能力，减少重复实现。
- 核心保持精简，行业特定功能可以独立交付和移除。

### Negative

- Worker 到主线程的命令桥需要批处理，高频逐对象调用必须优化。
- 可信扩展仍可能影响渲染稳定性，需要签名、版本锁定、性能监测和故障禁用。
- 自定义 Three.js 代码需要迁移到 Extension API，不能作为普通内联脚本运行。

### Neutral

- 不承诺复刻 Unity 的完整物理、游戏平台、着色器工具和资产生态；目标是覆盖工业 Web 三维场景的可扩展性。

## Failure Modes

| Failure | Impact | Mitigation |
| --- | --- | --- |
| 行为脚本死循环/消息风暴 | UI 卡顿或内存增长 | Worker 终止、时间/消息预算、批量命令和背压 |
| 可信扩展抛错 | 当前场景渲染异常 | Error boundary、扩展级熔断、安全模式启动和诊断日志 |
| 遥测乱序/抖动 | AGV/机器人跳变 | 时间戳排序、抖动缓冲、插值和有限外推 |
| 仿真与实时数据争夺对象 | 状态不确定 | 每个属性声明权威来源和优先级，冲突进入调试面板 |
| SDK 升级不兼容 | 旧项目无法运行 | 发布包锁定 API 版本，兼容层和迁移检查 |

## Alternatives Considered

**向所有脚本暴露 Three.js 和浏览器全局对象**：拒绝。无法隔离故障和权限，升级成本由每个项目承担。

**所有脚本都只在主线程运行**：拒绝。JavaScript 无法安全抢占死循环，项目脚本可以拖死整个编辑器。

**所有扩展都放进 Worker**：拒绝。自定义渲染、材质和高频控制需要主线程/WebGL 上下文，Worker 不能覆盖全部场景能力。

**把设备拆解、AGV、机器人分别做成核心子系统**：拒绝。它们应由时间线、运动、数据和状态机能力组合，避免重复和行业特例污染核心。

## References

- [Industrial Studio 产品与架构规划](../dev-studio-product-and-architecture-plan.md)
- [ThingJS 官方指南](https://www.thingjs.com/guide/)
- [ThingJS API 索引](https://docs.thingjs.com/cn/apidocs/)
- [ThingJS App API](https://docs.thingjs.com/cn/apidocs/THING.App.html)
- [ThingJS 摄像机教程](https://docs.thingjs.com/cn/App_dev/Tutorial/Content/camera.html)
- [Unity Game View 与 Play Mode](https://docs.unity3d.com/kr/current/Manual/GameView.html)
- [Unity Timeline](https://docs.unity3d.com/ja/6000.0/Manual/com.unity.timeline.html)
