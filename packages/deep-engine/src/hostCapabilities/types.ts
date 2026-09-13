export const HOST_CAPABILITIES_SCHEMA_VERSION = 1 as const;
export const HOST_PROTOCOL_SCHEMA_VERSION = 1 as const;
export const HOST_PROTOCOL_BUDGETS = Object.freeze({
  jsonDepth: 32,
  jsonValues: 250_000,
  stringCodeUnits: 1_000_000,
  diagnostics: 128,
  pendingRequests: 8192,
  rememberedRequests: 65_536,
  cancellations: 8192,
} as const);

export const HOST_CAPABILITY_NAMES = [
  "Http", "Realtime", "Asset", "Task", "Script", "Media",
  "TextIme", "Accessibility", "Clipboard", "Window", "Diagnostics",
] as const;
export type HostCapabilityName = typeof HOST_CAPABILITY_NAMES[number];
export type HostKind = "native" | "browser-lab" | "migration-tool";
export type HostCapabilityStatus = "supported" | "degraded" | "unsupported";
export interface HostCapabilityDeclaration {
  readonly status: HostCapabilityStatus;
  readonly reason: string | null;
  readonly version: string | null;
}
export interface HostCapabilitiesV1 {
  readonly schemaVersion: 1;
  readonly hostId: string;
  readonly hostKind: HostKind;
  readonly revision: number;
  readonly capabilities: Readonly<Record<HostCapabilityName, HostCapabilityDeclaration>>;
}

export type HostErrorCode =
  | "invalid-envelope" | "unsupported-capability" | "deadline-exceeded" | "cancelled"
  | "stale-epoch" | "stale-revision" | "duplicate-request" | "authority-conflict"
  | "migration-in-progress" | "migration-failed" | "late-result" | "owner-unavailable"
  | "capacity-exceeded" | "protocol-error";
export interface HostProtocolError {
  readonly code: HostErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}
export type HostJson = null | boolean | number | string | readonly HostJson[] | { readonly [key: string]: HostJson };
export interface HostRequestEnvelope {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly hostId: string;
  readonly capability: HostCapabilityName;
  readonly operation: string;
  readonly epoch: number;
  readonly revision: number;
  readonly deadlineUnixMs: number;
  readonly cancellationId: string | null;
  readonly payload: HostJson;
}
export type HostEventKind = "progress" | "result" | "error" | "cancelled";
export interface HostEventEnvelope {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly requestId: string | null;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly hostId: string;
  readonly capability: HostCapabilityName;
  readonly event: string;
  readonly kind: HostEventKind;
  readonly epoch: number;
  readonly revision: number;
  readonly payload: HostJson;
  readonly error: HostProtocolError | null;
}

export type HostContractDiagnosticCode = "invalid-json" | "invalid-schema" | "invalid-value" | "unknown-field" | "budget-exceeded";
export interface HostContractDiagnostic { readonly code: HostContractDiagnosticCode; readonly path: string; readonly message: string }
export interface HostContractValidation<T> { readonly valid: boolean; readonly diagnostics: readonly HostContractDiagnostic[]; readonly value?: T }

export interface SessionAuthorityConfig {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly revision: number;
  readonly stateOwner: string;
  readonly networkOwner: string;
}
export interface AuthorityDecision {
  readonly ok: boolean;
  readonly duplicate: boolean;
  readonly epoch: number;
  readonly revision: number;
  readonly error?: HostProtocolError;
}
export interface SessionAuthoritySnapshot {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly revision: number;
  readonly stateOwner: string;
  readonly networkOwner: string;
  readonly paused: boolean;
  readonly pendingRequests: number;
  readonly migrationId: string | null;
}
export interface AuthorityCancellationRequest {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly cancellationId: string;
  readonly epoch: number;
}
export type AuthorityMigrationScope = "state" | "network" | "both";
export type AuthorityMigrationPhase = "pause" | "drain" | "checkpoint" | "close-confirmed" | "resume";
export interface AuthorityMigrationRequest {
  readonly schemaVersion: 1;
  readonly migrationId: string;
  readonly workspaceId: string;
  readonly targetOwner: string;
  readonly scope: AuthorityMigrationScope;
  readonly pendingPolicy: "drain" | "cancel";
  readonly deadlineUnixMs: number;
}
export interface AuthorityMigrationAck {
  readonly schemaVersion: 1;
  readonly migrationId: string;
  readonly workspaceId: string;
  readonly phase: AuthorityMigrationPhase;
  readonly ok: boolean;
  readonly checkpointRevision: number | null;
  readonly reason: string | null;
  readonly nowUnixMs: number;
}
export interface AuthorityMigrationResult extends AuthorityDecision {
  readonly phase?: AuthorityMigrationPhase;
  readonly completed?: boolean;
  readonly rolledBack?: boolean;
  readonly stateOwner: string;
  readonly networkOwner: string;
}
