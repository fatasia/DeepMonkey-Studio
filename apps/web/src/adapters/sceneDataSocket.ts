export interface SceneDataSocket {
  close(): void;
}

export interface SceneDataSocketHandlers {
  onOpen(): void;
  onMessage(data: unknown): void;
  onError(): void;
  onClose(): void;
}

export function connectSceneDataSocket(projectId: string, accessToken: string | undefined, handlers: SceneDataSocketHandlers): SceneDataSocket {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/api/projects/${encodeURIComponent(projectId)}/data/ws`;
  const socket = accessToken ? new WebSocket(url, `bim-studio-auth.${accessToken}`) : new WebSocket(url);
  socket.addEventListener("open", handlers.onOpen);
  socket.addEventListener("message", (event) => handlers.onMessage(event.data));
  socket.addEventListener("error", handlers.onError);
  socket.addEventListener("close", handlers.onClose);
  return socket;
}
