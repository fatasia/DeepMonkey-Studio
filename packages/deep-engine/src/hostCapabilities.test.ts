import { describe, expect, it } from "vitest";
import {
  HOST_CAPABILITY_NAMES,
  SessionAuthorityCoordinator,
  createSessionAuthorityCoordinator,
  validateHostCapabilities,
  validateHostEvent,
  validateHostRequest,
  type AuthorityMigrationAck,
  type AuthorityMigrationRequest,
  type HostEventEnvelope,
  type HostRequestEnvelope,
  type SessionAuthorityConfig,
} from "./hostCapabilities.js";

const config: SessionAuthorityConfig = { schemaVersion: 1, workspaceId: "workspace-1", sessionId: "session-1", epoch: 0, revision: 0, stateOwner: "state-a", networkOwner: "network-a" };
function request(overrides: Partial<HostRequestEnvelope> = {}): HostRequestEnvelope {
  return { schemaVersion: 1, requestId: "request-1", sessionId: "session-1", workspaceId: "workspace-1", hostId: "state-a", capability: "Task", operation: "task.run", epoch: 0, revision: 0, deadlineUnixMs: 2_000, cancellationId: "cancel-1", payload: { value: 1 }, ...overrides };
}
function event(overrides: Partial<HostEventEnvelope> = {}): HostEventEnvelope {
  return { schemaVersion: 1, eventId: "event-1", requestId: "request-1", sessionId: "session-1", workspaceId: "workspace-1", hostId: "state-a", capability: "Task", event: "task.result", kind: "result", epoch: 0, revision: 1, payload: { done: true }, error: null, ...overrides };
}
function migration(overrides: Partial<AuthorityMigrationRequest> = {}): AuthorityMigrationRequest {
  return { schemaVersion: 1, migrationId: "migration-1", workspaceId: "workspace-1", targetOwner: "state-b", scope: "state", pendingPolicy: "cancel", deadlineUnixMs: 5_000, ...overrides };
}
function ack(phase: AuthorityMigrationAck["phase"], overrides: Partial<AuthorityMigrationAck> = {}): AuthorityMigrationAck {
  return { schemaVersion: 1, migrationId: "migration-1", workspaceId: "workspace-1", phase, ok: true, checkpointRevision: phase === "checkpoint" ? 0 : null, reason: null, nowUnixMs: 100, ...overrides };
}
function errorCode(result: { error?: { code: string } }): string | undefined { return result.error?.code; }

