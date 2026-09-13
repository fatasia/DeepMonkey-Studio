import {
  HOST_CAPABILITIES_SCHEMA_VERSION,
  HOST_CAPABILITY_NAMES,
  HOST_PROTOCOL_BUDGETS,
  HOST_PROTOCOL_SCHEMA_VERSION,
  type AuthorityMigrationAck,
  type AuthorityMigrationRequest,
  type AuthorityCancellationRequest,
  type HostCapabilitiesV1,
  type HostCapabilityName,
  type HostContractDiagnostic,
  type HostContractDiagnosticCode,
  type HostContractValidation,
  type HostEventEnvelope,
  type HostProtocolError,
  type HostRequestEnvelope,
  type SessionAuthorityConfig,
} from "./types.js";

type Obj = Record<string, unknown>;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const OP = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/;
const object = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const dense = (v: unknown): v is unknown[] => Array.isArray(v) && Reflect.ownKeys(v).every((key) => key === "length" || typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)) && Array.from({ length: v.length }, (_, i) => { const d = Object.getOwnPropertyDescriptor(v, i); return d?.enumerable === true && "value" in d; }).every(Boolean);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
function add(out: HostContractDiagnostic[], code: HostContractDiagnosticCode, path: string, message: string): void { if (out.length < HOST_PROTOCOL_BUDGETS.diagnostics) out.push({ code, path, message }); }
function keys(v: Obj, allowed: readonly string[], path: string, out: HostContractDiagnostic[]): void { const set = new Set(allowed); for (const key of Object.keys(v)) if (!set.has(key)) add(out, "unknown-field", `${path}.${key}`, "Field is not defined by protocol v1."); }
function id(v: unknown, path: string, out: HostContractDiagnostic[]): v is string { if (typeof v === "string" && ID.test(v) && !["__proto__", "prototype", "constructor"].includes(v)) return true; add(out, "invalid-value", path, "Expected a stable ASCII identifier."); return false; }
function json(v: unknown, path: string, out: HostContractDiagnostic[], state: { values: number; strings: number }, depth = 0): void {
  if (++state.values > HOST_PROTOCOL_BUDGETS.jsonValues || depth > HOST_PROTOCOL_BUDGETS.jsonDepth) { add(out, "budget-exceeded", path, "JSON size or depth budget exceeded."); return; }
  if (v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) return;
  if (typeof v === "string") { state.strings += v.length; if (state.strings > HOST_PROTOCOL_BUDGETS.stringCodeUnits) add(out, "budget-exceeded", path, "String budget exceeded."); return; }
  if (dense(v)) { if (state.values + v.length > HOST_PROTOCOL_BUDGETS.jsonValues) { add(out, "budget-exceeded", path, "Array budget exceeded."); return; } v.forEach((x, i) => json(x, `${path}[${i}]`, out, state, depth + 1)); return; }
  if (object(v) && Reflect.ownKeys(v).every((key) => { const d = typeof key === "string" ? Object.getOwnPropertyDescriptor(v, key) : undefined; return d?.enumerable === true && "value" in d; })) { const entries = Object.entries(v); state.strings += entries.reduce((sum, [key]) => sum + key.length, 0); if (state.values + entries.length > HOST_PROTOCOL_BUDGETS.jsonValues || state.strings > HOST_PROTOCOL_BUDGETS.stringCodeUnits) { add(out, "budget-exceeded", path, "Object size budget exceeded."); return; } entries.forEach(([key, x]) => json(x, `${path}.${key}`, out, state, depth + 1)); return; }
  add(out, "invalid-json", path, "Expected finite plain dense JSON without functions, symbols or accessors.");
}
function preflight(input: unknown): HostContractDiagnostic[] { const out: HostContractDiagnostic[] = []; try { json(input, "$", out, { values: 0, strings: 0 }); } catch { add(out, "invalid-json", "$", "Input could not be inspected as JSON."); } return out; }
function base<T>(input: unknown, validate: (v: Obj, out: HostContractDiagnostic[]) => void): HostContractValidation<T> {
  const diagnostics = preflight(input); if (diagnostics.length || !object(input)) return { valid: false, diagnostics: diagnostics.length ? diagnostics : [{ code: "invalid-value", path: "$", message: "Expected object." }] };
  validate(input, diagnostics); return { valid: diagnostics.length === 0, diagnostics, ...(diagnostics.length ? {} : { value: input as T }) };
}
function commonEnvelope(v: Obj, out: HostContractDiagnostic[]): void {
  if (v.schemaVersion !== HOST_PROTOCOL_SCHEMA_VERSION) add(out, "invalid-schema", "$.schemaVersion", "Expected host protocol schema version 1.");
  for (const key of ["sessionId", "workspaceId", "hostId"] as const) id(v[key], `$.${key}`, out);
  if (!HOST_CAPABILITY_NAMES.includes(v.capability as HostCapabilityName)) add(out, "invalid-value", "$.capability", "Unknown host capability.");
  if (!integer(v.epoch) || !integer(v.revision)) add(out, "invalid-value", "$", "Epoch and revision must be non-negative safe integers.");
}

