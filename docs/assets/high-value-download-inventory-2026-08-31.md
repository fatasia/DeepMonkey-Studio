# 高价值外部资源下载清单（2026-08-31）

本清单只记录本轮主动补充的资源。公共工业模型目录、环境材质和既有开放资源包继续由各自清单管理，避免重复下载或把测试资源误投放到产品素材库。

## 工业机器人参考资源

- 来源：Google DeepMind MuJoCo Menagerie
- 固定版本：`da76818e269b82289eba39808e2fb91d679d6994`
- 本地目录：`data/external-assets/robotics/mujoco-menagerie`
- 已选：17 个机器人/夹爪族，587 个文件，308.6 MiB；每个选中目录均包含独立许可证。
- 用途：提取视觉网格、碰撞网格、关节层级和运动学参数，完善机器人预制体与工位验证。
- 约束：不能把 MJCF 直接当作产品运行格式；进入素材中心前必须转换为 GLB，并生成关节/碰撞/许可证清单。

已选目录：

`agilex_piper`、`dynamixel_2r`、`flexiv_rizon4`、`franka_emika_panda`、`franka_fr3`、`kinova_gen3`、`kuka_iiwa_14`、`low_cost_robot_arm`、`rethink_robotics_sawyer`、`robotiq_2f85`、`robotiq_2f85_v4`、`trossen_wx250s`、`ufactory_lite6`、`ufactory_xarm7`、`unitree_z1`、`universal_robots_ur5e`、`universal_robots_ur10e`。

## glTF 渲染与兼容性样本

- 来源：Khronos glTF Sample Assets
- 固定版本：`9429648735279342b4c32b8745f7904196607379`
- 本地目录：`data/external-assets/conformance/gltf-sample-assets`
- 已选：28 个样本族，707 个文件，413.7 MiB；每个选中目录均包含许可证文件。
- 用途：动画、皮肤、Morph、实例化、灯光、材质扩展、Meshopt、负缩放、多场景和节点压力回归。
- 约束：这是渲染门禁样本，不作为商业素材数量填充；只把许可证允许且具有业务价值的少量模型另行进入公共素材目录。

已选目录：

`AnimatedCube`、`Fox`、`CesiumMan`、`RiggedFigure`、`SimpleInstancing`、`DamagedHelmet`、`FlightHelmet`、`Sponza`、`VirtualCity`、`ClearCoatCarPaint`、`MaterialsVariantsShoe`、`TransmissionTest`、`SheenTestGrid`、`IridescenceAbalone`、`AnisotropyBarnLamp`、`LightsPunctualLamp`、`NodePerformanceTest`、`MeshoptCubeTest`、`SimpleSkin`、`SimpleMorph`、`MultipleScenes`、`NegativeScaleTest`、`TextureTransformTest`、`CesiumMilkTruck`、`CommercialRefrigerator`、`ToyCar`、`TrafficCone`、`CarConcept`。

## 当前下载结论

- 公共工业 GLB：1,551 个有效模型与 1,551 张缩略图，约 2.96 GiB。
- 新增机器人参考：17 族，308.6 MiB。
- 新增 glTF 门禁：28 族，413.7 MiB。
- 环境与材质：28 组 / 105 文件，约 427.8 MiB。
- 开放素材包：14 组，约 66.4 MiB。

当前没有继续批量下载的必要。后续只按最终门禁暴露出的明确缺口补充，不再用低价值文件堆数量。
