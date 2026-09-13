import {
  GpuResidencyExecutor,
  GpuResidentOwner,
  ResidencyStreamScheduler,
  ResourceResidencyController,
  type GpuResidencyExecutionResult,
  type GpuResidencyExecutorOptions,
  type GpuResidencyUploader,
  type GpuResidencyUploadRequest,
  type GpuResidentLease,
  type GpuResidentResource,
  type ResidentResourceState,
  type ResidencyBudgets,
  type ResidencyCommitResult,
  type ResidencyRequest,
  type ResidencyStreamFrameResult,
  type StreamedResourceKind,
  type StreamedResourceLevel,
  type StreamedResourceProfile,
} from "../streaming/index.js";
import type { DeviceSession } from "./deviceSession.js";
import {
  GpuRenderResidencyUploader,
  type GpuRenderResidencyHandle,
  type GpuRenderResidencySourceProvider,
} from "./gpuRenderResidencyUploader.js";
import { identityKey, publicIdentity, sameIds, validSourceId } from "./gpuRenderResidencyIdentity.js";
import { createGpuRenderResidencyAppliedFrameTelemetry, createGpuRenderResidencyTelemetrySnapshot,
  type GpuRenderResidencyAppliedFrameTelemetry,
  type GpuRenderResidencyTelemetrySnapshot } from "./gpuRenderResidencyTelemetry.js";

export interface GpuRenderResidencyRequest extends ResidencyRequest {
  readonly kind: StreamedResourceKind;
}

export interface GpuRenderResidencyLevel extends StreamedResourceLevel {
  /** Physical payload identity for this LOD/mip variant; defaults to the profile id. */
  readonly sourceId?: string;
}

export interface GpuRenderResidencyProfile extends Omit<StreamedResourceProfile, "levels"> {
  readonly levels: readonly GpuRenderResidencyLevel[];
}

export interface GpuRenderResidencyIdentity {
  readonly id: string;
  readonly kind: StreamedResourceKind;
}

export interface GpuRenderResidencyCommitResult extends Omit<ResidencyCommitResult,
  "appliedUploads" | "failedUploads" | "evicted"> {
  readonly appliedUploads: readonly GpuRenderResidencyIdentity[];
  readonly failedUploads: readonly GpuRenderResidencyIdentity[];
  readonly evicted: readonly GpuRenderResidencyIdentity[];
}

export interface GpuRenderResidencyExecutionResult extends Omit<GpuResidencyExecutionResult,
  "commit" | "uploadFailures" | "cancellationFailures"> {
  readonly commit: GpuRenderResidencyCommitResult;
  readonly uploadFailures: readonly Readonly<{ resource: GpuRenderResidencyIdentity; reason: unknown }>[];
  readonly cancellationFailures: readonly Readonly<{
    resource: GpuRenderResidencyIdentity; reason: unknown;
  }>[];
}

export interface GpuRenderResidencyFrameResult extends Omit<ResidencyStreamFrameResult, "execution"> {
  readonly execution?: GpuRenderResidencyExecutionResult;
}

type OwnedRenderHandle = GpuResidentOwner<GpuRenderResidencyHandle>;
interface SourceProfile { readonly revision: number; readonly ids: readonly string[] }

/** One collision-safe budget and latest-frame scheduler for streamed draw resources. */
export class GpuRenderResidencyRuntime {
  private readonly controller: ResourceResidencyController;
  private readonly executor: GpuResidencyExecutor<OwnedRenderHandle>;
  private readonly scheduler: ResidencyStreamScheduler<OwnedRenderHandle>;
  private readonly ownership: RenderLeaseLedger;
  private readonly identities = new Map<string, GpuRenderResidencyIdentity>();
  private readonly keys = new Map<string, string>();
  private readonly sources = new Map<string, SourceProfile>();
  private lastAppliedFrame: GpuRenderResidencyAppliedFrameTelemetry | undefined;
  private keySequence = 0;

  constructor(session: DeviceSession, budgets: ResidencyBudgets,
    sourceFor: GpuRenderResidencySourceProvider, options: GpuResidencyExecutorOptions = {}) {
    this.controller = new ResourceResidencyController(budgets);
    const uploader = new GpuRenderResidencyUploader(session, sourceFor,
      request => this.sourceId(request));
    this.ownership = new RenderLeaseLedger(uploader);
    this.executor = new GpuResidencyExecutor(this.controller, this.ownership.uploader, {
      ...(options.maxConcurrentUploads === undefined ? {} : { maxConcurrentUploads: options.maxConcurrentUploads }),
      deviceLost: options.deviceLost ?? session.device.lost,
    });
    this.scheduler = new ResidencyStreamScheduler(this.controller, this.executor);
  }

