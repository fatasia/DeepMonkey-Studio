import type { SceneDataMessage } from "../viewer/ViewerEngine";

export function parseDashboardMessages(raw: unknown): Array<SceneDataMessage & { sceneId?: string }> {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const wrapped = value as { payload?: unknown };
      const candidate = wrapped.payload && typeof wrapped.payload === "object" ? wrapped.payload : value;
      const message = candidate as Partial<SceneDataMessage>;
      if (!message.key || !("value" in message)) return [];
      return [{
        source: message.source ?? "node-red",
        key: message.key,
        value: message.value,
        timestamp: message.timestamp ?? new Date().toISOString(),
        ...(message.sceneId ? { sceneId: message.sceneId } : {}),
        ...(message.target ? { target: message.target } : {}),
        ...(message.action ? { action: message.action } : {})
      }];
    });
  } catch {
    return [];
  }
}
