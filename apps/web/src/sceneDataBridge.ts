import type { SceneDataMessage } from "./viewer/ViewerEngine";
import { parseDashboardMessages } from "./components/dashboardMessages";
import { connectSceneDataSocket, type SceneDataSocket } from "./adapters/sceneDataSocket";

export type SceneDataBridgeStatus = "connecting" | "online" | "offline";
type MessageListener = (message: SceneDataMessage) => void;
type StatusListener = (status: SceneDataBridgeStatus) => void;

const messageListeners = new Set<MessageListener>();
const statusListeners = new Set<StatusListener>();
let socket: SceneDataSocket | undefined;
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

export function publishLocalSceneData(message: SceneDataMessage): void {
  for (const listener of messageListeners) listener(message);
}

function start() {
  stopped = false;
  connect();
}

function connect() {
  if (stopped || socket) return;
  updateStatus("connecting");
  const next = connectSceneDataSocket({
    onOpen: () => {
      if (socket !== next) return;
      retry = 0;
      updateStatus("online");
    },
    onMessage: (data) => {
      for (const message of parseDashboardMessages(data)) {
        for (const listener of messageListeners) listener(message);
      }
    },
    onError: () => {
      updateStatus("offline");
      next.close();
    },
    onClose: () => {
      if (socket !== next) return;
      socket = undefined;
      updateStatus("offline");
      if (!stopped && messageListeners.size > 0) reconnectTimer = window.setTimeout(connect, Math.min(10_000, 800 * 2 ** retry++));
    }
  });
  socket = next;
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