export function validateHostCapabilities(input: unknown): HostContractValidation<HostCapabilitiesV1> {
  return base(input, (v, out) => {
    keys(v, ["schemaVersion", "hostId", "hostKind", "revision", "capabilities"], "$", out);
    if (v.schemaVersion !== HOST_CAPABILITIES_SCHEMA_VERSION) add(out, "invalid-schema", "$.schemaVersion", "Expected capabilities schema version 1."); id(v.hostId, "$.hostId", out); if (!["native", "browser-lab", "migration-tool"].includes(v.hostKind as string)) add(out, "invalid-value", "$.hostKind", "Unknown host kind."); if (!integer(v.revision)) add(out, "invalid-value", "$.revision", "Expected non-negative safe integer.");
    if (!object(v.capabilities)) { add(out, "invalid-value", "$.capabilities", "Expected capability map."); return; } keys(v.capabilities, HOST_CAPABILITY_NAMES, "$.capabilities", out);
    for (const name of HOST_CAPABILITY_NAMES) { const item = v.capabilities[name], path = `$.capabilities.${name}`; if (!object(item)) { add(out, "invalid-value", path, "Every capability must be declared."); continue; } keys(item, ["status", "reason", "version"], path, out); if (!["supported", "degraded", "unsupported"].includes(item.status as string)) add(out, "invalid-value", `${path}.status`, "Unknown capability status."); const supported = item.status === "supported"; if (supported ? item.reason !== null : typeof item.reason !== "string" || !item.reason.trim()) add(out, "invalid-value", `${path}.reason`, "Supported requires null reason; other states require a reason."); if (item.status === "unsupported" ? item.version !== null : typeof item.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(item.version)) add(out, "invalid-value", `${path}.version`, "Supported/degraded require a semantic version; unsupported requires null."); }
  });
}

