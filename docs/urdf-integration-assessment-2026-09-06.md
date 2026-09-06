# URDF 对现有机器人与素材链路的价值

## 已核验的结论

URDF 值得作为机器人专用导入能力补齐，优先于继续增加没有运动学信息的机器人外观模型。它是结构描述格式，不是物理仿真器，也不是通用 CAD 转换器；仅导入它不能宣称获得工业级逆运动学、避障、控制器程序或准确节拍。

用户提供的微信链接在当前工具中无法读取，直接重试仍被拦截；随后用户提供完整正文《具身机器人的前端长什么样？Three.js + WebGPU 渲染，核心是这套URDF + WebSocket 控制协议》。下节据用户正文核验，不再受链接访问阻塞。没有取得文章工程源码或运行视频，不把文中演示当作已复现实机能力。

## 文章具体判断：有用，URDF 优先；示范控制不能直接当作生产控制

1. **最值得采用：机器人结构资产化。** URDF 不只是增加一种模型后缀，它补的是连接、关节类型、局部坐标、限位与碰撞结构。我们应复用现有素材管线和3D工作台，不新建文章那样的专用 Vue 控制台，也无需更换 React。
2. **分层消费遥测可采用，但频率不是标准。** 30Hz设备流→非React高频缓冲→渲染帧插值→低频图表快照，适合我们的机器人/AGV与数据大屏；10/30/5Hz应由源设备与订阅需要决定，不全局写死。已有WebSocket网关与诊断低频采样应复用，不重复建数据中台。
3. **双后端是已有能力，不重做。** 现有WebGL/WebGPU、设备丢失回调和场景快照恢复继续保留；当前发布选择有实际能力签署，不因为文章使用WebGPU优先就改掉所有发布默认策略。
4. **控制协议是参考起点，不是“换通信层即实机”。** 文章使用Node模拟器和正弦步态；同构关节角展示不等于真实步态控制、平衡、力矩约束或现场控制器适配。当前任务不直接连接/驱动物理设备。

### 逐条校正

