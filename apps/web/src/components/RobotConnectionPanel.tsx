import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Cable, CircleCheck, CircleOff, LoaderCircle, TriangleAlert } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import { ROS_JOINT_TYPES, type JointValues, type RosVersion } from "../robots/rosbridgeJointState";
import { rosbridgeIssueMessage } from "../robots/rosbridgeMessages";
import { useRobotConnection, type RobotConnectionBindings } from "./useRobotConnection";
import "./RobotConnectionPanel.css";

export function RobotConnectionPanel(props: RobotConnectionBindings & { locale: AppLocale; readPose(): JointValues; onFollowingChange?(following: boolean): void }) {
  const { locale } = props;
  const [url, setUrl] = useState("ws://localhost:9090");
  const [topic, setTopic] = useState("/joint_states");
  const [version, setVersion] = useState<RosVersion>("ros2");
  const [topics, setTopics] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [issue, setIssue] = useState("");
  const [controlEnabled, setControlEnabled] = useState(false);
  const [commandTopic, setCommandTopic] = useState("");
  const [duration, setDuration] = useState("2");
  const [following, setFollowing] = useState(true);
  const [sendCoolingDown, setSendCoolingDown] = useState(false);
  const sendTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const runtime = useRobotConnection(props, following);
  const { state } = runtime;
  const connected = ["waiting", "live", "stale"].includes(state.status);
  const busy = connected || state.status === "connecting";
  useEffect(() => { setControlEnabled(false); setIssue(""); setTopics([]); setDiscovering(false); setFollowing(true); }, [props.modelId, props.owner]);
  useEffect(() => { if (!connected) setControlEnabled(false); }, [connected]);
  const followingActive = following && busy && !props.disabled;
  useLayoutEffect(() => { props.onFollowingChange?.(followingActive); }, [props.onFollowingChange, followingActive]);
  useLayoutEffect(() => () => { props.onFollowingChange?.(false); }, [props.onFollowingChange]);
  useEffect(() => () => { clearTimeout(sendTimer.current); }, []);
  const statusLabel = ({ idle: ["未连接", "Not connected"], connecting: ["连接中", "Connecting"], waiting: ["等待姿态", "Awaiting pose"], live: ["遥测有效", "Live telemetry"], stale: ["遥测过期", "Stale telemetry"], disconnected: ["已断开", "Disconnected"], error: ["连接失败", "Connection failed"] } as const)[state.status];
  const StatusIcon = state.status === "connecting" ? LoaderCircle : state.status === "live" ? CircleCheck : state.status === "error" || state.status === "stale" ? TriangleAlert : CircleOff;
  const discover = async () => {
    const connection = runtime.connection(); if (!connection) return;
    setDiscovering(true); setIssue("");
    try { const available = await connection.discoverTopics(); if (runtime.connection() === connection) setTopics(available.map(item => item.name)); }
    catch (error) { if (runtime.connection() === connection) setIssue(error instanceof Error ? error.message : "discovery-response"); }
    finally { if (runtime.connection() === connection) setDiscovering(false); }
  };
  const send = () => {
    if (sendCoolingDown) return;
    setIssue("");
    try {
      const connection = runtime.connection(); if (!connection) throw new Error("not-connected");
      connection.sendPose({ enabled: controlEnabled, topic: commandTopic, durationSeconds: Number(duration), values: props.readPose() });
      setSendCoolingDown(true); sendTimer.current = setTimeout(() => { setSendCoolingDown(false); }, 500);
    }
    catch (error) { setIssue(error instanceof Error ? error.message : "control-pose"); }
  };
  return <section className="robot-connection-panel" aria-label={tr(locale, "ROS 连接", "ROS connection")}>
    <header><strong><Cable size={14} />{tr(locale, "ROS 连接", "ROS connection")}</strong><span className={`robot-connection-status is-${state.status}`} role="status"><StatusIcon size={12} />{tr(locale, statusLabel[0], statusLabel[1])}</span></header>
    <label><span>{tr(locale, "地址", "Endpoint")}</span><input value={url} disabled={busy || props.disabled} onChange={event => setUrl(event.target.value)} aria-label={tr(locale, "rosbridge 地址", "rosbridge endpoint")} spellCheck={false} /></label>
    <div className="robot-connection-fields">
      <label><span>{tr(locale, "版本", "Version")}</span><select value={version} disabled={busy || props.disabled} onChange={event => { setVersion(event.target.value as RosVersion); setTopics([]); }} aria-label={tr(locale, "ROS 版本", "ROS version")}><option value="ros2">ROS 2</option><option value="ros1">ROS 1</option></select></label>
      <label><span>{tr(locale, "状态主题", "State topic")}</span><input value={topic} disabled={busy || props.disabled} onChange={event => setTopic(event.target.value)} aria-label={tr(locale, "关节状态主题", "Joint state topic")} title={ROS_JOINT_TYPES[version]} spellCheck={false} /></label>
    </div>
    <div className="robot-connection-actions">
      <button type="button" disabled={props.disabled || !props.jointNames.length} onClick={() => { setIssue(""); setDiscovering(false); if (busy) runtime.disconnect(); else runtime.connect({ url, topic, version }); }}>{tr(locale, busy ? "断开" : "连接", busy ? "Disconnect" : "Connect")}</button>
      <button type="button" disabled={!connected || discovering} title={tr(locale, "读取 rosapi 中的 JointState 主题；可手动输入", "Read rosapi JointState topics; manual input is supported")} onClick={() => void discover()}>{tr(locale, discovering ? "读取中…" : "发现主题", discovering ? "Reading…" : "Discover topics")}</button>
    </div>
    <label className="robot-connection-arm"><input type="checkbox" checked={following} disabled={props.disabled} onChange={event => setFollowing(event.target.checked)} />{tr(locale, "跟随遥测", "Follow telemetry")}</label>
    {topics.length > 0 && <label><span>{tr(locale, "切换状态主题", "Switch state topic")}</span><select aria-label={tr(locale, "切换状态主题", "Switch state topic")} value={topics.includes(topic) ? topic : ""} disabled={!connected || props.disabled} onChange={event => {
      const next = event.target.value; if (!next || next === topic) return;
      setTopic(next); setIssue(""); setControlEnabled(false); setDiscovering(false); runtime.connect({ url, topic: next, version });
    }}><option value="" disabled>{tr(locale, "选择主题", "Select a topic")}</option>{topics.map(name => <option key={name} value={name}>{name}</option>)}</select></label>}
    {state.matched !== undefined && <p>{tr(locale, `匹配 ${state.matched}/${props.jointNames.length} 个关节`, `${state.matched}/${props.jointNames.length} joints matched`)}{state.unknown ? tr(locale, ` · 忽略 ${state.unknown} 个未知名`, ` · ${state.unknown} unknown names ignored`) : ""}{state.unstamped && tr(locale, " · 无源时间戳", " · No source timestamp")}</p>}
    {(issue || state.issue) && <p className="robot-connection-error" role="alert">{rosbridgeIssueMessage(locale, issue || state.issue!)}</p>}
    <details onKeyDown={event => { if (event.key === "Escape" && event.currentTarget.open) { event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
      <summary>{tr(locale, "控制", "Control")}</summary>
      <label className="robot-connection-arm"><input type="checkbox" checked={controlEnabled} disabled={!connected || props.disabled} onChange={event => setControlEnabled(event.target.checked)} />{tr(locale, "启用本次姿态发送", "Enable pose sending this session")}</label>
      <label><span>{tr(locale, "控制主题", "Command topic")}</span><input value={commandTopic} disabled={!controlEnabled} onChange={event => setCommandTopic(event.target.value)} aria-label={tr(locale, "姿态控制主题", "Pose command topic")} placeholder="/controller/joint_trajectory" spellCheck={false} /></label>
      <div className="robot-connection-fields"><label><span>{tr(locale, "目标时长 s", "Duration s")}</span><input type="number" min="0.1" max="60" step="0.1" value={duration} disabled={!controlEnabled} onChange={event => setDuration(event.target.value)} aria-label={tr(locale, "姿态目标时长", "Pose target duration")} /></label><button type="button" title={sendCoolingDown ? tr(locale, "已发送，500 毫秒后可再次发送；设备执行未确认。", "Sent; another send is available after 500 ms. Device execution is unconfirmed.") : tr(locale, "仅发送作者目标的 JointTrajectory；不代表设备接受或完成，不自动重放。", "Send the authored target as JointTrajectory only; no device acceptance or completion confirmation, and no replay.")} disabled={sendCoolingDown || !controlEnabled || state.status !== "live" || state.matched !== props.jointNames.length || !commandTopic} onClick={send}>{tr(locale, "发送目标姿态", "Send target pose")}</button></div>
      {state.command === "sent-unconfirmed" && <p role="status">{tr(locale, "已发送，未确认", "Sent, unconfirmed")}</p>}
      {state.command === "rejected" && (issue || state.issue) !== "control-rejected" && <p className="robot-connection-error" role="alert">{rosbridgeIssueMessage(locale, "control-rejected")}</p>}
    </details>
  </section>;
}
