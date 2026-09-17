import { array, fields, integer, record, requireValue, resourceId, revision, snapshotJson } from "./primitives.js";
import { runtimeContentSha256 } from "./hash.js";
import type { XRequest, XResourceIndex, XResourcePayload } from "./experimentalXTypes.js";
import { validateDeep2dDisplayList } from "../deep2dDisplayList.js";

const MAX_MEMORY = 8 * 1024 * 1024, MAX_IPC = 4 * 1024 * 1024;
const safe = (value: unknown, path: string): number => integer(value, 0, Number.MAX_SAFE_INTEGER, path);
const finite = (value: unknown, path: string): void => requireValue(typeof value === "number" && Number.isFinite(value), path, "Expected finite number.");
function injectedResourceId(value: unknown): string {
  requireValue(typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value), "$.resource.id", "Invalid injected resource identity.");
  return value;
}

/** 编译期只检查封闭IR的形状、引用和预算；不执行时钟、随机或消息调用。 */
export function freezeExperimentalXResource(id: string, resourceRevision: number, input: XRequest): { index: XResourceIndex; payload: XResourcePayload } {
  resourceId(id, "$.experimentalX.id"); revision(resourceRevision, "$.experimentalX.revision");
  const request = record(snapshotJson(input), "$.request");
  fields(request, ["schemaVersion", "expectedEpoch", "startedAtMs", "randomSeed", "resources", "events", "calls"], [], "$.request");
  requireValue(request.schemaVersion === 1, "$.request.schemaVersion", "Unsupported X schema.");
  for (const key of ["expectedEpoch", "startedAtMs", "randomSeed"]) safe(request[key], `$.request.${key}`);
  const resources = new Map<string, number>();
  let resident = 0, messageBytes = 0, messages = 0, cpu = 0, displayLists = 0;
  for (const item of array(request.resources, "$.request.resources")) {
    const value = record(item, "$.resource"); fields(value, ["id", "bytes"], [], "$.resource");
    const key = injectedResourceId(value.id);
    requireValue(!resources.has(key), "$.resource.id", "Duplicate resource.");
    const bytes = array(value.bytes, "$.resource.bytes", MAX_MEMORY);
    for (const byte of bytes) integer(byte, 0, 255, "$.resource.bytes[]");
    resident += key.length + bytes.length; resources.set(key, bytes.length);
  }
  const eventSizes = array(request.events, "$.request.events").map(item => {
    const event = record(item, "$.event"); fields(event, ["type", "data"], [], "$.event");
    const data = record(event.data, "$.event.data");
    if (event.type === "pointer") {
      fields(data, ["x", "y"], [], "$.event.data"); finite(data.x, "$.event.x"); finite(data.y, "$.event.y"); return 17;
    }
    requireValue(event.type === "key", "$.event.type", "Unknown event.");
    fields(data, ["code"], [], "$.event.data");
    requireValue(["enter", "escape", "arrow-left", "arrow-right"].includes(String(data.code)), "$.event.code", "Unsupported key."); return 2;
  });
  resident += eventSizes.length * 24;
  const checkBudget = (): void => requireValue(cpu <= 65536 && messages <= 1024 && messageBytes <= 1024 * 1024
    && resident + messageBytes <= MAX_MEMORY, "$.request", "X compilation budget exceeded.");
  checkBudget();
  const pending = array(request.calls, "$.request.calls").map(call => ({ call, depth: 1 }));
  while (pending.length) {
    const { call, depth } = pending.pop()!;
    requireValue(depth <= 16, "$.call", "X call depth exceeded.");
    const value = record(call, "$.call"), op = value.op;
    fields(value, op === "read-clock" || op === "draw-random" ? ["op"] : ["op", "args"], [], "$.call");
    cpu++; resident += 32;
    let size = 8;
    if (op === "sequence") {
      for (const child of array(value.args, "$.call.args", 65536)) pending.push({ call: child, depth: depth + 1 });
      checkBudget(); continue;
    } else if (op === "read-resource-byte") {
      const args = record(value.args, "$.call.args"); fields(args, ["resource_id", "offset"], [], "$.call.args");
      const key = injectedResourceId(args.resource_id), offset = safe(args.offset, "$.call.offset");
      requireValue(resources.has(key) && offset < resources.get(key)!, "$.call", "Missing resource or invalid byte offset.");
      resident += key.length; size = 17 + key.length;
    } else if (op === "read-event") {
      const args = record(value.args, "$.call.args"); fields(args, ["index"], [], "$.call.args");
      const index = safe(args.index, "$.call.index"); requireValue(index < eventSizes.length, "$.call", "Invalid event index."); size = eventSizes[index]!;
    } else if (op === "emit-number") finite(value.args, "$.call.args");
    else if (op === "emit-display-list") {
      displayLists++;
      requireValue(displayLists <= 1, "$.call.args", "X output may contain only one Deep2D display list.");
      const validation = validateDeep2dDisplayList(value.args);
      requireValue(validation.valid, "$.call.args", validation.issues[0]?.message ?? "Invalid Deep2D display list.");
      size = new TextEncoder().encode(JSON.stringify(value.args)).length;
      resident += size;
    }
    else requireValue(op === "read-clock" || op === "draw-random", "$.call.op", "Unknown X operation.");
    messages++; messageBytes += size; checkBudget();
  }
  requireValue(new TextEncoder().encode(JSON.stringify(request)).length <= MAX_IPC, "$.request", "X IPC budget exceeded.");
  const payload: XResourcePayload = { schema: "deep-engine.experimental-x-resource", schemaVersion: 1, id, revision: resourceRevision,
    content: { schemaVersion: 1, lane: "experimental-x", request: request as unknown as XRequest,
      contentHash: { algorithm: "sha256", value: runtimeContentSha256(request) } } };
  return { payload, index: { id, revision: resourceRevision, kind: "experimental-x",
    contentHash: { algorithm: "sha256", value: runtimeContentSha256(payload) } } };
}