  get disposed(): boolean { return this.executor.disposed; }
  get residentBytes(): number { return this.controller.residentBytes; }
  get retiredBytes(): number { return this.ownership.retiredBytes; }
  get residentCount(): number { return this.executor.size; }
  get resourceCount(): number { return this.controller.resourceCount; }

  register(profile: GpuRenderResidencyProfile): void {
    const identity = publicIdentity(profile.kind, profile.id), publicKey = identityKey(identity);
    const key = this.keys.get(publicKey) ?? `render-resource-${++this.keySequence}`;
    const ids = Object.freeze(profile.levels.map(level => validSourceId(level.sourceId ?? profile.id)));
    const previous = this.sources.get(key);
    if (previous?.revision === profile.revision && !sameIds(previous.ids, ids)) {
      throw new Error(`Render residency source mapping changed without a revision: ${profile.id}.`);
    }
    this.controller.register(Object.freeze({ ...profile, id: key,
      levels: Object.freeze(profile.levels.map(({ level, byteLength }) => Object.freeze({ level, byteLength }))) }));
    this.keys.set(publicKey, key); this.identities.set(key, identity);
    this.sources.set(key, Object.freeze({ revision: profile.revision, ids }));
  }

  remove(kind: StreamedResourceKind, id: string): void {
    const identity = publicIdentity(kind, id), publicKey = identityKey(identity), key = this.keys.get(publicKey);
    if (!key) return;
    this.controller.remove(key); this.identities.delete(key); this.sources.delete(key); this.keys.delete(publicKey);
  }

  get(kind: StreamedResourceKind, id: string): ResidentResourceState | undefined {
    const key = this.keys.get(identityKey(publicIdentity(kind, id)));
    const resource = key ? this.executor.get(key) : undefined;
    return resource && publicResident(resource, this.identity(resource.id));
  }

  snapshot(): readonly ResidentResourceState[] {
    return Object.freeze(this.executor.snapshot().map(resource => publicResident(resource, this.identity(resource.id)))
      .sort((left, right) => left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind)));
  }

  telemetrySnapshot(): GpuRenderResidencyTelemetrySnapshot {
    return createGpuRenderResidencyTelemetrySnapshot({
      disposed: this.disposed,
      residencyRevision: this.controller.revision,
      registeredResourceCount: this.resourceCount,
      retiredBytes: this.retiredBytes,
      resources: this.snapshot(),
      budgets: this.controller.budgets,
      ...(this.lastAppliedFrame ? { lastAppliedFrame: this.lastAppliedFrame } : {}),
    });
  }

  acquire(kind: StreamedResourceKind, id: string): GpuResidentLease<GpuRenderResidencyHandle> | undefined {
    const key = this.keys.get(identityKey(publicIdentity(kind, id)));
    return key ? this.executor.get(key)?.handle.acquire() : undefined;
  }

  async submit(frame: number,
    requests: readonly GpuRenderResidencyRequest[],
    signal?: AbortSignal): Promise<GpuRenderResidencyFrameResult> {
    if (this.executor.disposed) throw new Error("Render residency runtime is disposed.");
    if (this.ownership.retiredBytes > 0) {
      throw new Error("Retired GPU resources must be released before another residency frame.");
    }
    const mappedRequests = requests.map(request => Object.freeze({
      ...request, id: this.registeredKey(request.kind, request.id),
    }));
    const result = this.publicResult(await this.scheduler.submit(frame, mappedRequests, signal));
    if (result.status === "applied" && result.execution
      && (!this.lastAppliedFrame || result.frame >= this.lastAppliedFrame.frame)) {
      this.captureAppliedFrame(result, mappedRequests);
    }
    return result;
  }

  dispose(): void { this.scheduler.dispose(); }

  private publicResult(result: ResidencyStreamFrameResult): GpuRenderResidencyFrameResult {
    if (!result.execution) return Object.freeze({ generation: result.generation, frame: result.frame,
      status: result.status, ...(result.error === undefined ? {} : { error: result.error }) });
    const execution = result.execution;
    const mapIds = (ids: readonly string[]): readonly GpuRenderResidencyIdentity[] =>
      Object.freeze(ids.map(id => this.identity(id)));
    const commit = Object.freeze({ ...execution.commit,
      appliedUploads: mapIds(execution.commit.appliedUploads),
      failedUploads: mapIds(execution.commit.failedUploads),
      evicted: mapIds(execution.commit.evicted),
    });
    return Object.freeze({ ...result, execution: Object.freeze({ ...execution, commit,
      uploadFailures: Object.freeze(execution.uploadFailures.map(failure => Object.freeze({
        resource: this.identity(failure.id), reason: failure.reason,
      }))),
      cancellationFailures: Object.freeze(execution.cancellationFailures.map(failure => Object.freeze({
        resource: this.identity(failure.id), reason: failure.reason,
      }))),
    }) });
  }

  private identity(key: string): GpuRenderResidencyIdentity {
    const identity = this.identities.get(key);
    if (!identity) throw new Error(`Unknown render residency resource: ${key}.`);
    return identity;
  }

  private registeredKey(kind: StreamedResourceKind, id: string): string {
    const identity = publicIdentity(kind, id), key = this.keys.get(identityKey(identity));
    if (!key) throw new Error(`Unknown render residency resource: ${kind}:${id}.`);
    return key;
  }

  private sourceId(request: GpuResidencyUploadRequest): string {
    const source = this.sources.get(request.id), id = source?.ids[request.level];
    if (!source || source.revision !== request.revision || !id) {
      throw new Error(`Unknown render residency source variant: ${request.id} level ${request.level}.`);
    }
    return id;
  }

  private captureAppliedFrame(result: GpuRenderResidencyFrameResult,
    requests: readonly ResidencyRequest[]): void {
    const execution = result.execution!;
    let uploadedBytes = 0, qualityReducedResourceCount = 0;
    for (const identity of execution.commit.appliedUploads) {
      const key = this.keys.get(identityKey(identity));
      uploadedBytes += key ? this.executor.get(key)?.byteLength ?? 0 : 0;
    }
    for (const request of requests) if (
      (this.executor.get(request.id)?.level ?? request.desiredLevel) > request.desiredLevel
    ) qualityReducedResourceCount += 1;
    this.lastAppliedFrame = createGpuRenderResidencyAppliedFrameTelemetry({
      frame: result.frame, generation: result.generation,
      residencyRevision: execution.commit.revision,
      requestedResourceCount: requests.length,
      uploadedResourceCount: execution.commit.appliedUploads.length,
      uploadedBytes, evictedResourceCount: execution.commit.evicted.length,
      failedUploadCount: execution.commit.failedUploads.length,
      qualityReducedResourceCount, maxUploadBytesPerFrame: this.controller.budgets.maxUploadBytesPerFrame,
    });
  }
}