describe("HostCapabilities v1 validation", () => {
  it("requires an explicit, versioned declaration for every capability", () => {
    const capabilities = Object.fromEntries(HOST_CAPABILITY_NAMES.map((name, index) => [name, index % 3 === 0
      ? { status: "supported", reason: null, version: "1.2.3" }
      : index % 3 === 1 ? { status: "degraded", reason: "No background mode", version: "1.0.0-beta.1" }
        : { status: "unsupported", reason: "Host has no provider", version: null }]));
    for (const hostKind of ["native", "browser-lab", "migration-tool"] as const) expect(validateHostCapabilities({ schemaVersion: 1, hostId: "host-1", hostKind, revision: 2, capabilities }).valid).toBe(true);
    const missing = { ...capabilities }; delete missing.Http;
    expect(validateHostCapabilities({ schemaVersion: 1, hostId: "host-1", hostKind: "native", revision: 0, capabilities: missing }).valid).toBe(false);
    expect(validateHostCapabilities({ schemaVersion: 1, hostId: "host-1", hostKind: "native", revision: 0, capabilities: { ...capabilities, Http: { status: "supported", reason: "secret fallback", version: null }, Surprise: capabilities.Task } }).diagnostics.map((x) => x.code)).toEqual(expect.arrayContaining(["unknown-field", "invalid-value"]));
  });

  it("rejects non-JSON, accessors, sparse arrays, excessive depth and unknown fields", () => {
    expect(validateHostRequest({ ...request(), payload: { callback: () => 1 } }).valid).toBe(false);
    const sparse = Array(2); sparse[1] = 1;
    expect(validateHostRequest({ ...request(), payload: sparse }).diagnostics.some((x) => x.code === "invalid-json")).toBe(true);
    let accessed = false; const hostile = { ...request() }; Object.defineProperty(hostile, "payload", { enumerable: true, get() { accessed = true; throw new Error("must not run"); } });
    expect(validateHostRequest(hostile).valid).toBe(false); expect(accessed).toBe(false);
    let deep: unknown = null; for (let i = 0; i < 35; i++) deep = [deep];
    expect(validateHostRequest({ ...request(), payload: deep }).diagnostics.some((x) => x.code === "budget-exceeded")).toBe(true);
    expect(validateHostRequest({ ...request(), payload: null, surprise: true }).diagnostics.some((x) => x.code === "unknown-field")).toBe(true);
    const { payload: _payload, ...missingPayload } = request(); expect(validateHostRequest(missingPayload).valid).toBe(false);
  });

  it("enforces stable event error and payload semantics", () => {
    expect(validateHostRequest(request()).valid).toBe(true);
    expect(validateHostEvent(event()).valid).toBe(true);
    expect(validateHostEvent(event({ kind: "error", error: { code: "not-stable" as never, message: "bad", retryable: false } })).valid).toBe(false);
    expect(validateHostEvent(event({ kind: "result", error: { code: "protocol-error", message: "bad", retryable: false } })).valid).toBe(false);
    expect(validateHostRequest(request({ deadlineUnixMs: Number.NaN })).valid).toBe(false);
  });
});