- **加载回调不是“假的”，是不同就绪阶段。** 当前loader确实先parse再回调，网格可能未完成；需在启动前挂好专属LoadingManager，并检查每个资源失败与预期网格数，不能只看pending归零。`parseCollision`默认false，想做碰撞就必须显式解析及验证。来源：[URDFLoader源码](https://github.com/gkjohnson/urdf-loaders/blob/master/javascript/src/URDFLoader.js)。
- **限位并非全套控制保护。** loader对revolute/prismatic位置夹紧，continuous关节没有同样的位置夹紧；角度是rad、位移是m，effort/velocity字段存在不代表setJointValue替我们限制实际速度、力矩。我们的显示层可用°，持久化/协议必须声明单位。来源：[URDFClasses源码](https://github.com/gkjohnson/urdf-loaders/blob/master/javascript/src/URDFClasses.js)。
- **根层坐标转换是正确方向，但不能无条件重复旋转。** ROS常规body为X前/Y左/Z上，当前Viewer为Y上；在导入适配器记录一次坐标变换，保持网格与关节origin语义，不逐mesh拍脑袋旋转。嵌套手部若已在父局部坐标中，再做一次整机Z→Y会破坏装配。来源：[ROS REP-103](https://github.com/ros-infrastructure/rep/blob/master/rep-0103.rst)。
- **站姿后包围盒落地适合演示初始摆放，不是真机里程计修正。** 网格和关节就绪后再`updateMatrixWorld`和求边界；真实遥测接入后保留设备base frame与校准，不每帧将最低点重新吸附地面。
- **不直接合并左右手joint字典。** `Object.assign`遇同名键会覆盖；应使用实例/左右部件命名空间、显式腕部变换与稳定link/joint映射，同时维护frames/links/mimic依赖。当前16关节轻量合同也不足以无损容纳文章40关节手部，必须先补合同与运行态。
- **指数平滑会滞后，不保证30Hz自动成为60fps。** 位置、关节和姿态应对齐同一时间戳；旋转用最短角或四元数插值，处理±π跨界，限制外推并显式标记stale，不能让平滑掩盖掉线。图表环形缓冲限制长度，组件卸载必须停订阅。
- **不接管全局console.error再整页重载。** r185已有`onDeviceLost`和`onError`回调，初始化fallback是明确的初始化路径，并非覆盖所有运行时着色器故障；应在当前恢复控制器内降级、保留草稿和连接状态。`location.replace('?webgl=1')`会重建整页并丢失其它查询上下文，不能据此承诺业务无中断。来源：[Three r185 Renderer](https://github.com/mrdoob/three.js/blob/r185/src/renderers/common/Renderer.js)、[WebGPURenderer](https://github.com/mrdoob/three.js/blob/r185/src/renderers/webgpu/WebGPURenderer.js)。
- **500ms置零的是目标，不是瞬停。** 文中还有加速度积分，因此看门狗延迟后仍有减速时间和距离。它适合模拟设备的失联保护演示，不能替代设备控制器的独立停机/急停机制或现场验证。

### 我们的协议增补建议

应在既有网关增加版本化机器人适配，不让发布浏览器默认拥有控制权：

- 共同消息头：protocolVersion、robotId、sessionId、seq、源时间戳/接收时间戳、frameId与单位；关节按稳定名称映射。
- 遥测：同一时刻的base pose/quaternion、joint positions、速度和设备状态；拒绝无效值、旧session与倒序帧，显式区分offline/stale/live。
- 命令：明确归一化值到m/s、rad/s的机型映射；单控制者租约、过期时间、释放摇杆/窗口失焦置零意图；服务端与设备各自限幅。重连不自动重放旧速度或动作。
- 动作/模式：commandId、幂等语义和accepted/running/succeeded/failed回执；网络断开后的不确定结果必须查询确认，不能自动重试造成重复动作。
- 渲染只读展示、模拟控制、实机控制分成明确模式；只读页面不加载控制能力。真实硬件接入与证据单独验收，当前不操作物理设备。

推荐顺序：URDF资源/关节预览 → 只读遥测与录制回放 → 现有仿真面板的模拟操作 → 经实际设备协议核验的适配器。先补基础输入，再谈摇杆和动作按钮。

## 当前代码与真实缺口

- `apps/web/src/viewer/robotKinematics.ts` 已有品牌无关的机器人链、额定负载/TCP/工具质量来源和输入归一化；首版链目前按骨骼深度/长度生成，默认 Z 轴与 ±180°，最多保留 16 个关节。
- `packages/contracts/src/scene.ts` 的 `SceneRobotJointState` 只有骨骼路径、名称、X/Y/Z 轴、长度与角度范围；没有通用任意轴向、关节原点完整姿态、平移关节单位、mimic、每连杆惯性与独立碰撞形状。
- 作者已有 rig/IK/工位验证/Study，不应另建第二个独立机器人编辑器。当前源码没有 URDF/Xacro 导入适配器，不能把已有 GLB 与骨骼动画当作已支持 URDF。
- 既有资源清单记录 17 族 MuJoCo Menagerie 参考资源，但它们是 MJCF 参考输入；不能自动按 URDF 格式入库或把关节字段默默丢掉后称已支持。

## 对产品的作用

| 现有链路 | URDF 可提供的输入 | 必须补的适配 |
|---|---|---|
| 模型优化 / 素材库 | 连杆及 visual 网格、材料引用 | 机器人包导入、资源清单与许可证、缺失网格报告；优化不得合并掉关节层级 |
| 3D 对象树 / 检查器 | link/joint 父子结构、origin、axis、limits | 稳定关节 ID、角度/位移单位、滑杆与复位；与场景实例身份分离 |
| 工位机器人面板 | 正向关节姿态与限位 | 复用既有时间线、姿态教学和 Study；对导入能力逐项声明 |
| 碰撞 / 后续仿真 | 每连杆 collision、mass/inertia | visual/collision 分开，惯性参考系正确转换；物理约束和求解器另行验证 |
| 外部机器人生态 | 可交换的机器人结构 | 保留原始描述与依赖、往返检查；不引入 ROS 运行环境作为 Web 启动必需依赖 |

ROS 官方说明明确区分 visual、collision 与 inertial；连杆和关节构成树，关节描述还包含 origin、axis、limit 与 mimic。来源：[URDF 数据结构](https://docs.ros.org/kinetic/api/urdf/html/index.html)、[ROS 物理与碰撞属性教程](https://docs.ros.org/en/humble/Tutorials/URDF/Adding-Physical-and-Collision-Properties-to-a-URDF-Model.html)。

## 推荐技术路线（待实施，不是已交付能力）

保持一个工作台：机器人包 → 模型导入/优化 → 素材库机器人资源 → 3D 独立实例 → 关节检查器 / 工位仿真面板 → 保存与发布。

1. 先建立不丢信息的机器人资源合同，保留原始 URDF、依赖网格、关节/连杆拓扑和能力诊断；运行态实例只保存姿态与业务绑定。不可将任意轴强制降为 X/Y/Z 或把平移范围当成角度。
2. 优先静态 URDF + 本地 ZIP 包。限制包内相对资源映射，检查路径穿越、缺失文件、同名链接、环/多根、无效数值与大小限制；不根据 `package://` 任意读取主机目录。Xacro 预处理作为显式可选步骤，不执行包内脚本或任意命令。
3. 用成熟加载器验证 basic joint / mimic / 多 visual / collision 子集，与当前 Three.js 版本做兼容门禁；只把通过的子集对外开放。保留关节层级进行网格压缩；原描述与派生 GLB/元数据同时存证。
4. 在现有机器人检查器显示轴、限位和零位，作者可拖动单关节、记录姿态、恢复与回放。现有轻量 IK 不能自动当成适配任意机械臂的求解器。
5. 两个同资源实例独立运动，保存→刷新→2D 预览→发布读取保持相同姿态；缺网格、错误轴/单位、不支持关节类型、替换后不兼容均明确反馈，不生成假机器人。

`gkjohnson/urdf-loaders` 有 Three.js 加载器、package 映射、自定义网格加载回调和 `setJointValue` 接口，是适配优先候选；仓库声明 Apache-2.0。它的 README 把 Xacro 处理作为另一个解析器步骤，因此不能仅安装 URDF loader 就声称任意 Xacro 可导入。来源：[官方 JavaScript 文档](https://github.com/gkjohnson/urdf-loaders/tree/master/javascript)。

独立检索还发现 `OpenLegged/URDF-Studio`，其自述覆盖拓扑、碰撞、硬件配置、装配及多格式交换，可用作交互与合同设计参考。它采用 R3F 工作台，而当前工程是既有 Three.js Viewer，整套照搬会产生第二套渲染/状态所有权；应先审核心解析器、数据模型、许可证及兼容测试，再决定复用边界。未实际运行其代码，README 能力不计入我们的完成清单。来源：[项目官方 README](https://github.com/OpenLegged/URDF-Studio)。该项目与微信文章是否相同尚未确认。

## 验收范围

最小真实验收样本应包括机械臂、夹爪 mimic、平移轴和错误包；分别验证已知零位及若干关节姿态、坐标轴/单位、资源往返、同源双实例、视觉与碰撞分离、关节限位及缺失字段。自带惯性不等于准确节拍或额定承载能力，负载结论仍须来源证据。

2026-09-06 用户追加：ROS 与 URDF 易接入正式纳入本轮实施；不再仅为价值评估。原生包导入、关节预览、ROS 连接向导与状态联动正在开发，尚未验收。新增依赖候选已核实为 Web 按需 `urdf-loader@0.13.1`（Apache-2.0，兼容 Three >=0.152）、API `fast-xml-parser@5.11.1`（MIT）；复用已有 JSZip，不另造 XML/关节求解器。既定第 3/6 项暂停、admin/admin、PostgreSQL+MinIO 和不 push 等约束保持。

## ROS 接入实施边界

URDF 可离线预览，不依赖 ROS。ROS 连接作为可选设备接入，优先 ROS 2 rosbridge/WebSocket：连接检测、Topic 选择、JointState 名称映射、有效帧与过期状态、显式断开；不因页面载入或发布自动连接和发送指令。协议通过 Topic/Service/Action 操作工作，Topic 发现依赖 rosapi 服务，不等于浏览器直接运行 ROS/DDS。[rosbridge 官方协议](https://github.com/RobotWebTools/rosbridge_suite/blob/ros2/ROSBRIDGE_PROTOCOL.md)。

控制入口与只读遥测分开；按已验证消息类型开放，不能把网络写入成功当动作完成，不能用前端超时替代设备侧看门狗。实机与 ROS 发行版的真实验证证据单独记录，不把模拟协议测试扩大成所有机器人兼容。用户界面只保留名称、操作和必要状态，其余解释按需查看。
