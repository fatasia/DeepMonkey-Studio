export interface SceneDataSocket {
  close(): void;
}

export interface SceneDataSocketHandlers {
  onOpen(): void;
  onMessage(data: unknown): void;
  onError(): void;
  onClose(): void;
}

export function connectSceneDataSocket(handlers: SceneDataSocketHandlers): SceneDataSocket {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/iot/ws/scene`);
  socket.addEventListener("open", handlers.onOpen);
  socket.addEventListener("message", (event) => handlers.onMessage(event.data));
  socket.addEventListener("error", handlers.onError);
  socket.addEventListener("close", handlers.onClose);
  return socket;
}
