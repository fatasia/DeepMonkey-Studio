import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";

const issues: Record<string, [string, string]> = {
  url: ["地址须为 ws/wss，不含用户名、密码或查询参数；HTTPS 页面须使用 wss。", "Use ws/wss without credentials or query parameters; HTTPS requires wss."],
  topic: ["主题须以 / 开头，仅使用字母、数字和下划线。", "Use an absolute topic with letters, numbers and underscores."],
  "model-joints": ["模型没有唯一可驱动关节，无法连接。", "The model has no unique controllable joints."],
  socket: ["WebSocket 连接或发送失败，请核对地址、服务及浏览器网络限制。", "WebSocket connection or send failed; check the endpoint, service and browser network policy."],
  timeout: ["连接超过 5 秒；请检查 rosbridge 是否运行。", "Connection timed out after 5 seconds; check rosbridge."],
  closed: ["连接已关闭；需手动重新连接。", "Connection closed; reconnect manually."],
  subscription: ["rosbridge 拒绝订阅，请核对主题类型与权限。", "rosbridge rejected the subscription; check topic type and permissions."],
  stale: ["2 秒未收到有效姿态，已停止更新。", "No valid pose for 2 seconds; updates stopped."],
  payload: ["已拒绝非 JSON 文本或超过 256 KiB 的帧。", "Rejected a non-text or oversized frame (256 KiB maximum)."],
  json: ["已拒绝无效 JSON 消息。", "Rejected invalid JSON."],
  "frame-shape": ["JointState 必须是对象。", "JointState must be an object."],
  "frame-names": ["关节名为空、过长或超过 512 个。", "Joint names are empty, too long or exceed 512 entries."],
  "frame-duplicate": ["帧中有重复关节名，已拒绝。", "Rejected duplicate joint names."],
  "frame-positions": ["name 与 position 长度不一致，已拒绝。", "Rejected mismatched name and position arrays."],
  "frame-optional-arrays": ["velocity/effort 须为空或与 name 等长。", "velocity/effort must be empty or match name length."],
  "frame-non-finite": ["帧含 NaN、Infinity 或非数值，已拒绝。", "Rejected NaN, Infinity or non-numeric values."],
  "frame-stamp": ["时间戳不符合所选 ROS 版本。", "The timestamp does not match the selected ROS version."],
  "frame-unmapped": ["帧中没有匹配的模型关节。", "No frame joint names match this model."],
  "old-frame": ["已忽略旧帧或重复时间戳；ROS 时钟重置后请重连。", "Ignored an old or repeated timestamp; reconnect after resetting the ROS clock."],
  "telemetry-apply": ["姿态无法应用到当前模型，连接已关闭。", "Could not apply telemetry to this model; disconnected."],
  "not-connected": ["请先连接 rosbridge。", "Connect to rosbridge first."],
  disconnected: ["连接已断开。", "Disconnected."],
  "discovery-busy": ["正在读取主题，请稍候。", "Topic discovery is already running."],
  "discovery-timeout": ["读取主题超时；可手动输入主题。", "Topic discovery timed out; enter the topic manually."],
  "discovery-response": ["rosapi 主题查询失败或响应格式无效。", "rosapi topic discovery failed or returned an invalid response."],
  "control-disabled": ["请先启用本次姿态发送。", "Enable pose sending for this session first."],
  "control-topic": ["请填写有效的 JointTrajectory 控制主题。", "Enter a valid JointTrajectory command topic."],
  "control-duration": ["目标时长须为 0.1–60 秒。", "Target duration must be 0.1–60 seconds."],
  "control-pose": ["当前姿态须包含全部可驱动关节的有限数值。", "The pose must contain finite values for every controllable joint."],
  "control-not-live": ["仅在全部关节遥测有效且未过期时允许发送。", "All joints must have fresh, valid telemetry before sending."],
  "control-busy": ["连接不可用或仍有待发数据，请稍后手动重试。", "Connection unavailable or data is still pending; retry manually."],
  "control-rejected": ["rosbridge 返回控制错误；设备执行状态未知。", "rosbridge reported a command error; device execution is unknown."],
};
export function rosbridgeIssueMessage(locale: AppLocale, issue: string): string {
  const message = issues[issue] ?? ["操作失败，请断开后检查服务。", "Operation failed; disconnect and check the service."];
  return tr(locale, message[0], message[1]);
}
