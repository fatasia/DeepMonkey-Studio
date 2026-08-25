import type { DataMessage } from "@bim-studio/contracts";

export function parseDashboardMessages(raw: unknown): DataMessage[] {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const wrapped = value as { payload?: unknown };
      const candidate = wrapped.payload && typeof wrapped.payload === "object" ? wrapped.payload : value;
      const message = candidate as Partial<DataMessage>;
      if (!message.key || !("value" in message)) return [];
      return [{
        source: message.source ?? "data-hub",
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
