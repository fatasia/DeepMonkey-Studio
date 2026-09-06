# ROBOT-002 · 显式 rosbridge 会话与关节遥测

状态：已完成限定集成验证；真实 Studio 双主题两轮8/8通过，未连接真机。

## 最小交付与归属

机器人检查器提供独立 `RobotConnectionPanel`。显式连接浏览器 WebSocket，默认 `/joint_states`，支持 ROS 1 / ROS 2 类型预设；不自动连接、重连或随应用发布启动。配置只在当前组件内存，不写作者场景、账号配置或发布包。ROS 不作为开发环境启动依赖。

面板通过 `modelId`、可选 `owner`（Viewer 实例）、稳定的关节名签名及 `disabled` 确定会话归属；父层传入 `onTelemetry`、`onRestorePose`、`readPose`。对象、场景/Viewer 切换、禁用或卸载时关闭旧 socket、取消 RAF/超时，复原旧实例。新渲染与 layout effect 清理之间的旧回调也必须通过归属校验。正常服务端关闭同样复原；应用遥测失败转受控错误并断开。

`onTelemetry` 只调用 Viewer 的瞬时 `applyRobotTelemetry`，不更新作者姿态、历史、React 场景状态。默认“跟随遥测”；父层通过 `onFollowingChange` 在会话跟随期间禁用作者关节编辑。取消跟随立即复原作者姿态，继续收帧/校验但不应用，允许编辑作者目标。重新勾选后下一有效帧恢复跟随。

## 协议与验证

- ROS 2：`sensor_msgs/msg/JointState`；ROS 1：`sensor_msgs/JointState`。订阅 `throttle_rate:16`、`queue_length:1`、`compression:none`。
- 按名称自动映射，不依赖数组顺序；每帧最多 512 个关节、单名最多 256 字符。未知名忽略并显示数量，没有任何匹配不能算有效。
- 重复名、非有限数值、name/position 长度不一致、非空 velocity/effort 长度或数值异常、无效时间戳一律拒绝。
- ROS 2 `sec/nanosec`、ROS 1 `secs/nsecs` 以 BigInt 纳秒比较，拒绝旧/重复非零时间戳；重连新会话才重置时钟。缺失/零时间戳接受到达顺序并显示“无源时间戳”，不假称已验证源顺序。
- ROS 仿真时间可能不是 Unix 时间，不将源时间戳和浏览器 epoch 比较。有效帧本地接收后 2 秒过期；此判定不是设备安全 watchdog，也不能识别一个带全新递增时间戳但源数据实际已陈旧的上游。
- 最多一个待应用最新帧槽和一个 RAF。高频输入覆盖旧缓冲，不逐帧触发 React；状态仅在状态/匹配元数据变化时通知。暂停标签页积存的帧过期后不应用。
- 连接超时 5 秒。文本帧限制为 256 KiB UTF-8；消息不存日志。URL 拒绝内嵌用户名密码、查询参数和片段；HTTPS 页面要求 wss。错误使用固定文案，不回显端点或服务端任意文字。
- 可选 `/rosapi/topics`：请求关联 ID、5 秒超时、数组长度校验，仅显示所选版本 JointState 类型。下拉选择显式关闭旧连接并建立新主题订阅，同时清除发送启用状态。

## 显式姿态命令

“控制”默认折叠，必须本会话勾选启用、填写控制主题与 0.1–60 秒目标时长，点击“发送目标姿态”。只发送作者 `readPose` 的全部可驱动关节 SI 值（rad/m），固定与 mimic 不进入命令。

只实现单点 `JointTrajectory`。ROS 1 为 `trajectory_msgs/JointTrajectory`、duration `secs/nsecs`，ROS 2 为 `trajectory_msgs/msg/JointTrajectory`、duration `sec/nanosec`。无非有限值、缺失关节、过期/不完整遥测时禁止发送。socket 已有积压或 500 ms 内重复点击会拒绝。最多保留一个命令主题广告；关闭时尽力 unadvertise，不等网络回执，不自动重放。