describe("SessionAuthorityCoordinator", () => {
  it("creates only from a strict config and enforces owner, epoch, revision and dedupe", () => {
    expect(createSessionAuthorityCoordinator({ ...config, extra: true }).ok).toBe(false);
    const made = createSessionAuthorityCoordinator(config); expect(made.ok).toBe(true); const coordinator = made.coordinator!;
    expect(coordinator.acceptRequest(request(), 100).ok).toBe(true);
    const duplicate = coordinator.acceptRequest(request(), 100); expect(duplicate.duplicate).toBe(true); expect(errorCode(duplicate)).toBe("duplicate-request");
    expect(errorCode(coordinator.acceptRequest(request({ requestId: "request-1", payload: { value: 2 } }), 100))).toBe("protocol-error");
    expect(errorCode(coordinator.acceptRequest(request({ requestId: "bad-owner", hostId: "network-a" }), 100))).toBe("authority-conflict");
    expect(errorCode(coordinator.acceptRequest(request({ requestId: "bad-epoch", epoch: 1 }), 100))).toBe("stale-epoch");
    expect(errorCode(coordinator.acceptRequest(request({ requestId: "bad-revision", revision: 1 }), 100))).toBe("stale-revision");
    expect(errorCode(coordinator.acceptRequest(request({ requestId: "expired", deadlineUnixMs: 100 }), 100))).toBe("deadline-exceeded");
    expect(coordinator.snapshot).toMatchObject({ stateOwner: "state-a", networkOwner: "network-a", pendingRequests: 1, paused: false });
  });

  it("accepts progress and one terminal result, then rejects late or stale results", () => {
    const coordinator = new SessionAuthorityCoordinator(config); coordinator.acceptRequest(request(), 10);
    expect(coordinator.acceptEvent(event({ kind: "progress", revision: 0 }), 20).ok).toBe(true); expect(coordinator.snapshot.pendingRequests).toBe(1);
    expect(errorCode(coordinator.acceptEvent(event({ eventId: "future-progress", kind: "progress", revision: 1 }), 21))).toBe("stale-revision");
    expect(coordinator.acceptEvent(event(), 30).ok).toBe(true); expect(coordinator.snapshot).toMatchObject({ revision: 1, pendingRequests: 0 });
    expect(errorCode(coordinator.acceptEvent(event({ eventId: "late-event" }), 40))).toBe("late-result");
    expect(errorCode(coordinator.acceptRequest(request({ requestId: "stale-request" }), 40))).toBe("stale-revision");
    expect(coordinator.acceptRequest(request({ requestId: "next-request", revision: 1 }), 40).ok).toBe(true);
    expect(errorCode(coordinator.acceptEvent(event({ eventId: "stale-event", requestId: "next-request", revision: 0 }), 50))).toBe("stale-revision");
  });

  it("serializes state revisions while allowing an older network result to finish causally", () => {
    const coordinator = new SessionAuthorityCoordinator(config);
    expect(coordinator.acceptRequest(request({ requestId: "state-first", cancellationId: null }), 10).ok).toBe(true);
    expect(coordinator.acceptRequest(request({ requestId: "state-concurrent", cancellationId: null }), 10).ok).toBe(true);
    expect(coordinator.acceptRequest(request({ requestId: "network-concurrent", hostId: "network-a", capability: "Http", operation: "http.send", cancellationId: null }), 10).ok).toBe(true);
    expect(coordinator.acceptEvent(event({ eventId: "state-first-result", requestId: "state-first", revision: 1 }), 20).ok).toBe(true);
    expect(errorCode(coordinator.acceptEvent(event({ eventId: "state-concurrent-result", requestId: "state-concurrent", revision: 1 }), 21))).toBe("stale-revision");
    expect(coordinator.acceptEvent(event({ eventId: "network-result", requestId: "network-concurrent", hostId: "network-a", capability: "Http", revision: 0 }), 22).ok).toBe(true);
    expect(coordinator.snapshot).toMatchObject({ revision: 1, pendingRequests: 1 });
    expect(errorCode(coordinator.acceptEvent(event({ eventId: "network-bad-revision", requestId: "state-concurrent", revision: 2 }), 23))).toBe("stale-revision");
  });

  it("cancels matching work, expires deadlines and rejects their late results", () => {
    const coordinator = new SessionAuthorityCoordinator(config); coordinator.acceptRequest(request(), 10);
    expect(coordinator.cancel({ schemaVersion: 1, workspaceId: "workspace-1", sessionId: "session-1", cancellationId: "cancel-1", epoch: 0 }).ok).toBe(true);
    expect(errorCode(coordinator.acceptEvent(event(), 20))).toBe("late-result");
    expect(errorCode(coordinator.acceptRequest(request({ requestId: "cancelled-before-start" }), 20))).toBe("cancelled");
    coordinator.acceptRequest(request({ requestId: "expire-me", cancellationId: null, deadlineUnixMs: 30 }), 20);
    expect(coordinator.expire(30)).toBe(1); expect(errorCode(coordinator.acceptEvent(event({ eventId: "expired-event", requestId: "expire-me" }), 31))).toBe("late-result");
  });

  it("migrates authority through all ordered phases without dual ownership", () => {
    const coordinator = new SessionAuthorityCoordinator(config); coordinator.acceptRequest(request(), 10);
    coordinator.acceptRequest(request({ requestId: "network-request", hostId: "network-a", capability: "Http", operation: "http.send", cancellationId: null }), 10);
    expect(coordinator.beginMigration(migration(), 20)).toMatchObject({ ok: true, phase: "pause", stateOwner: "state-a", networkOwner: "network-a" });
    expect(errorCode(coordinator.acceptRequest(request({ requestId: "during-migration" }), 30))).toBe("migration-in-progress");
    expect(coordinator.acknowledgeMigration(ack("pause"))).toMatchObject({ phase: "drain", stateOwner: "state-a" });
    expect(coordinator.snapshot.pendingRequests).toBe(0);
    expect(coordinator.acknowledgeMigration(ack("drain"))).toMatchObject({ phase: "checkpoint" });
    expect(coordinator.acknowledgeMigration(ack("checkpoint"))).toMatchObject({ phase: "close-confirmed" });
    expect(coordinator.acknowledgeMigration(ack("close-confirmed"))).toMatchObject({ phase: "resume", stateOwner: "state-b", networkOwner: "network-a", epoch: 1 });
    expect(coordinator.snapshot).toMatchObject({ stateOwner: "state-b", networkOwner: "network-a", paused: true });
    expect(coordinator.acknowledgeMigration(ack("resume"))).toMatchObject({ ok: true, completed: true, stateOwner: "state-b", networkOwner: "network-a" });
    expect(coordinator.snapshot).toMatchObject({ epoch: 1, paused: false, migrationId: null });
  });

  it("waits for drain and validates the exact checkpoint revision", () => {
    const coordinator = new SessionAuthorityCoordinator(config); coordinator.acceptRequest(request({ cancellationId: null }), 10);
    coordinator.beginMigration(migration({ pendingPolicy: "drain" }), 20); coordinator.acknowledgeMigration(ack("pause"));
    expect(errorCode(coordinator.acknowledgeMigration(ack("drain")))).toBe("migration-in-progress");
    expect(coordinator.acceptEvent(event(), 30).ok).toBe(true);
    expect(coordinator.acknowledgeMigration(ack("drain"))).toMatchObject({ ok: true, phase: "checkpoint", revision: 1 });
    expect(errorCode(coordinator.acknowledgeMigration(ack("checkpoint", { checkpointRevision: 0 })))).toBe("stale-revision");
    expect(coordinator.acknowledgeMigration(ack("checkpoint", { checkpointRevision: 1 }))).toMatchObject({ ok: true, phase: "close-confirmed" });
  });

  it("rolls back atomically before or after a tentative switch", () => {
    const before = new SessionAuthorityCoordinator(config); before.beginMigration(migration(), 10); before.acknowledgeMigration(ack("pause")); before.acknowledgeMigration(ack("drain"));
    expect(before.acknowledgeMigration(ack("checkpoint", { ok: false, checkpointRevision: null, reason: "checkpoint failed" }))).toMatchObject({ ok: false, rolledBack: true, stateOwner: "state-a", networkOwner: "network-a", epoch: 0 });
    expect(before.snapshot.paused).toBe(false);
    const after = new SessionAuthorityCoordinator(config); after.beginMigration(migration(), 10); after.acknowledgeMigration(ack("pause")); after.acknowledgeMigration(ack("drain")); after.acknowledgeMigration(ack("checkpoint")); after.acknowledgeMigration(ack("close-confirmed"));
    expect(after.acknowledgeMigration(ack("resume", { ok: false, reason: "new owner unavailable" }))).toMatchObject({ ok: false, rolledBack: true, stateOwner: "state-a", networkOwner: "network-a", epoch: 2 });
    expect(after.snapshot).toMatchObject({ stateOwner: "state-a", networkOwner: "network-a", paused: false });
  });

  it("rejects out-of-order, timed-out and replayed migrations", () => {
    const coordinator = new SessionAuthorityCoordinator(config); coordinator.beginMigration(migration(), 10);
    expect(errorCode(coordinator.acknowledgeMigration(ack("drain")))).toBe("protocol-error");
    expect(coordinator.acknowledgeMigration(ack("pause", { nowUnixMs: 5_000 }))).toMatchObject({ rolledBack: true, stateOwner: "state-a" });
    expect(errorCode(coordinator.beginMigration(migration(), 20))).toBe("duplicate-request");
    expect(errorCode(coordinator.beginMigration(migration({ migrationId: "already-expired", deadlineUnixMs: 20 }), 20))).toBe("deadline-exceeded");
    const timer = new SessionAuthorityCoordinator(config); timer.beginMigration(migration({ migrationId: "timer" }), 10);
    expect(timer.expireMigration(4_999)).toBeNull(); expect(timer.expireMigration(5_000)).toMatchObject({ rolledBack: true, stateOwner: "state-a", epoch: 0 });
  });
});
