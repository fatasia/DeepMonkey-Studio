import { createAdmittedTexture } from "./resourceAdmission.js";
import type { SharedShadowAtlasPlan } from "../shadows/sharedShadowAtlas.js";
import type { DeviceSession } from "./deviceSession.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";
import { gpuValidatedStage } from "./gpuValidatedStage.js";

const FORMAT = "depth32float" as const satisfies GPUTextureFormat;
const BYTES_PER_DEPTH_TEXEL = 4;
const DEVICE_EPOCH = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/;

export interface SharedShadowAtlasBudgetEvidence {
  readonly format: typeof FORMAT;
  readonly width: number;
  readonly height: number;
  readonly bytesPerDepthTexel: typeof BYTES_PER_DEPTH_TEXEL;
  readonly allocatedDepthTextureBytes: number;
  readonly deviceMaxTextureDimension2D: number;
  readonly tileSize: number;
  readonly guardTexels: number;
  readonly atlasViewCapacity: number;
  readonly pcfSampleCount: number;
  readonly maxShadowedLights: number;
  readonly maxShadowViews: number;
  readonly allocatedViewCount: number;
  readonly rejectedLightCount: number;
  readonly downgraded: boolean;
}

export interface SharedShadowAtlasGpuResource {
  readonly deviceEpoch: string;
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly plan: SharedShadowAtlasPlan;
  readonly budget: SharedShadowAtlasBudgetEvidence;
}

export interface SharedShadowAtlasResourceUpdate {
  readonly status: "allocated" | "reused";
  readonly resource: SharedShadowAtlasGpuResource;
}

interface PendingAtlas {
  readonly controller: AbortController;
  readonly resource: SharedShadowAtlasGpuResource;
  released: boolean;
}

/** Owns one device-local depth atlas and atomically publishes validated replacements. */
export class SharedShadowAtlasResources {
  readonly deviceEpoch: string;
  private active: SharedShadowAtlasGpuResource | undefined;
  private pending: PendingAtlas | undefined;
  private revision = 0;
  private disposed = false;

  constructor(private readonly session: DeviceSession, deviceEpoch: string) {
    if (typeof deviceEpoch !== "string" || !DEVICE_EPOCH.test(deviceEpoch)) {
      throw new TypeError("Shared shadow atlas device epoch is not canonical.");
    }
    this.deviceEpoch = deviceEpoch;
  }

  get current(): SharedShadowAtlasGpuResource | undefined { return this.active; }
  get budget(): SharedShadowAtlasBudgetEvidence | undefined { return this.active?.budget; }

