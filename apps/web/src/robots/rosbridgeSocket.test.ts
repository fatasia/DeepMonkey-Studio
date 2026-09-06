import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { RosbridgeConnection, type RosConnectionDependencies } from "./RosbridgeConnection";
import { ROS_JOINT_TYPES, type RosVersion } from "./rosbridgeJointState";

// 复用API已有的ws服务端，仅监听127.0.0.1；不为浏览器增加ROS/传输依赖。
const { WebSocketServer } = createRequire(new URL("../../../api/package.json", import.meta.url))("ws");
interface TestPeer { send(value: string): void; on(event: "message", listener: (data: { toString(): string }) => void): void }
describe("real localhost rosbridge WebSocket transport", () => {
  it.each<RosVersion>(["ros1", "ros2"])("handshakes, maps telemetry, discovers topics and sends only explicit %s trajectories", async version => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>(resolve => server.once("listening", resolve));
    const messages: Array<Record<string, unknown>> = [];
    let peer: TestPeer | undefined;
    server.on("connection", (socket: TestPeer) => {
      peer = socket;
      socket.on("message", data => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>; messages.push(message);
        if (message.op === "subscribe") socket.send(JSON.stringify({ op: "publish", topic: "/joint_states", msg: { name: ["slide", "axis"], position: [0.2, 0.5], velocity: [], effort: [], header: { stamp: version === "ros2" ? { sec: 1, nanosec: 0 } : { secs: 1, nsecs: 0 } } } }));
        if (message.op === "call_service") socket.send(JSON.stringify({ op: "service_response", service: "/rosapi/topics", id: message.id, result: true, values: { topics: ["/joint_states"], types: [ROS_JOINT_TYPES[version]] } }));
      });
    });
    const telemetry = vi.fn();
    const deps: RosConnectionDependencies = {
      createSocket: url => new WebSocket(url), now: () => performance.now(), securePage: false,
      setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number, clearTimer: id => clearTimeout(id),
      requestFrame: fn => setTimeout(fn, 16) as unknown as number, cancelFrame: id => clearTimeout(id),
    };
    const connection = new RosbridgeConnection({ url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, topic: "/joint_states", version, jointNames: ["axis", "slide"] }, { onTelemetry: telemetry, onState: vi.fn() }, deps);
    try {
      expect(messages).toHaveLength(0); connection.connect();
      await vi.waitFor(() => expect(telemetry).toHaveBeenCalledExactlyOnceWith({ axis: 0.5, slide: 0.2 }));
      expect(messages.filter(message => message.op === "publish")).toHaveLength(0);
      await expect(connection.discoverTopics()).resolves.toEqual([{ name: "/joint_states", type: ROS_JOINT_TYPES[version] }]);
      const request = { enabled: false, topic: "/controller/joint_trajectory", durationSeconds: 1.5, values: { axis: 0.6, slide: 0.1 } };
      expect(() => connection.sendPose(request)).toThrow("control-disabled");
      connection.sendPose({ ...request, enabled: true });
      expect(() => connection.sendPose({ ...request, enabled: true })).toThrow("control-busy");
      await vi.waitFor(() => expect(messages.filter(message => message.op === "publish")).toHaveLength(1));
      const command = messages.find(message => message.op === "publish")!;
      expect(command).toMatchObject({ topic: "/controller/joint_trajectory", msg: { joint_names: ["axis", "slide"], points: [{ positions: [0.6, 0.1] }] } });
      expect(connection.snapshot.command).toBe("sent-unconfirmed");
      peer!.send(JSON.stringify({ op: "status", level: "error", id: command.id }));
      await vi.waitFor(() => expect(connection.snapshot.command).toBe("rejected"));
      connection.disconnect();
      await vi.waitFor(() => expect(messages.some(message => message.op === "unsubscribe")).toBe(true));
      expect(messages.filter(message => message.op === "publish")).toHaveLength(1);
    } finally { connection.disconnect(false); for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(resolve)); }
  });
});
