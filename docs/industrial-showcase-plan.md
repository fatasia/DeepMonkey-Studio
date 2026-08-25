# 智造园区综合案例

这是通用空间导航的一份工业预制模板，不是平台固定的信息模型。最终内置案例不是一段只读宣传动画，
而是一份可编辑、可发布、可拆解学习的应用文档，用来同时证明
二维大屏、三维场景、数据、脚本、插件和客户端发布链路。

## 用户路径

```text
3840×2160 工厂运营大屏
└── 智造园区总览
    └── 一号物流车间 / 楼层分解
        └── 总装产线 / 节拍与 WIP
            └── 机器人单元 / 设备拆解与健康状态
```

- 大屏展示产量、计划达成率、节拍、WIP、设备利用率、能耗、告警和 AGV 状态。
- 点击大屏区域或双击 3D 建筑进入下一层；面包屑、返回键和 `Esc` 使用同一空间导航。
- 车间支持楼层逐层升起、显隐和复位；第一人称开启碰撞，第三人称跟随巡检角色。
- 产线显示 Source、Process、Buffer、Sink、物流路径和 AGV；可在实时模拟、离散仿真和历史回放间切换。
- 机器人单元支持聚焦、隔离、拆解、动画播放、温度/振动告警和维护建议入口。

## 模拟数据

数据使用固定种子的确定性生成器，既能实时推进，也能按同一时间线回放：

| 主题 | 关键字段 | 2D/3D 用途 |
|---|---|---|
| `factory.kpi` | output、target、cycleTime、wip、utilization | KPI、趋势、瓶颈着色 |
| `agv.telemetry` | vehicleId、position、heading、speed、mode、status、timestamp | AGV 位姿、状态和轨迹 |
| `line.status` | lineId、orderId、completed、state | 产线状态、订单进度 |
| `equipment.status` | equipmentId、temperature、vibration、health、alarm | 设备颜色、告警、预测维护 |

数据只通过 Data Hub 契约和公开场景命令驱动，案例代码不得直接访问 Viewer 私有字段。

## 资源原则

- 优先使用项目内程序化低多边形几何构建园区、建筑和产线，使案例离线可运行且没有外部许可风险。
- 需要验证 glTF 材质或动画时，只选许可证明确的 Khronos Sample Assets；每个资源保留来源、作者、许可证和版本清单。
- 环境贴图和纹理只选 Poly Haven CC0；图标和补充低多边形资源可选 Kenney CC0。
- 不抓取或重新分发 ThingJS、51WORLD、Unity、Siemens 示例中的专有模型，只学习交互和信息架构。

## 验收

1. 初次进入可在三次操作内理解“看板总览 → 3D 下钻 → 设备详情”的主路径。
2. 四层连续下钻、2D/3D 往返和返回状态恢复全部通过。
3. 楼层分解、第一/第三人称碰撞、机器人拆解、动画和 AGV 运动均可操作，不是视频假演示。
4. 任一 KPI 或告警可追踪到模拟数据字段，任一设备可从 3D 定位到对应 2D 指标。
5. 禁用 Factory Flow 插件后，案例仍可打开、编辑和发布，仅仿真控制显示为不可用。
6. 在 WebGPU 与 WebGL 2 下运行同一流程，性能和视觉差异记录进入总体评估报告。

## 调研依据

- ThingJS：`SceneLevel.current / previous / change / back`、双击进入和右键退出的层级交互；园区、建筑、楼层和设备逐级展示。
  - https://docs.thingjs.com/cn/App_dev/Tutorial/Content/scene_level.html
  - https://docs.thingjs.com/cn/apidocs/THING.SceneLevel.html
- Unity：Additive Scene 保留父场景、异步加载避免切换卡顿、Cinemachine 负责相机跟随与平滑过渡。
  - https://docs.unity3d.com/6000.1/Documentation/ScriptReference/SceneManagement.LoadSceneMode.Additive.html
  - https://docs.unity3d.com/ja/current/ScriptReference/SceneManagement.SceneManager.LoadSceneAsync.html
- 51WORLD WDP：场景、画布、数据和事件节点协同；面板作为场景之上的交互入口。
  - https://www.51world.com.au/developer/super-gui
  - https://wdp-staging.51aes.com/product-service5?loggedIn=false
- Siemens Plant Simulation：按工厂、生产区和单机组织层级模型，并以吞吐、周期、WIP、利用率、瓶颈和 AGV 作为工厂物流分析主线。
  - https://www.siemens.com/en-us/products/tecnomatix/plant-simulation-software/
- 可分发资源：Khronos glTF Sample Assets 按模型列出许可证；Poly Haven 与 Kenney 提供 CC0 资源。
  - https://github.com/KhronosGroup/glTF-Sample-Assets
  - https://docs.polyhaven.com/en/faq
  - https://kenney.nl/support