class RenderLeaseLedger {
  private retainedBytesValue = 0;
  private readonly retained = new Set<OwnedRenderHandle>();
  private readonly sizes = new WeakMap<OwnedRenderHandle, number>();
  readonly uploader: GpuResidencyUploader<OwnedRenderHandle>;

  constructor(private readonly source: GpuRenderResidencyUploader) {
    this.uploader = Object.freeze({
      upload: (request: GpuResidencyUploadRequest) => this.upload(request),
      release: (owner: OwnedRenderHandle) => this.retire(owner),
    });
  }

  get retiredBytes(): number { return this.retainedBytesValue; }

  private async upload(request: GpuResidencyUploadRequest) {
    if (this.retainedBytesValue > 0) {
      throw new Error("GPU upload is blocked by leased resources retired before upload.");
    }
    const result = await this.source.upload(request);
    let owner!: OwnedRenderHandle;
    owner = new GpuResidentOwner(result.handle, handle => {
      try { this.source.release(handle); }
      finally { this.finish(owner); }
    });
    this.sizes.set(owner, result.byteLength);
    return Object.freeze({ ...result, handle: owner });
  }

  private retire(owner: OwnedRenderHandle): void {
    const bytes = this.sizes.get(owner);
    if (bytes === undefined) throw new Error("GPU render residency owner is unknown.");
    if (!owner.retired && owner.activeLeaseCount > 0 && !this.retained.has(owner)) {
      this.retained.add(owner); this.retainedBytesValue += bytes;
    }
    owner.retire();
  }

  private finish(owner: OwnedRenderHandle): void {
    const bytes = this.sizes.get(owner) ?? 0;
    if (this.retained.delete(owner)) this.retainedBytesValue -= bytes;
    this.sizes.delete(owner);
  }
}

function publicResident(resource: GpuResidentResource<OwnedRenderHandle>,
  identity: GpuRenderResidencyIdentity): ResidentResourceState {
  return Object.freeze({ id: identity.id, kind: identity.kind, revision: resource.revision,
    level: resource.level, byteLength: resource.byteLength, lastUsedFrame: resource.lastUsedFrame });
}
