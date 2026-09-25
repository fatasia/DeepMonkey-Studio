export interface SceneDataSocket {
  close(): void;
}

export interface SceneDataSocketHandlers {
  onOpen(): void;
  onMessage(data: unknown): void;
  onError(): void;
  onClose(): void;
}

export function sceneDataWebSocketUrl(serverBaseUrl: string, projectId: string): string {
  const url = new URL(`/api/projects/${encodeURIComponent(projectId)}/data/ws`, serverBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function connectSceneDataSocket(
  projectId: string,
  accessToken: string | undefined,
  handlers: SceneDataSocketHandlers,
  serverBaseUrl: string,
): SceneDataSocket {
  const url = sceneDataWebSocketUrl(serverBaseUrl, projectId);
  const socket = accessToken ? new WebSocket(url, `bim-studio-auth.${accessToken}`) : new WebSocket(url);
  socket.addEventListener("open", handlers.onOpen);
  socket.addEventListener("message", (event) => handlers.onMessage(event.data));
  socket.addEventListener("error", handlers.onError);
  socket.addEventListener("close", handlers.onClose);
  return socket;
}
