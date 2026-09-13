import type { PreparedPacket } from "../renderPacketTypes.js";
import type {
  GpuResidencyExecutorOptions,
  ResidencyBudgets,
} from "../streaming/index.js";
import type { DeviceSession } from "./deviceSession.js";
import type { GpuRenderResidencyTelemetrySnapshot } from "./gpuRenderResidencyTelemetry.js";
import {
  GpuRenderResidencyRuntime,
  type GpuRenderResidencyFrameResult,
  type GpuRenderResidencyProfile,
  type GpuRenderResidencyRequest,
} from "./gpuRenderResidencyRuntime.js";
import {
  createPacketResidencyCatalogFromSnapshot,
  type PacketResidencyCatalog,
} from "./packetResidencyCatalog.js";
import {
  foreignPacketResidencyRequest,
  incompletePacketResidency,
} from "./packetResidencyClosure.js";
import {
  PacketResidencyLoadError,
  type PacketResidencyLoadOptions,
} from "./packetResidencyLoader.js";
import {
  createResidentPacketProjection,
  type ResidentPacketProjection,
} from "./residentPacketProjection.js";
import {
  mergePacketResidencyRequests,
  releasePacketResidencySet,
  type PacketResidencySetEntry,
  type PacketResidencySetLoadOptions,
  type PacketResidencySetProjection,
} from "./packetResidencySet.js";
import {
  packetResidencyIdentity as identity,
  packetResidencySource as packetSource,
  sameResidencyProfile as sameProfile,
  sameResidencySource as sameSource,
  snapshotResidencyPacket as snapshotPacket,
  type PacketResidencySourceSnapshot as SourceSnapshot,
} from "./packetResidencySnapshot.js";

declare const ticketBrand: unique symbol;
export interface PacketResidencyTicket {
  readonly requests: readonly GpuRenderResidencyRequest[];
  readonly [ticketBrand]: never;
}

export interface PacketResidencyDomain {
  readonly disposed: boolean;
  readonly residentBytes: number;
  readonly retiredBytes: number;
  telemetrySnapshot(): GpuRenderResidencyTelemetrySnapshot;
  registerPacket(key: string, packet: PreparedPacket): PacketResidencyTicket;
  load(ticket: PacketResidencyTicket, options: PacketResidencyLoadOptions): Promise<ResidentPacketProjection>;
  /** Applies one atomic global frame and optionally acquires projections for several packets. */
  loadSet(options: PacketResidencySetLoadOptions): Promise<readonly PacketResidencySetProjection[]>;
  /** Invalidates the ticket. Resident or leased orphan resources retire through later frames or dispose(). */
  unregister(ticket: PacketResidencyTicket): void;
  dispose(): void;
}

interface TicketState {
  readonly key: string;
  readonly packet: PreparedPacket;
  readonly catalog: PacketResidencyCatalog;
  readonly identities: readonly string[];
  active: boolean;
}

interface SourceRecord {
  readonly profile: GpuRenderResidencyProfile;
  readonly source: SourceSnapshot;
  readonly sourceFor: PacketResidencyCatalog["sourceFor"];
  refs: number;
}