ROS 1 广告 `latch:false, queue_size:1`；ROS 2 明确 volatile、keep_last、depth 1、reliable。应用这些字段不等于验证任意厂商控制器兼容，也不构成跨客户端控制租约。不会发送 cmd_vel。

WebSocket send 返回后只能显示“已发送，未确认”；rosbridge 关联错误可显示“控制错误，设备执行状态未知”。没有设备执行 ACK、动作完成保证、硬件安全停止能力或通用厂商驱动。仅本地模拟 rosbridge 用于命令测试，未连接用户设备。

## 官方依据

协议和消息定义按官方源码核对，而非假设消息格式：

- [RobotWebTools rosbridge v2.1 protocol](https://github.com/RobotWebTools/rosbridge_suite/blob/ros2/ROSBRIDGE_PROTOCOL.md)：subscribe、publish、service 和 QoS。
- [ROS 2 JointState](https://github.com/ros2/common_interfaces/blob/rolling/sensor_msgs/msg/JointState.msg)：名称与数组契约。
- [ROS 2 JointTrajectory](https://github.com/ros2/common_interfaces/blob/rolling/trajectory_msgs/msg/JointTrajectory.msg)、[JointTrajectoryPoint](https://github.com/ros2/common_interfaces/blob/rolling/trajectory_msgs/msg/JointTrajectoryPoint.msg)。
- [ROS 1 JointTrajectoryPoint](https://github.com/ros/common_msgs/blob/noetic-devel/trajectory_msgs/msg/JointTrajectoryPoint.msg)。
- [rosapi Topics](https://github.com/RobotWebTools/rosbridge_suite/blob/ros2/rosapi_msgs/srv/Topics.srv)。

## 验证记录

2026-09-06：自有聚焦 4 文件 / 32 测试通过，Web `tsc --noEmit` 退出 0：解析与命令验证、单槽背压与元数据去重、超时/旧帧/断开/回调异常、UTF-8 帧限额、未关联错误不误报命令结果、真实本机 ROS 1 / 2 WebSocket 握手/订阅/发现/一次显式发布/服务器错误/取消订阅、面板初始静态结构。SSR 测试不覆盖 React 挂载、owner 切换、跟随开关或真实三维应用，这些不能冒充已有单测证据。

浏览器入口 `apps/web/scripts/gate-robot-connection.mjs` 使用隔离 API、现有真实 Chrome 门禁、自制 `urdfGateFixture.mjs`、真实本机 WebSocket 模拟对端；设计为深浅主题 × 1440/980，两轮截图。检查从真实检查器连接、3D 像素变化/复原、作者关节未受遥测污染、错误/过期、主题切换、编辑目标、显式发送未确认、断连/页面退出，以及期间零作者 API 写。尚未运行，不能宣称通过。

## Design Read 与待验收

UI 遵循 `design-taste-digitaltwin`：参考西门子工业检查器的单位/关节语义，借鉴 Unity Inspector 的紧凑字段、局部操作与进阶折叠。沿用现有 surface/text/line/accent/success/danger 令牌；不追加大段说明卡、装饰 badge 或自动动作。主状态为连接/遥测，其余只保留匹配与具体错误；ROS 配置和作者关节独立分组。

最终两轮：r15 `robot-connection-dgfs4G` / r16 `robot-connection-V6jq3v`，各暗/亮×1440/980四组通过。两构建间ROS产品代码未改。每组500帧突发、主题选择、过期/错误、一次显式发布与500ms防重复、5会话全部关闭、对象切换/重载清理、作者零写均通过。真实3D像素变化及断开复原已断言；控制仍只显示已发送未确认。前述“尚未运行”为历史状态，由本记录覆盖。

截图亲审、10维评分及未达标项见 `../robot-integration-verification-2026-09-06.md`；不声称全站Kimi-95。
