import { HOST_PROTOCOL_BUDGETS, type AuthorityCancellationRequest, type AuthorityDecision, type AuthorityMigrationAck, type AuthorityMigrationPhase, type AuthorityMigrationRequest, type AuthorityMigrationResult, type HostCapabilityName, type HostEventEnvelope, type HostJson, type HostProtocolError, type HostRequestEnvelope, type SessionAuthorityConfig, type SessionAuthoritySnapshot } from "./types.js";
import { validateAuthorityConfig, validateCancellationRequest, validateHostEvent, validateHostRequest, validateMigrationAck, validateMigrationRequest } from "./validation.js";

const NETWORK = new Set<HostCapabilityName>(["Http", "Realtime", "Asset", "Media"]);
type SeenState = "pending" | "completed" | "cancelled" | "expired";
interface Seen { readonly fingerprint: string; state: SeenState }
interface Migration { readonly request: AuthorityMigrationRequest; readonly oldState: string; readonly oldNetwork: string; readonly oldEpoch: number; phase: AuthorityMigrationPhase; switched: boolean }
export interface CoordinatorCreation { readonly ok: boolean; readonly diagnostics: readonly import("./types.js").HostContractDiagnostic[]; readonly coordinator?: SessionAuthorityCoordinator }

const error = (code: HostProtocolError["code"], message: string, retryable = false): HostProtocolError => ({ code, message, retryable });
function canonical(value: HostJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as { readonly [key: string]: HostJson };
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key]!)}`).join(",")}}`;
}
function fingerprint(request: HostRequestEnvelope): string { return canonical(request as unknown as HostJson); }
function validNow(now: number): boolean { return Number.isSafeInteger(now) && now >= 0; }

export class SessionAuthorityCoordinator {
  readonly #workspaceId: string;
  readonly #sessionId: string;
  #epoch: number;
  #revision: number;
  #stateOwner: string;
  #networkOwner: string;
  #paused = false;
  #migration: Migration | undefined;
  readonly #pending = new Map<string, HostRequestEnvelope>();
  readonly #seen = new Map<string, Seen>();
  readonly #cancelled = new Set<string>();
  readonly #migrationIds = new Set<string>();

  constructor(config: SessionAuthorityConfig) {
    const checked = validateAuthorityConfig(config);
    if (!checked.valid) throw new TypeError("Invalid SessionAuthorityConfig; use createSessionAuthorityCoordinator for diagnostics.");
    this.#workspaceId = config.workspaceId; this.#sessionId = config.sessionId; this.#epoch = config.epoch; this.#revision = config.revision; this.#stateOwner = config.stateOwner; this.#networkOwner = config.networkOwner;
  }