  async setValidated(plan: SharedShadowAtlasPlan, deviceEpoch: string,
    signal?: AbortSignal): Promise<SharedShadowAtlasResourceUpdate> {
    if (signal?.aborted) throw cancellation(signal, "Shared shadow atlas update cancelled.");
    this.assertReady(deviceEpoch);
    validatePlan(plan, this.session.device.limits.maxTextureDimension2D);
    const revision = ++this.revision;
    this.cancelPending("Superseded shared shadow atlas update.");

    if (this.active && sameGpuConfiguration(this.active.plan, plan)) {
      this.active = snapshot(this.active.texture, this.active.view, plan, this.deviceEpoch,
        this.session.device.limits.maxTextureDimension2D);
      return Object.freeze({ status: "reused", resource: this.active });
    }

    const controller = new AbortController();
    const unlink = signal ? relayAbort(signal, controller) : () => {};
    let texture: GPUTexture | undefined;
    let staged: ReturnType<typeof gpuValidatedStage<SharedShadowAtlasGpuResource>>;
    try {
      staged = gpuValidatedStage(this.session.device, () => {
        texture = createAdmittedTexture(this.session, {
          label: "Deep shared local-light shadow atlas",
          size: { width: plan.atlasSize, height: plan.atlasSize, depthOrArrayLayers: 1 },
          mipLevelCount: 1,
          sampleCount: 1,
          dimension: "2d",
          format: FORMAT,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        const view = texture.createView({
          label: "Deep shared local-light shadow atlas depth view",
          format: FORMAT,
          dimension: "2d",
          aspect: "depth-only",
          baseMipLevel: 0,
          mipLevelCount: 1,
          baseArrayLayer: 0,
          arrayLayerCount: 1,
        });
        return snapshot(texture, view, plan, this.deviceEpoch,
          this.session.device.limits.maxTextureDimension2D);
      }, "Shared shadow atlas GPU preparation failed");
    } catch (error) {
      unlink();
      if (texture) failWithResourceCleanup(error, "Shared shadow atlas staging failed",
        [() => this.session.release(texture!)]);
      throw error;
    }

    const pending: PendingAtlas = { controller, resource: staged.value, released: false };
    this.pending = pending;
    try {
      await waitForValidation(staged.checked, controller.signal);
      if (this.pending !== pending || revision !== this.revision || controller.signal.aborted
        || this.session.state !== "ready") {
        throw cancellation(controller.signal, "Shared shadow atlas device session is stale.");
      }
      this.pending = undefined;
      const previous = this.active;
      this.active = pending.resource;
      if (previous) {
        runResourceCleanup("Superseded shared shadow atlas retirement failed.",
          [() => this.session.release(previous.texture)]);
      }
      return Object.freeze({ status: "allocated", resource: this.active });
    } catch (error) {
      if (this.pending === pending) this.pending = undefined;
      if (this.active === pending.resource) throw error;
      try { this.releasePending(pending); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Shared shadow atlas rollback failed.");
      }
      throw error;
    } finally { unlink(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revision++;
    const pending = this.pending, active = this.active;
    this.pending = undefined; this.active = undefined;
    pending?.controller.abort(abortError("Shared shadow atlas resources disposed."));
    const cleanup: Array<() => void> = [];
    if (pending) cleanup.push(() => this.releasePending(pending));
    if (active) cleanup.push(() => this.session.release(active.texture));
    runResourceCleanup("Shared shadow atlas disposal failed.", cleanup);
  }

  private assertReady(deviceEpoch: string): void {
    if (this.disposed) throw new Error("Shared shadow atlas resources are disposed.");
    if (deviceEpoch !== this.deviceEpoch) throw new Error("Shared shadow atlas device epoch mismatch.");
    if (this.session.state !== "ready") throw new Error("Shared shadow atlas device session is not ready.");
  }

  private cancelPending(message: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    pending.controller.abort(abortError(message));
    this.releasePending(pending);
  }

  private releasePending(pending: PendingAtlas): void {
    if (pending.released) return;
    pending.released = true;
    this.session.release(pending.resource.texture);
  }
}

function snapshot(texture: GPUTexture, view: GPUTextureView, plan: SharedShadowAtlasPlan,
  deviceEpoch: string, deviceMaxTextureDimension2D: number): SharedShadowAtlasGpuResource {
  const budget: SharedShadowAtlasBudgetEvidence = Object.freeze({
    format: FORMAT, width: plan.atlasSize, height: plan.atlasSize,
    bytesPerDepthTexel: BYTES_PER_DEPTH_TEXEL,
    allocatedDepthTextureBytes: plan.estimatedDepthTextureBytes,
    deviceMaxTextureDimension2D, tileSize: plan.tileSize, guardTexels: plan.guardTexels,
    atlasViewCapacity: (plan.atlasSize / plan.tileSize) ** 2, pcfSampleCount: plan.pcfSampleCount,
    maxShadowedLights: plan.maxShadowedLights,
    maxShadowViews: plan.maxShadowViews, allocatedViewCount: plan.allocatedViewCount,
    rejectedLightCount: plan.rejected.length, downgraded: plan.downgraded,
  });
  return Object.freeze({ deviceEpoch, texture, view, plan, budget });
}

function sameGpuConfiguration(left: SharedShadowAtlasPlan, right: SharedShadowAtlasPlan): boolean {
  // Format, usage, dimension, sample count and mip count are fixed; only size changes GPU allocation.
  return left.atlasSize === right.atlasSize;
}

function validatePlan(plan: SharedShadowAtlasPlan, deviceLimit: number): void {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new TypeError("Shared shadow atlas plan must be an object.");
  if (!Number.isSafeInteger(plan.atlasSize) || plan.atlasSize < 1
    || !Number.isInteger(Math.log2(plan.atlasSize)) || plan.atlasSize > deviceLimit) {
    throw new RangeError("Shared shadow atlas plan exceeds the device texture dimension.");
  }
  if (!Number.isSafeInteger(plan.tileSize) || plan.tileSize < 1 || plan.atlasSize % plan.tileSize !== 0) {
    throw new RangeError("Shared shadow atlas tile size is invalid.");
  }
  if (!Number.isSafeInteger(plan.guardTexels) || plan.guardTexels < 0 || plan.guardTexels * 2 >= plan.tileSize
    || !Number.isSafeInteger(plan.pcfSampleCount) || plan.pcfSampleCount < 1) {
    throw new RangeError("Shared shadow atlas sampling configuration is invalid.");
  }
  const expectedBytes = plan.atlasSize * plan.atlasSize * BYTES_PER_DEPTH_TEXEL;
  if (!Number.isSafeInteger(expectedBytes) || plan.estimatedDepthTextureBytes !== expectedBytes) {
    throw new RangeError("Shared shadow atlas depth budget does not match its allocation.");
  }
  if (!Array.isArray(plan.allocations) || !Array.isArray(plan.rejected)) {
    throw new RangeError("Shared shadow atlas plan budget evidence is inconsistent.");
  }
  const capacity = (plan.atlasSize / plan.tileSize) ** 2;
  if (plan.allocations.some(allocation => !allocation || !Array.isArray(allocation.tiles))) {
    throw new RangeError("Shared shadow atlas plan budget evidence is inconsistent.");
  }
  const viewCount = plan.allocations.reduce((total, allocation) => total + allocation.tiles.length, 0);
  if (!Number.isSafeInteger(plan.maxShadowViews) || plan.maxShadowViews < 0 || plan.maxShadowViews > capacity
    || !Number.isSafeInteger(plan.maxShadowedLights) || plan.maxShadowedLights < 0
    || !Number.isSafeInteger(plan.allocatedViewCount) || plan.allocatedViewCount < 0
    || viewCount !== plan.allocatedViewCount || plan.allocatedViewCount > plan.maxShadowViews
    || plan.allocations.length > plan.maxShadowedLights) {
    throw new RangeError("Shared shadow atlas plan budget evidence is inconsistent.");
  }
}

function relayAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = (): void => target.abort(source.reason);
  if (source.aborted) abort(); else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

async function waitForValidation(checked: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) { void checked.catch(() => {}); throw cancellation(signal, "Shared shadow atlas update cancelled."); }
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort(cancellation(signal, "Shared shadow atlas update cancelled."));
  signal.addEventListener("abort", onAbort, { once: true });
  try { await Promise.race([checked, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

function abortError(message: string): Error { const error = new Error(message); error.name = "AbortError"; return error; }
function cancellation(signal: AbortSignal, message: string): Error {
  return signal.reason instanceof Error ? signal.reason : abortError(message);
}
