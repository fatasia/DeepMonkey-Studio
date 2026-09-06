import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RosbridgeConnection, type RosConnectionDependencies, type RosSocket } from "./RosbridgeConnection";
class FakeSocket implements RosSocket {
  readyState = 0; bufferedAmount = 0; sent: Array<Record<string, unknown>> = [];
  onopen: RosSocket["onopen"] = null; onmessage: RosSocket["onmessage"] = null; onerror: RosSocket["onerror"] = null; onclose: RosSocket["onclose"] = null;
  close = vi.fn(() => { this.readyState = 3; });
  send(value: string) { this.sent.push(JSON.parse(value)); }
  open() { this.readyState = 1; this.onopen?.(new Event("open")); }
  message(value: unknown) { this.onmessage?.({ data: typeof value === "string" ? value : JSON.stringify(value) } as MessageEvent); }
}
const envelope = (stamp: number, position = 1) => ({ op: "publish", topic: "/joint_states", msg: { name: ["axis"], position: [position], header: { stamp: { sec: stamp, nanosec: 0 } } } });
function setup() {
  const sockets: FakeSocket[] = [], frames = new Map<number, () => void>(); let nextFrame = 0;
  const deps: RosConnectionDependencies = {
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, securePage: false, now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number, clearTimer: id => clearTimeout(id),
    requestFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; }, cancelFrame: id => { frames.delete(id); },
  };
  const onTelemetry = vi.fn(), onState = vi.fn();
  const connection = new RosbridgeConnection({ url: "ws://localhost:9090", topic: "/joint_states", version: "ros2", jointNames: ["axis"] }, { onTelemetry, onState }, deps);
  const flush = () => { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(); };
  return { connection, sockets, frames, flush, onTelemetry, onState };
}
beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
describe("single explicit rosbridge session", () => {
  it("does not connect automatically and subscribes without any command publication", () => {
    const { connection, sockets } = setup(); expect(sockets).toHaveLength(0);
    connection.connect(); sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([{ op: "subscribe", id: "joint-state", topic: "/joint_states", type: "sensor_msgs/msg/JointState", throttle_rate: 16, queue_length: 1, compression: "none" }]);
    expect(connection.snapshot.status).toBe("waiting"); connection.disconnect();
  });
  it("bounds high-rate traffic to one newest frame and does not update React-facing state each frame", () => {
    const { connection, sockets, frames, flush, onTelemetry, onState } = setup(); connection.connect(); sockets[0]!.open();
    for (let index = 1; index <= 1000; index++) sockets[0]!.message(envelope(index, index));
    expect(frames.size).toBe(1); expect(onTelemetry).not.toHaveBeenCalled(); flush();
    expect(onTelemetry).toHaveBeenCalledExactlyOnceWith({ axis: 1000 });
    const states = onState.mock.calls.length;
    for (let index = 1001; index <= 1020; index++) { sockets[0]!.message(envelope(index)); flush(); }
    expect(onState.mock.calls.length).toBe(states); connection.disconnect();
  });
  it("rejects old/invalid frames and expires a buffer withheld by a paused RAF", () => {
    const { connection, sockets, flush, onTelemetry } = setup(); connection.connect(); sockets[0]!.open();
    sockets[0]!.message(envelope(2, 2)); sockets[0]!.message(envelope(1, 1)); flush();
    expect(onTelemetry).toHaveBeenCalledExactlyOnceWith({ axis: 2 });
    sockets[0]!.message(envelope(3)); vi.advanceTimersByTime(2000); flush();
    expect(onTelemetry).toHaveBeenCalledTimes(1); expect(connection.snapshot.status).toBe("stale");
    sockets[0]!.message({ ...envelope(4), msg: { name: ["axis"], position: ["NaN"] } }); flush();
    expect(onTelemetry).toHaveBeenCalledTimes(1); connection.disconnect();
  });
  it("terminates on timeout/error, ignores captured late callbacks and resets clock only on new sessions", () => {
    const { connection, sockets, flush, onTelemetry } = setup(); connection.connect();
    vi.advanceTimersByTime(5000); expect(sockets[0]!.close).toHaveBeenCalledOnce(); expect(sockets).toHaveLength(1);
    connection.connect(); const socket = sockets[1]!; socket.open(); socket.message(envelope(99)); flush();
    const stale = socket.onmessage!; socket.message(envelope(100)); connection.disconnect();
    stale({ data: JSON.stringify(envelope(101)) } as MessageEvent); flush(); expect(onTelemetry).toHaveBeenCalledTimes(1);
    connection.connect(); sockets[2]!.open(); sockets[2]!.message(envelope(1)); flush();
    expect(onTelemetry).toHaveBeenCalledTimes(2); sockets[2]!.onerror?.(new Event("error"));
    expect(connection.snapshot).toMatchObject({ status: "error", issue: "socket" }); expect(sockets).toHaveLength(3);
  });
  it("only emits a pose after explicit enablement, fresh full telemetry and valid input; no fake ACK", () => {
    const { connection, sockets, flush } = setup(); connection.connect(); const socket = sockets[0]!; socket.open();
    const request = { enabled: true, topic: "/robot/trajectory", durationSeconds: 2, values: { axis: 0.2 } };
    expect(() => connection.sendPose(request)).toThrow("control-not-live");
    socket.message(envelope(1)); flush(); expect(() => connection.sendPose({ ...request, enabled: false })).toThrow("control-disabled");
    expect(socket.sent.some(item => item.op === "publish")).toBe(false);
    connection.sendPose(request); expect(socket.sent.filter(item => item.op === "publish")).toHaveLength(1);
    expect(connection.snapshot.command).toBe("sent-unconfirmed");
    const id = socket.sent.find(item => item.op === "publish")!.id;
    socket.message({ op: "status", level: "error", id }); expect(connection.snapshot.command).toBe("rejected");
    vi.advanceTimersByTime(2000); expect(() => connection.sendPose(request)).toThrow("control-not-live"); connection.disconnect();
    expect(socket.sent.filter(item => item.op === "publish")).toHaveLength(1);
  });
  it("correlates optional topic discovery and cancels it on disconnect", async () => {
    const { connection, sockets } = setup(); connection.connect(); const socket = sockets[0]!; socket.open();
    const discovery = connection.discoverTopics(), id = socket.sent.find(item => item.op === "call_service")!.id;
    socket.message({ op: "service_response", service: "/rosapi/topics", id, result: true, values: { topics: ["/joint_states", "/other"], types: ["sensor_msgs/msg/JointState", "std_msgs/msg/String"] } });
    await expect(discovery).resolves.toEqual([{ name: "/joint_states", type: "sensor_msgs/msg/JointState" }]);
    const canceled = connection.discoverTopics(); const check = expect(canceled).rejects.toThrow("disconnected"); connection.disconnect(); await check;
  });
  it("reports normal server closure as disconnected and cancels a buffered frame", () => {
    const { connection, sockets, flush, onTelemetry } = setup(); connection.connect(); const socket = sockets[0]!; socket.open();
    socket.message(envelope(1)); socket.onclose?.({ code: 1000 } as CloseEvent); flush();
    expect(connection.snapshot.status).toBe("disconnected"); expect(onTelemetry).not.toHaveBeenCalled(); expect(socket.close).toHaveBeenCalledOnce();
  });
  it("does not attribute uncorrelated server errors to a nonexistent command and bounds UTF-8 bytes", () => {
    const { connection, sockets } = setup(); connection.connect(); const socket = sockets[0]!; socket.open();
    socket.message({ op: "status", level: "error" }); expect(connection.snapshot.command).toBeUndefined();
    socket.message(JSON.stringify({ text: "界".repeat(90000) })); expect(connection.snapshot.issue).toBe("payload"); connection.disconnect();
  });
  it("contains renderer failures and stops the session without uncaught RAF errors", () => {
    const { connection, sockets, flush, onTelemetry } = setup(); onTelemetry.mockImplementation(() => { throw new Error("invalid renderer joint"); });
    connection.connect(); sockets[0]!.open(); sockets[0]!.message(envelope(1));
    expect(flush).not.toThrow(); expect(connection.snapshot).toEqual({ status: "error", issue: "telemetry-apply" });
    expect(sockets[0]!.close).toHaveBeenCalledOnce();
  });
});