export function validateHostRequest(input: unknown): HostContractValidation<HostRequestEnvelope> {
  return base(input, (v, out) => { keys(v, ["schemaVersion", "requestId", "sessionId", "workspaceId", "hostId", "capability", "operation", "epoch", "revision", "deadlineUnixMs", "cancellationId", "payload"], "$", out); commonEnvelope(v, out); id(v.requestId, "$.requestId", out); if (typeof v.operation !== "string" || !OP.test(v.operation)) add(out, "invalid-value", "$.operation", "Expected stable operation name."); if (!integer(v.deadlineUnixMs) || v.deadlineUnixMs === 0) add(out, "invalid-value", "$.deadlineUnixMs", "Expected positive Unix millisecond deadline."); if (v.cancellationId !== null) id(v.cancellationId, "$.cancellationId", out); if (!Object.hasOwn(v, "payload")) add(out, "invalid-value", "$.payload", "Payload is required."); });
}
function protocolError(v: unknown, path: string, out: HostContractDiagnostic[]): void { if (!object(v)) { add(out, "invalid-value", path, "Expected protocol error."); return; } keys(v, ["code", "message", "retryable"], path, out); const codes: HostProtocolError["code"][] = ["invalid-envelope", "unsupported-capability", "deadline-exceeded", "cancelled", "stale-epoch", "stale-revision", "duplicate-request", "authority-conflict", "migration-in-progress", "migration-failed", "late-result", "owner-unavailable", "capacity-exceeded", "protocol-error"]; if (!codes.includes(v.code as HostProtocolError["code"]) || typeof v.message !== "string" || !v.message || typeof v.retryable !== "boolean") add(out, "invalid-value", path, "Invalid stable protocol error."); }
export function validateHostEvent(input: unknown): HostContractValidation<HostEventEnvelope> {
  return base(input, (v, out) => { keys(v, ["schemaVersion", "eventId", "requestId", "sessionId", "workspaceId", "hostId", "capability", "event", "kind", "epoch", "revision", "payload", "error"], "$", out); commonEnvelope(v, out); id(v.eventId, "$.eventId", out); if (v.requestId !== null) id(v.requestId, "$.requestId", out); if (typeof v.event !== "string" || !OP.test(v.event) || !["progress", "result", "error", "cancelled"].includes(v.kind as string)) add(out, "invalid-value", "$", "Invalid event name or kind."); if (!Object.hasOwn(v, "payload")) add(out, "invalid-value", "$.payload", "Payload is required."); if (v.kind === "error") protocolError(v.error, "$.error", out); else if (v.error !== null) add(out, "invalid-value", "$.error", "Only error events may carry an error."); });
}
export function validateAuthorityConfig(input: unknown): HostContractValidation<SessionAuthorityConfig> { return base(input, (v, out) => { keys(v, ["schemaVersion", "workspaceId", "sessionId", "epoch", "revision", "stateOwner", "networkOwner"], "$", out); if (v.schemaVersion !== 1) add(out, "invalid-schema", "$.schemaVersion", "Expected authority schema version 1."); for (const key of ["workspaceId", "sessionId", "stateOwner", "networkOwner"] as const) id(v[key], `$.${key}`, out); if (!integer(v.epoch) || !integer(v.revision)) add(out, "invalid-value", "$", "Epoch and revision must be non-negative safe integers."); }); }
export function validateMigrationRequest(input: unknown): HostContractValidation<AuthorityMigrationRequest> { return base(input, (v, out) => { keys(v, ["schemaVersion", "migrationId", "workspaceId", "targetOwner", "scope", "pendingPolicy", "deadlineUnixMs"], "$", out); if (v.schemaVersion !== 1) add(out, "invalid-schema", "$.schemaVersion", "Expected schema version 1."); for (const key of ["migrationId", "workspaceId", "targetOwner"] as const) id(v[key], `$.${key}`, out); if (!["state", "network", "both"].includes(v.scope as string) || !["drain", "cancel"].includes(v.pendingPolicy as string) || !integer(v.deadlineUnixMs) || v.deadlineUnixMs === 0) add(out, "invalid-value", "$", "Invalid migration scope, pending policy or deadline."); }); }
export function validateMigrationAck(input: unknown): HostContractValidation<AuthorityMigrationAck> { return base(input, (v, out) => { keys(v, ["schemaVersion", "migrationId", "workspaceId", "phase", "ok", "checkpointRevision", "reason", "nowUnixMs"], "$", out); if (v.schemaVersion !== 1) add(out, "invalid-schema", "$.schemaVersion", "Expected schema version 1."); id(v.migrationId, "$.migrationId", out); id(v.workspaceId, "$.workspaceId", out); const phaseOk = ["pause", "drain", "checkpoint", "close-confirmed", "resume"].includes(v.phase as string), checkpointOk = v.ok === true && v.phase === "checkpoint" ? integer(v.checkpointRevision) : v.checkpointRevision === null, reasonOk = v.ok === true ? v.reason === null : typeof v.reason === "string" && Boolean(v.reason.trim()); if (!phaseOk || typeof v.ok !== "boolean" || !checkpointOk || !reasonOk || !integer(v.nowUnixMs)) add(out, "invalid-value", "$", "Invalid migration acknowledgement."); }); }
export function validateCancellationRequest(input: unknown): HostContractValidation<AuthorityCancellationRequest> { return base(input, (v, out) => { keys(v, ["schemaVersion", "workspaceId", "sessionId", "cancellationId", "epoch"], "$", out); if (v.schemaVersion !== 1) add(out, "invalid-schema", "$.schemaVersion", "Expected schema version 1."); for (const key of ["workspaceId", "sessionId", "cancellationId"] as const) id(v[key], `$.${key}`, out); if (!integer(v.epoch)) add(out, "invalid-value", "$.epoch", "Expected a non-negative safe epoch."); }); }
