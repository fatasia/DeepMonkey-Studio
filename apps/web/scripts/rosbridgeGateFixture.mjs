import { createRequire } from "node:module";
import { URDF_GATE_POSE } from "./urdfGateFixture.mjs";
const { WebSocketServer } = createRequire(new URL("../../api/package.json", import.meta.url))("ws");

/** 只监听本机的真实WebSocket；模拟协议对端，不启动ROS或连接设备。 */
export async function createRosbridgeGateFixture() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(resolve => server.once("listening", resolve));
  const sessions = [], messages = [];
  server.on("connection", socket => {
    const session = { socket, closed: false, topic: "", type: "", messages: [] }; sessions.push(session);
    socket.on("close", () => { session.closed = true; });
    socket.on("message", bytes => {
      const message = JSON.parse(bytes.toString()); messages.push(message); session.messages.push(message);
      if (message.op === "subscribe") { session.topic = message.topic; session.type = message.type; }
      if (message.op === "call_service") socket.send(JSON.stringify({ op: "service_response", id: message.id, service: "/rosapi/topics", result: true,
        values: { topics: ["/joint_states", "/robot/joint_states", "/unrelated"], types: [session.type, session.type, "std_msgs/msg/String"] } }));
    });
  });
  const send = (session, msg) => session.socket.send(JSON.stringify(msg));
  const frame = (session, sec, pose = URDF_GATE_POSE, extra = {}) => {
    const names = Object.keys(pose).reverse();
    send(session, { op: "publish", topic: session.topic, msg: { name: names, position: names.map(name => pose[name]), velocity: [], effort: [],
      header: { stamp: session.type.includes("/msg/") ? { sec, nanosec: 0 } : { secs: sec, nsecs: 0 } }, ...extra } });
  };
  return { url: `ws://127.0.0.1:${server.address().port}`, sessions, messages, send, frame,
    close: async () => { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); } };
}