/** Owns one collision-safe GPU budget shared by every registered packet. */
export function createPacketResidencyDomain(
  session: DeviceSession,
  budgets: ResidencyBudgets,
  options?: GpuResidencyExecutorOptions,
): PacketResidencyDomain {
  const records = new Map<string, SourceRecord>();
  const tickets = new WeakMap<object, TicketState>();
  const keys = new Map<string, TicketState>();
  let disposed = false, inFlight = 0;
  const runtime = new GpuRenderResidencyRuntime(session, budgets, request => {
    const record = records.get(identity(request.kind, request.id));
    if (!record) throw new Error(`Unknown packet residency source: ${request.kind}:${request.id}.`);
    return record.sourceFor(request);
  }, options);

  const domain: PacketResidencyDomain = Object.freeze({
    get disposed() { return disposed; },
    get residentBytes() { return runtime.residentBytes; },
    get retiredBytes() { return runtime.retiredBytes; },
    telemetrySnapshot: () => runtime.telemetrySnapshot(),
    registerPacket(key: string, packet: PreparedPacket): PacketResidencyTicket {
      assertOpen(); assertIdle(); validateKey(key);
      if (keys.has(key)) throw new Error(`Packet residency key is already registered: ${key}.`);
      const snapshot = snapshotPacket(packet), catalog = createPacketResidencyCatalogFromSnapshot(snapshot);
      const candidates = catalog.profiles.map(profile => ({ profile,
        id: identity(profile.kind, profile.id), source: packetSource(snapshot, profile) }));
      for (const candidate of candidates) {
        const previous = records.get(candidate.id);
        if (previous && (!sameProfile(previous.profile, candidate.profile)
          || !sameSource(previous.source, candidate.source))) {
          throw new Error(`Packet residency resource conflicts with an existing source: ${candidate.id}.`);
        }
      }
      const added: typeof candidates = [];
      try {
        for (const candidate of candidates) {
          if (records.has(candidate.id)) continue;
          runtime.register(candidate.profile);
          records.set(candidate.id, { profile: candidate.profile, source: candidate.source,
            sourceFor: catalog.sourceFor, refs: 0 });
          added.push(candidate);
        }
      } catch (error) {
        for (const candidate of added.reverse()) {
          runtime.remove(candidate.profile.kind, candidate.profile.id); records.delete(candidate.id);
        }
        throw error;
      }
      for (const candidate of candidates) records.get(candidate.id)!.refs += 1;
      const state: TicketState = { key, packet: snapshot, catalog,
        identities: Object.freeze(candidates.map(value => value.id)), active: true };
      const ticket = Object.freeze({ requests: catalog.requests }) as PacketResidencyTicket;
      tickets.set(ticket, state); keys.set(key, state); return ticket;
    },
    async load(ticket: PacketResidencyTicket,
      loadOptions: PacketResidencyLoadOptions): Promise<ResidentPacketProjection> {
      validateLoadOptions(loadOptions);
      const values = await loadSet({ frame: loadOptions.frame, entries: [{ ticket,
        ...(loadOptions.requests ? { requests: loadOptions.requests } : {}),
        ...(loadOptions.allowPartialLod ? { allowPartialLod: true } : {}) }],
        ...(loadOptions.signal ? { signal: loadOptions.signal } : {}) }, true);
      return values[0]!.projection;
    },
    loadSet,
    unregister(ticket: PacketResidencyTicket): void {
      assertOpen(); assertIdle(); const state = ticketState(ticket);
      state.active = false; keys.delete(state.key);
      for (const id of state.identities) records.get(id)!.refs -= 1;
      cleanupOrphans();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const state of keys.values()) state.active = false;
      keys.clear(); records.clear(); runtime.dispose();
    },
  });
  return domain;

  async function loadSet(options: PacketResidencySetLoadOptions,
    strictFailures = false): Promise<readonly PacketResidencySetProjection[]> {
    assertOpen(); validateSetOptions(options);
    const seen = new Set<PacketResidencyTicket>();
    const entries = options.entries.map(entry => {
      validateSetEntry(entry);
      if (seen.has(entry.ticket)) throw new TypeError("Packet residency set contains a duplicate ticket.");
      seen.add(entry.ticket);
      const state = ticketState(entry.ticket), requests = entry.requests ?? state.catalog.requests;
      const foreign = foreignPacketResidencyRequest(state.catalog, requests);
      if (foreign) throw new PacketResidencyLoadError("unbound-runtime",
        `Packet residency request does not belong to this ticket: ${foreign}.`);
      return { entry, state, requests };
    });
    inFlight += 1;
    try {
      let result: GpuRenderResidencyFrameResult;
      const mergedRequests = mergePacketResidencyRequests(entries.map(value => value.requests));
      try { result = await runtime.submit(options.frame, mergedRequests, options.signal); }
      catch (cause) { throw new PacketResidencyLoadError("frame-rejected",
        `Packet residency frame ${options.frame} failed before it was applied.`, { cause }); }
      assertApplied(result, options.frame, strictFailures ? undefined : mergedRequests);
      for (const { entry, state } of entries) if (entry.project !== false) {
        assertComplete(state.packet, state.catalog, runtime, entry.allowPartialLod === true);
      }
      const projections: PacketResidencySetProjection[] = [];
      try {
        for (const { entry, state } of entries) if (entry.project !== false) {
          projections.push(Object.freeze({ ticket: entry.ticket,
            projection: createResidentPacketProjection(state.packet,
              (kind, id) => runtime.acquire(kind, id),
              entry.allowPartialLod === true ? { allowPartialLod: true } : undefined) }));
        }
      } catch (error) {
        const failures = releasePacketResidencySet(projections);
        if (failures.length) throw new AggregateError([error, ...failures],
          "Packet residency set projection rollback failed.");
        throw error;
      }
      return Object.freeze(projections);
    } finally {
      inFlight -= 1;
      if (!disposed && inFlight === 0) cleanupOrphans();
    }
  }

  function assertOpen(): void {
    if (disposed) throw new Error("Packet residency domain is disposed.");
  }
  function assertIdle(): void {
    if (inFlight) throw new Error("Packet residency domain is loading.");
  }
  function ticketState(ticket: PacketResidencyTicket): TicketState {
    const state = ticket && typeof ticket === "object" ? tickets.get(ticket) : undefined;
    if (!state) throw new PacketResidencyLoadError("unbound-runtime", "Packet residency ticket is foreign.");
    if (!state.active) throw new PacketResidencyLoadError("unbound-runtime", "Packet residency ticket is stale.");
    return state;
  }
  function cleanupOrphans(): void {
    for (const [id, record] of records) {
      if (record.refs || runtime.get(record.profile.kind, record.profile.id)) continue;
      runtime.remove(record.profile.kind, record.profile.id); records.delete(id);
    }
  }
}
function assertApplied(result: GpuRenderResidencyFrameResult, frame: number,
  requests?: readonly GpuRenderResidencyRequest[]): void {
  if (result.status !== "applied" || result.frame !== frame || !result.execution) {
    throw new PacketResidencyLoadError("frame-rejected", `Packet residency frame ${frame} was not applied.`,
      result.error === undefined ? undefined : { cause: result.error });
  }
  if (result.execution.commit.failedUploads.length || result.execution.uploadFailures.length) {
    const required = new Set(requests?.filter(request => request.required === true)
      .map(request => identity(request.kind, request.id)));
    const requiredFailure = result.execution.commit.failedUploads.some(value =>
      required.has(identity(value.kind, value.id))) || result.execution.uploadFailures.some(value =>
      required.has(identity(value.resource.kind, value.resource.id)));
    if (!requests || requiredFailure) throw new PacketResidencyLoadError("partial-failure",
      `Packet residency frame ${frame} contained failed uploads.`);
  }
}

