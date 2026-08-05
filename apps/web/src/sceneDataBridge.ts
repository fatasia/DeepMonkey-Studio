import type { SceneDataMessage } from "./viewer/ViewerEngine";
import { parseDashboardMessages } from "./components/dashboardMessages";

export type SceneDataBridgeStatus = "connecting" | "online" | "offline";
type MessageListener = (message: SceneDataMessage) => void;
type StatusListener = (status: SceneDataBridgeStatus) => void;

const messageListeners = new Set<MessageListener>();
const statusListeners = new Set<StatusListener>();
let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let retry = 0;
let status: SceneDataBridgeStatus = "offline";
let stopped = true;

export function subscribeSceneData(listener: MessageListener, onStatus?: StatusListener): () => void {
  messageListeners.add(listener);
  if (onStatus) {
    statusListeners.add(onStatus);
    onStatus(status);
  }
  if (messageListeners.size === 1) start();
  return () => {
    messageListeners.delete(listener);
    if (onStatus) statusListeners.delete(onStatus);
    if (messageListeners.size === 0) stop();
  };
}

function start() {
  stopped = false;
  connect();
}

function connect() {
  if (stopped || socket) return;
  updateStatus("connecting");
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const next = new WebSocket(`${protocol}//${window.location.host}/iot/ws/scene`);
  socket = next;
  next.addEventListener("open", () => {
    if (socket !== next) return;
    retry = 0;
    updateStatus("online");
  });
  next.addEventListener("message", (event) => {
    for (const message of parseDashboardMessages(event.data)) {
      for (const listener of messageListeners) listener(message);
    }
  });
  next.addEventListener("error", () => {
    updateStatus("offline");
    next.close();
  });
  next.addEventListener("close", () => {
    if (socket !== next) return;
    socket = undefined;
    updateStatus("offline");
    if (!stopped && messageListeners.size > 0) reconnectTimer = window.setTimeout(connect, Math.min(10_000, 800 * 2 ** retry++));
  });
}

function stop() {
  stopped = true;
  retry = 0;
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  const current = socket;
  socket = undefined;
  current?.close();
  updateStatus("offline");
}

function updateStatus(next: SceneDataBridgeStatus) {
  if (status === next) return;
  status = next;
  for (const listener of statusListeners) listener(status);
}
