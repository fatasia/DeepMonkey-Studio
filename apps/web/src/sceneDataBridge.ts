import type { DataMessage } from "@bim-studio/contracts";
import { parseDashboardMessages } from "./components/dashboardMessages";
import { connectSceneDataSocket, type SceneDataSocket } from "./adapters/sceneDataSocket";
import { getAuthToken } from "./api";

export type SceneDataBridgeStatus = "connecting" | "online" | "offline";
type MessageListener = (message: DataMessage) => void;
type StatusListener = (status: SceneDataBridgeStatus) => void;

interface ProjectChannel {
  messageListeners: Set<MessageListener>;
  statusListeners: Set<StatusListener>;
  socket?: SceneDataSocket;
  reconnectTimer?: number;
  retry: number;
  status: SceneDataBridgeStatus;
  stopped: boolean;
}

const channels = new Map<string, ProjectChannel>();

export function subscribeSceneData(projectId: string, listener: MessageListener, onStatus?: StatusListener): () => void {
  const channel = channels.get(projectId) ?? { messageListeners: new Set(), statusListeners: new Set(), retry: 0, status: "offline", stopped: true };
  channels.set(projectId, channel);
  channel.messageListeners.add(listener);
  if (onStatus) {
    channel.statusListeners.add(onStatus);
    onStatus(channel.status);
  }
  if (channel.messageListeners.size === 1) start(projectId, channel);
  return () => {
    channel.messageListeners.delete(listener);
    if (onStatus) channel.statusListeners.delete(onStatus);
    if (channel.messageListeners.size === 0) {
      stop(channel);
      channels.delete(projectId);
    }
  };
}

export function publishLocalSceneData(message: DataMessage): void {
  const delivered = new Set<MessageListener>();
  for (const channel of channels.values()) for (const listener of channel.messageListeners) {
    if (!delivered.has(listener)) listener(message);
    delivered.add(listener);
  }
}

function start(projectId: string, channel: ProjectChannel) {
  channel.stopped = false;
  connect(projectId, channel);
}

function connect(projectId: string, channel: ProjectChannel) {
  if (channel.stopped || channel.socket) return;
  updateStatus(channel, "connecting");
  const next = connectSceneDataSocket(projectId, getAuthToken(), {
    onOpen: () => {
      if (channel.socket !== next) return;
      channel.retry = 0;
      updateStatus(channel, "online");
    },
    onMessage: (data) => {
      for (const message of parseDashboardMessages(data)) {
        for (const listener of channel.messageListeners) listener(message);
      }
    },
    onError: () => {
      updateStatus(channel, "offline");
      next.close();
    },
    onClose: () => {
      if (channel.socket !== next) return;
      delete channel.socket;
      updateStatus(channel, "offline");
      if (!channel.stopped && channel.messageListeners.size > 0) channel.reconnectTimer = window.setTimeout(() => connect(projectId, channel), Math.min(10_000, 800 * 2 ** channel.retry++));
    }
  });
  channel.socket = next;
}

function stop(channel: ProjectChannel) {
  channel.stopped = true;
  channel.retry = 0;
  if (channel.reconnectTimer !== undefined) window.clearTimeout(channel.reconnectTimer);
  delete channel.reconnectTimer;
  const current = channel.socket;
  delete channel.socket;
  current?.close();
  updateStatus(channel, "offline");
}

function updateStatus(channel: ProjectChannel, next: SceneDataBridgeStatus) {
  if (channel.status === next) return;
  channel.status = next;
  for (const listener of channel.statusListeners) listener(channel.status);
}
