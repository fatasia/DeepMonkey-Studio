import { isRecord, parseRosJointState, ROS_JOINT_TYPES, validateRosbridgeUrl, validJointNames, validRosTopic, type JointValues, type RosJointFrame, type RosVersion } from "./rosbridgeJointState";
import { createRosTrajectory, type RosTrajectoryRequest } from "./rosbridgeTrajectory";
import { createRosbridgeSocket } from "../adapters/rosbridgeSocket";

export type RosConnectionStatus = "idle" | "connecting" | "waiting" | "live" | "stale" | "disconnected" | "error";
export interface RosConnectionState { status: RosConnectionStatus; issue?: string; matched?: number; unknown?: number; unstamped?: boolean; command?: "sent-unconfirmed" | "rejected" }
export interface RosSocket {
  readonly readyState: number; readonly bufferedAmount: number;
  onopen: ((event: Event) => unknown) | null; onmessage: ((event: MessageEvent) => unknown) | null; onerror: ((event: Event) => unknown) | null; onclose: ((event: CloseEvent) => unknown) | null;
  send(data: string): void; close(): void;
}
export interface RosConnectionDependencies {
  createSocket(url: string): RosSocket; now(): number;
  setTimer(fn: () => void, ms: number): number; clearTimer(id: number): void;
  requestFrame(fn: () => void): number; cancelFrame(id: number): void;
  securePage: boolean;
}
export interface RosConnectionOptions { url: string; topic: string; version: RosVersion; jointNames: readonly string[]; timeoutMs?: number; staleMs?: number }
export interface RosTopic { name: string; type: string }
const browserDependencies = (): RosConnectionDependencies => ({
  createSocket: createRosbridgeSocket, now: () => performance.now(), securePage: location.protocol === "https:",
  setTimer: (fn, ms) => window.setTimeout(fn, ms), clearTimer: id => clearTimeout(id),
  requestFrame: fn => requestAnimationFrame(fn), cancelFrame: id => cancelAnimationFrame(id),
});

/** 单次显式连接：一个最新帧槽、一个RAF；无自动重连、重放或作者场景持久化。 */
export class RosbridgeConnection {
  private socket: RosSocket | undefined;
  private state: RosConnectionState = { status: "idle" };
  private timer: number | undefined;
  private frameId: number | undefined;
  private latest: { frame: RosJointFrame; receivedAt: number } | undefined;
  private lastStamp: bigint | undefined;
  private lastReceived = -Infinity;
  private lastCommandAt = -Infinity;
  private sequence = 0;
  private commandId: string | undefined;
  private advertisements = new Map<string, string>();
  private discovery: { id: string; timer: number; resolve: (topics: RosTopic[]) => void; reject: (error: Error) => void } | undefined;
  private readonly jointNames: ReadonlySet<string>;
  constructor(private readonly options: RosConnectionOptions, private readonly handlers: { onTelemetry(values: JointValues): void; onState(state: RosConnectionState): void }, private readonly deps: RosConnectionDependencies = browserDependencies()) {
    this.jointNames = new Set(options.jointNames);
  }
  get snapshot(): RosConnectionState { return { ...this.state }; }

  connect(): void {
    this.disconnect(false);
    const url = validateRosbridgeUrl(this.options.url, this.deps.securePage);
    if (!url) return this.emit({ status: "error", issue: "url" });
    if (!validRosTopic(this.options.topic)) return this.emit({ status: "error", issue: "topic" });
    if (!validJointNames(this.options.jointNames) || this.jointNames.size !== this.options.jointNames.length) return this.emit({ status: "error", issue: "model-joints" });
    this.lastStamp = undefined; this.lastReceived = -Infinity; this.lastCommandAt = -Infinity; this.commandId = undefined;
    this.emit({ status: "connecting" });
    let socket: RosSocket;
    try { socket = this.deps.createSocket(url); this.socket = socket; } catch { return this.fail("socket"); }
    const active = () => this.socket === socket;
    this.timer = this.deps.setTimer(() => { if (active()) this.fail("timeout"); }, this.options.timeoutMs ?? 5000);
    socket.onopen = () => {
      if (!active()) return;
      this.clearTimer();
      try { this.send({ op: "subscribe", id: "joint-state", topic: this.options.topic, type: ROS_JOINT_TYPES[this.options.version], throttle_rate: 16, queue_length: 1, compression: "none" }); }
      catch { return this.fail("socket"); }
      this.emit({ status: "waiting" }); this.scheduleStale();
    };
    socket.onmessage = event => { if (active()) this.receive(event.data); };
    socket.onerror = () => { if (active()) this.fail("socket"); };
    socket.onclose = event => { if (active()) { if (event.code === 1000) this.disconnect(); else this.fail("closed"); } };
  }