  get snapshot(): SessionAuthoritySnapshot { return Object.freeze({ workspaceId: this.#workspaceId, sessionId: this.#sessionId, epoch: this.#epoch, revision: this.#revision, stateOwner: this.#stateOwner, networkOwner: this.#networkOwner, paused: this.#paused, pendingRequests: this.#pending.size, migrationId: this.#migration?.request.migrationId ?? null }); }
  #decision(ok: boolean, protocolError?: HostProtocolError, duplicate = false): AuthorityDecision { return { ok, duplicate, epoch: this.#epoch, revision: this.#revision, ...(protocolError ? { error: protocolError } : {}) }; }
  #migrationResult(ok: boolean, fields: Partial<AuthorityMigrationResult> = {}, protocolError?: HostProtocolError): AuthorityMigrationResult { return { ...this.#decision(ok, protocolError), stateOwner: this.#stateOwner, networkOwner: this.#networkOwner, ...fields }; }
  #owner(capability: HostCapabilityName): string { return NETWORK.has(capability) ? this.#networkOwner : this.#stateOwner; }
  #remember(id: string, seen: Seen): void {
    this.#seen.set(id, seen);
    if (this.#seen.size <= HOST_PROTOCOL_BUDGETS.rememberedRequests) return;
    for (const [key, value] of this.#seen) if (value.state !== "pending") { this.#seen.delete(key); break; }
  }

  acceptRequest(input: unknown, nowUnixMs: number): AuthorityDecision {
    const checked = validateHostRequest(input);
    if (!checked.valid || !validNow(nowUnixMs)) return this.#decision(false, error("invalid-envelope", "Request or current time is invalid."));
    const request = checked.value!; const print = fingerprint(request); const prior = this.#seen.get(request.requestId);
    if (prior) return prior.fingerprint === print ? this.#decision(false, error("duplicate-request", "Request id was already accepted.", true), true) : this.#decision(false, error("protocol-error", "Request id was reused with different content."));
    if (request.workspaceId !== this.#workspaceId || request.sessionId !== this.#sessionId) return this.#decision(false, error("authority-conflict", "Request belongs to another workspace or session."));
    if (this.#paused) return this.#decision(false, error("migration-in-progress", "Authority is paused for migration.", true));
    if (request.hostId !== this.#owner(request.capability)) return this.#decision(false, error("authority-conflict", "Host is not the capability owner."));
    if (request.epoch !== this.#epoch) return this.#decision(false, error("stale-epoch", "Request epoch does not match authority epoch."));
    if (request.revision !== this.#revision) return this.#decision(false, error("stale-revision", "Request revision does not match authority revision."));
    if (request.deadlineUnixMs <= nowUnixMs) return this.#decision(false, error("deadline-exceeded", "Request deadline has elapsed."));
    if (request.cancellationId && this.#cancelled.has(request.cancellationId)) return this.#decision(false, error("cancelled", "Cancellation was already requested."));
    if (this.#pending.size >= HOST_PROTOCOL_BUDGETS.pendingRequests) return this.#decision(false, error("capacity-exceeded", "Pending request budget exceeded.", true));
    this.#pending.set(request.requestId, JSON.parse(print) as HostRequestEnvelope); this.#remember(request.requestId, { fingerprint: print, state: "pending" }); return this.#decision(true);
  }

  acceptEvent(input: unknown, nowUnixMs: number): AuthorityDecision {
    const checked = validateHostEvent(input);
    if (!checked.valid || !validNow(nowUnixMs)) return this.#decision(false, error("invalid-envelope", "Event or current time is invalid."));
    const event = checked.value!;
    if (!event.requestId) return this.#decision(false, error("protocol-error", "Coordinator events require a request id."));
    const request = this.#pending.get(event.requestId); const seen = this.#seen.get(event.requestId);
    if (!request) return this.#decision(false, error(seen ? "late-result" : "protocol-error", seen ? "Request is no longer pending." : "Unknown request id."));
    if (event.workspaceId !== this.#workspaceId || event.sessionId !== this.#sessionId || event.hostId !== request.hostId || event.capability !== request.capability) return this.#decision(false, error("authority-conflict", "Event does not match its request authority."));
    if (event.epoch !== this.#epoch || event.epoch !== request.epoch) return this.#decision(false, error("stale-epoch", "Event epoch is stale."));
    const network = NETWORK.has(request.capability);
    if (event.revision < request.revision
      || (network && event.revision !== request.revision)
      || (event.kind === "progress" && event.revision !== request.revision)
      || (!network && request.revision !== this.#revision)
      || (!network && event.revision > request.revision + 1)) {
      return this.#decision(false, error("stale-revision", "Event revision does not match its causal authority revision."));
    }
    if (request.deadlineUnixMs <= nowUnixMs) { this.#finish(request.requestId, "expired"); return this.#decision(false, error("deadline-exceeded", "Result arrived after its deadline.")); }
    if (request.cancellationId && this.#cancelled.has(request.cancellationId)) { this.#finish(request.requestId, "cancelled"); return this.#decision(false, error("late-result", "Result arrived after cancellation.")); }
    if (event.kind === "progress") return this.#decision(true);
    if (!network) this.#revision = event.revision;
    this.#finish(request.requestId, event.kind === "cancelled" ? "cancelled" : "completed"); return this.#decision(true);
  }
  completeEvent(input: unknown, nowUnixMs: number): AuthorityDecision { return this.acceptEvent(input, nowUnixMs); }

  cancel(input: unknown): AuthorityDecision {
    const checked = validateCancellationRequest(input);
    if (!checked.valid) return this.#decision(false, error("invalid-envelope", "Cancellation envelope is invalid."));
    const value: AuthorityCancellationRequest = checked.value!;
    if (value.workspaceId !== this.#workspaceId || value.sessionId !== this.#sessionId) return this.#decision(false, error("authority-conflict", "Cancellation belongs to another session."));
    if (value.epoch !== this.#epoch) return this.#decision(false, error("stale-epoch", "Cancellation epoch is stale."));
    if (this.#cancelled.size >= HOST_PROTOCOL_BUDGETS.cancellations && !this.#cancelled.has(value.cancellationId)) return this.#decision(false, error("capacity-exceeded", "Cancellation budget exceeded."));
    this.#cancelled.add(value.cancellationId); for (const [id, request] of this.#pending) if (request.cancellationId === value.cancellationId) this.#finish(id, "cancelled"); return this.#decision(true);
  }

  expire(nowUnixMs: number): number { if (!validNow(nowUnixMs)) return 0; let count = 0; for (const [id, request] of this.#pending) if (request.deadlineUnixMs <= nowUnixMs) { this.#finish(id, "expired"); count++; } return count; }
  #finish(id: string, state: SeenState): void { this.#pending.delete(id); const seen = this.#seen.get(id); if (seen) seen.state = state; }

  beginMigration(input: unknown, nowUnixMs: number): AuthorityMigrationResult {
    const checked = validateMigrationRequest(input);
    if (!checked.valid || !validNow(nowUnixMs)) return this.#migrationResult(false, {}, error("invalid-envelope", "Migration request or current time is invalid."));
    const request = checked.value!;
    if (request.workspaceId !== this.#workspaceId) return this.#migrationResult(false, {}, error("authority-conflict", "Migration belongs to another workspace."));
    if (request.deadlineUnixMs <= nowUnixMs) return this.#migrationResult(false, {}, error("deadline-exceeded", "Migration deadline has elapsed."));
    if (this.#migration || this.#migrationIds.has(request.migrationId)) return this.#migrationResult(false, {}, error(this.#migrationIds.has(request.migrationId) ? "duplicate-request" : "migration-in-progress", "Migration is already active or remembered.", true));
    if (this.#migrationIds.size >= HOST_PROTOCOL_BUDGETS.rememberedRequests) return this.#migrationResult(false, {}, error("capacity-exceeded", "Remembered migration budget exceeded."));
    if (this.#epoch > Number.MAX_SAFE_INTEGER - 2) return this.#migrationResult(false, {}, error("capacity-exceeded", "Authority epoch cannot advance safely."));
    const wantsState = request.scope !== "network", wantsNetwork = request.scope !== "state";
    if ((!wantsState || request.targetOwner === this.#stateOwner) && (!wantsNetwork || request.targetOwner === this.#networkOwner)) return this.#migrationResult(false, {}, error("authority-conflict", "Target already owns the requested scope."));
    const stored = Object.freeze({ ...request }); this.#migration = { request: stored, oldState: this.#stateOwner, oldNetwork: this.#networkOwner, oldEpoch: this.#epoch, phase: "pause", switched: false }; this.#migrationIds.add(request.migrationId); this.#paused = true;
    return this.#migrationResult(true, { phase: "pause" });
  }

  acknowledgeMigration(input: unknown): AuthorityMigrationResult {
    const checked = validateMigrationAck(input);
    if (!checked.valid) return this.#migrationResult(false, {}, error("invalid-envelope", "Migration acknowledgement is invalid."));
    const ack: AuthorityMigrationAck = checked.value!; const migration = this.#migration;
    if (!migration || ack.migrationId !== migration.request.migrationId || ack.workspaceId !== this.#workspaceId) return this.#migrationResult(false, {}, error("protocol-error", "No matching active migration."));
    if (ack.nowUnixMs >= migration.request.deadlineUnixMs) return this.#rollback("Migration deadline elapsed.");
    if (ack.phase !== migration.phase) return this.#migrationResult(false, { phase: migration.phase }, error("protocol-error", "Migration phase acknowledgement is out of order."));
    if (!ack.ok) return this.#rollback(ack.reason || "Host rejected migration phase.");
    if (ack.phase === "pause") {
      if (migration.request.pendingPolicy === "cancel") for (const id of [...this.#pending.keys()]) this.#finish(id, "cancelled");
      migration.phase = "drain";
    } else if (ack.phase === "drain") {
      if (this.#pending.size) return this.#migrationResult(false, { phase: "drain" }, error("migration-in-progress", "Workspace requests have not drained.", true));
      migration.phase = "checkpoint";
    } else if (ack.phase === "checkpoint") {
      if (ack.checkpointRevision !== this.#revision) return this.#migrationResult(false, { phase: "checkpoint" }, error("stale-revision", "Checkpoint revision does not match current revision."));
      migration.phase = "close-confirmed";
    } else if (ack.phase === "close-confirmed") {
      if (migration.request.scope !== "network") this.#stateOwner = migration.request.targetOwner;
      if (migration.request.scope !== "state") this.#networkOwner = migration.request.targetOwner;
      this.#epoch++; migration.switched = true; migration.phase = "resume";
    } else {
      this.#paused = false; this.#migration = undefined; return this.#migrationResult(true, { completed: true });
    }
    return this.#migrationResult(true, { phase: migration.phase });
  }

  expireMigration(nowUnixMs: number): AuthorityMigrationResult | null {
    if (!this.#migration || !validNow(nowUnixMs) || nowUnixMs < this.#migration.request.deadlineUnixMs) return null;
    return this.#rollback("Migration deadline elapsed.");
  }

  #rollback(reason: string): AuthorityMigrationResult {
    const migration = this.#migration!; this.#stateOwner = migration.oldState; this.#networkOwner = migration.oldNetwork;
    if (migration.switched) this.#epoch++; else this.#epoch = migration.oldEpoch;
    this.#paused = false; this.#migration = undefined; return this.#migrationResult(false, { rolledBack: true }, error("migration-failed", reason, true));
  }
}

export function createSessionAuthorityCoordinator(input: unknown): CoordinatorCreation {
  const checked = validateAuthorityConfig(input);
  return checked.valid ? { ok: true, diagnostics: [], coordinator: new SessionAuthorityCoordinator(checked.value!) } : { ok: false, diagnostics: checked.diagnostics };
}