function assertComplete(packet: PreparedPacket, catalog: PacketResidencyCatalog,
  runtime: Pick<GpuRenderResidencyRuntime, "get">, allowPartialLod: boolean): void {
  const failure = incompletePacketResidency(packet, catalog, runtime, allowPartialLod);
  if (failure) throw new PacketResidencyLoadError("incomplete-residency",
    `Packet dependency is not completely resident: ${failure.kind}:${failure.id}.`);
}

function validateKey(key: string): void {
  if (typeof key !== "string" || !key.trim() || key.length > 256) throw new TypeError("Packet residency key is invalid.");
}

function validateSetOptions(options: PacketResidencySetLoadOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || !Number.isSafeInteger(options.frame) || options.frame < 0 || !Array.isArray(options.entries)
    || (options.signal !== undefined && !isAbortSignal(options.signal))) {
    throw new TypeError("Packet residency set load options are invalid.");
  }
}
function validateSetEntry(entry: PacketResidencySetEntry): void {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)
    || (entry.requests !== undefined && !Array.isArray(entry.requests))
    || (entry.project !== undefined && typeof entry.project !== "boolean")
    || (entry.allowPartialLod !== undefined && typeof entry.allowPartialLod !== "boolean")) {
    throw new TypeError("Packet residency set entry is invalid.");
  }
}
function validateLoadOptions(options: PacketResidencyLoadOptions): void {
  if (!options || typeof options !== "object" || !Number.isSafeInteger(options.frame) || options.frame < 0
    || (options.requests !== undefined && !Array.isArray(options.requests))
    || (options.allowPartialLod !== undefined && typeof options.allowPartialLod !== "boolean")
    || (options.signal !== undefined && !isAbortSignal(options.signal))) {
    throw new TypeError("Packet residency load options are invalid.");
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return !!value && typeof value === "object" && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function"
    && typeof (value as AbortSignal).removeEventListener === "function";
}