  disconnect(notify = true): void {
    this.clearTimer();
    if (this.frameId !== undefined) this.deps.cancelFrame(this.frameId);
    this.frameId = undefined; this.latest = undefined;
    if (this.discovery) { this.deps.clearTimer(this.discovery.timer); this.discovery.reject(new Error("disconnected")); this.discovery = undefined; }
    const socket = this.socket; this.socket = undefined;
    if (socket) {
      socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
      try {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ op: "unsubscribe", id: "joint-state", topic: this.options.topic }));
          for (const [topic, id] of this.advertisements) socket.send(JSON.stringify({ op: "unadvertise", id, topic }));
        }
      } catch { /* 断开不等待网络清理成功，也不重放命令。 */ }
      try { socket.close(); } catch { /* 本地归属已清除，关闭失败也不再接受旧回调。 */ }
    }
    this.advertisements.clear();
    if (notify) this.emit({ status: "disconnected" });
  }

  discoverTopics(): Promise<RosTopic[]> {
    if (!this.socket || this.socket.readyState !== 1) return Promise.reject(new Error("not-connected"));
    if (this.discovery) return Promise.reject(new Error("discovery-busy"));
    const id = `topics-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = this.deps.setTimer(() => { this.discovery = undefined; reject(new Error("discovery-timeout")); }, 5000);
      this.discovery = { id, timer, resolve, reject };
      try { this.send({ op: "call_service", id, service: "/rosapi/topics", args: {}, timeout: 5 }); }
      catch { this.deps.clearTimer(timer); this.discovery = undefined; reject(new Error("socket")); }
    });
  }

  sendPose(request: RosTrajectoryRequest): void {
    if (!request.enabled) throw new Error("control-disabled");
    if (this.state.status !== "live" || this.state.matched !== this.jointNames.size || this.deps.now() - this.lastReceived >= (this.options.staleMs ?? 2000)) throw new Error("control-not-live");
    if (!this.socket || this.socket.readyState !== 1 || this.socket.bufferedAmount > 0 || this.deps.now() - this.lastCommandAt < 500) throw new Error("control-busy");
    const id = `pose-${++this.sequence}`;
    const messages = createRosTrajectory(this.options.version, [...this.jointNames], request, id);
    try {
      for (const [topic, advertisementId] of this.advertisements) {
        if (topic === request.topic) continue;
        this.send({ op: "unadvertise", id: advertisementId, topic }); this.advertisements.delete(topic);
      }
      if (!this.advertisements.has(request.topic)) { this.send(messages.advertise); this.advertisements.set(request.topic, id); }
      this.send(messages.publish); this.commandId = id; this.lastCommandAt = this.deps.now();
      this.emit({ ...this.state, command: "sent-unconfirmed" });
    } catch { this.emit({ ...this.state, command: "rejected" }); throw new Error("socket"); }
  }

  private receive(data: unknown): void {
    if (typeof data !== "string" || data.length > 262144 || new TextEncoder().encode(data).byteLength > 262144) return this.reportIssue("payload");
    let message: unknown;
    try { message = JSON.parse(data); } catch { return this.reportIssue("json"); }
    if (!isRecord(message)) return this.reportIssue("json");
    if (message.op === "service_response") return this.receiveTopics(message);
    if (message.op === "status" && message.level === "error") {
      if (this.commandId !== undefined && message.id === this.commandId) this.emit({ ...this.state, command: "rejected", issue: "control-rejected" });
      else if (message.id === "joint-state") this.fail("subscription");
      return;
    }
    if (message.op !== "publish" || message.topic !== this.options.topic) return;
    const result = parseRosJointState(message.msg, this.jointNames, this.options.version);
    if (!result.ok) return this.reportIssue(`frame-${result.issue}`);
    const frame = result.frame;
    if (frame.stampNs !== undefined && this.lastStamp !== undefined && frame.stampNs <= this.lastStamp) return this.reportIssue("old-frame");
    if (frame.stampNs !== undefined) this.lastStamp = frame.stampNs;
    this.lastReceived = this.deps.now();
    this.latest = { frame, receivedAt: this.lastReceived }; this.scheduleStale();
    if (this.frameId === undefined) this.frameId = this.deps.requestFrame(() => this.deliver());
  }

  private deliver(): void {
    this.frameId = undefined;
    const latest = this.latest; this.latest = undefined;
    if (!this.socket || !latest || this.deps.now() - latest.receivedAt >= (this.options.staleMs ?? 2000)) return;
    const socket = this.socket;
    try { this.handlers.onTelemetry(latest.frame.values); } catch { return this.fail("telemetry-apply"); }
    if (this.socket !== socket) return;
    this.emit({ status: "live", matched: latest.frame.matched, unknown: latest.frame.unknown, unstamped: latest.frame.stampNs === undefined, ...(this.state.command ? { command: this.state.command } : {}) });
  }
  private receiveTopics(message: Record<string, unknown>): void {
    const request = this.discovery;
    if (!request || message.id !== request.id || message.service !== "/rosapi/topics") return;
    this.deps.clearTimer(request.timer); this.discovery = undefined;
    const value = message.values;
    if (message.result !== true || !isRecord(value) || !Array.isArray(value.topics) || !Array.isArray(value.types) || value.topics.length !== value.types.length || value.topics.length > 4096) return request.reject(new Error("discovery-response"));
    const types = value.types;
    request.resolve(value.topics.flatMap((topic, index) => typeof topic === "string" && validRosTopic(topic) && types[index] === ROS_JOINT_TYPES[this.options.version] ? [{ name: topic, type: String(types[index]) }] : []));
  }
  private scheduleStale(): void {
    this.clearTimer();
    this.timer = this.deps.setTimer(() => { this.latest = undefined; this.emit({ ...this.state, status: "stale", issue: "stale" }); }, this.options.staleMs ?? 2000);
  }
  private send(message: unknown): void { if (!this.socket || this.socket.readyState !== 1) throw new Error("not-connected"); this.socket.send(JSON.stringify(message)); }
  private clearTimer(): void { if (this.timer !== undefined) this.deps.clearTimer(this.timer); this.timer = undefined; }
  private reportIssue(issue: string): void { this.emit({ ...this.state, issue }); }
  private fail(issue: string): void { this.disconnect(false); this.emit({ status: "error", issue }); }
  private emit(state: RosConnectionState): void { if (JSON.stringify(state) === JSON.stringify(this.state)) return; this.state = state; this.handlers.onState({ ...state }); }
}
