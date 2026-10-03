import type { AiContextDelivery } from "@bim-studio/contracts";

// IDs match the existing project/workspace source list; paths refer to request snapshots.
const SOURCE_PATHS: Record<string, string[]> = {
  "workspace-scene": ["scene"], "workspace-selection": ["selected"],
  "workspace-dashboard": ["dashboard"], "workspace-script": ["script"],
  "workspace-simulation": ["simulation"], operations: ["platform", "operations"],
  "vision-models": ["platform", "vision", "models"], "vision-sources": ["platform", "vision", "sources"],
  "vision-tasks": ["platform", "vision", "tasks"], "vision-events": ["platform", "vision", "events"],
  connections: ["platform", "data", "connections"], datasets: ["platform", "data", "datasets"],
  "ppr-bop": ["platform", "processPlanning"], battery: ["platform", "battery"],
  "bim-evidence": ["bimEvidence"], "capability-catalog": ["availableCapabilities"],
  // K4：chat 侧注入的项目记忆投递（守则/记忆/既往结论），被截断时如实标 omitted/partial。
  "agent-memory-context": ["agentMemoryContext"],
};

/** JSON offsets are computed from property serialization, never substring searches in user content. */
export function assistantContextDelivery(original: unknown, prepared: unknown, sentChars: number): AiContextDelivery {
  const serialized = JSON.stringify(prepared) ?? "null";
  const sources: AiContextDelivery["sources"] = [];
  for (const [id, path] of Object.entries(SOURCE_PATHS)) {
    const range = locate(prepared, path);
    const before = locate(original, path);
    if (!range) {
      if (before) sources.push({ id, path: path.join("."), status: "omitted", preparedChars: 0, sentChars: 0, transformed: true });
      continue;
    }
    const length = range.text.length;
    const sent = Math.max(0, Math.min(length, sentChars - range.start));
    const transformed = Boolean(before && before.text !== range.text);
    sources.push({ id, path: path.join("."), status: sent === 0 ? "omitted" : sent < length || transformed ? "partial" : "sent",
      preparedChars: length, sentChars: sent, transformed });
  }
  return { unit: "utf16", preparedChars: serialized.length, sentChars: Math.min(serialized.length, sentChars), sources };
}

/** T5：逐条引用锚的证据定位输入——与 contextDelivery 同一坐标系的来源段（start 为 prepared 串内 UTF-16 偏移）。 */
export interface AssistantContextSourceSegment {
  id: string;
  path: string;
  start: number;
  text: string;
}

/**
 * 与 assistantContextDelivery 同源（同一 locate/SOURCE_PATHS、同一次序列化口径）提取来源段；
 * 只对「准备后真正用于发送的 prepared」调用。零新机制：锚定坐标系与 contextDelivery 逐字节一致。
 */
export function assistantContextSourceSegments(prepared: unknown): AssistantContextSourceSegment[] {
  const segments: AssistantContextSourceSegment[] = [];
  for (const [id, path] of Object.entries(SOURCE_PATHS)) {
    const range = locate(prepared, path);
    if (range) segments.push({ id, path: path.join("."), start: range.start, text: range.text });
  }
  return segments;
}

function locate(value: unknown, path: string[], start = 0): { start: number; text: string } | undefined {
  if (!path.length) {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : { start, text };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  let offset = start + 1;
  for (const [key, item] of Object.entries(value)) {
    const text = JSON.stringify(item);
    if (text === undefined) continue;
    const prefix = JSON.stringify(key).length + 1;
    if (key === path[0]) return locate(item, path.slice(1), offset + prefix);
    offset += prefix + text.length + 1;
  }
  return undefined;
}
