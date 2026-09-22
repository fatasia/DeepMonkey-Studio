import { bakeRenderPacketForResidency, type DeepBakedResidencyPacket } from "../assetBakeResidency.js";
import { materializeRuntimeRenderPacket } from "../runtimePackage/renderPacket.js";
import type { DeepRuntimePackage } from "../runtimePackage/types.js";
import { validateRuntimeSceneCamera, type RuntimeSceneCamera } from "../runtimePackage/camera.js";
import { BUILTIN_RUNTIME_IBL_ID } from "../runtimePackage/validation.js";
import type {
  RuntimePackagePrewarmAdapter,
  RuntimePackagePrewarmCandidate,
  RuntimePackagePrewarmItem,
  RuntimePackagePrewarmPlan,
  RuntimePackageResourcePrewarmItem,
} from "../runtimePackage/prewarmTypes.js";
import type { ResidencyBudgets } from "../streaming/index.js";
import type { DeviceSession } from "./deviceSession.js";
import { createPacketResidencyDomain, type PacketResidencyDomain, type PacketResidencyTicket } from "./packetResidencyDomain.js";
import { createPacketResidencyRequestPlanner } from "./packetResidencyRequestPlanner.js";
import type { PacketResidencyDemand } from "./packetResidencyRequestPlanner.js";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";
import type { ShaderPackageExecutor } from "./shaderPackageExecutor.js";

export interface RuntimePackageWebGpuPrewarmOptions {
  readonly session: DeviceSession;
  readonly budgets: ResidencyBudgets;
  /** Each render upload needs a monotonic frame for its own staging residency domain. */
  readonly nextFrame: () => number;
  /** Receives the fully uploaded draw-ready packet atomically before the prior publication is released. */
  readonly commit: (plan: RuntimePackagePrewarmPlan, publication: RuntimePackageWebGpuRenderPublication) => void;
  readonly prepareShaderPipeline?: (item: Extract<RuntimePackagePrewarmItem, { readonly type: "shader-pipeline" }>,
    packageValue: DeepRuntimePackage, signal: AbortSignal) => Promise<unknown>;
  /** Production default: consumes shader-package payloads through the device-local content-addressed PSO cache. */
  readonly shaderExecutor?: ShaderPackageExecutor;
  readonly prepareDeep2d?: (item: RuntimePackageResourcePrewarmItem,
    packageValue: DeepRuntimePackage, signal: AbortSignal) => Promise<unknown>;
  readonly releaseExternal?: (item: RuntimePackagePrewarmItem, prepared: unknown) => void;
}

export interface RuntimePackageWebGpuRenderPublication {
  readonly camera: RuntimeSceneCamera | null;
  readonly item: RuntimePackageResourcePrewarmItem;
  readonly baked: DeepBakedResidencyPacket;
  readonly projection: ResidentPacketProjection;
  /** Product visibility hook: swaps drawable projections atomically and releases omitted GPU resources. */
  readonly residency: RuntimePackageWebGpuResidency;
}

export interface RuntimePackageWebGpuResidency {
  readonly projection: ResidentPacketProjection;
  readonly residentBytes: number;
  update(input: Readonly<{ frame: number; demands: readonly PacketResidencyDemand[];
    textureMipLevels?: ReadonlyMap<string, number>; signal?: AbortSignal }>): Promise<ResidentPacketProjection>;
}

type Loaded = RenderLoaded | BuiltinLoaded | ExternalLoaded | CameraLoaded;
interface CameraLoaded { readonly type: "camera"; readonly camera: RuntimeSceneCamera }
interface RenderLoaded {
  readonly type: "render";
  readonly item: RuntimePackageResourcePrewarmItem;
  readonly baked: DeepBakedResidencyPacket;
  readonly domain: PacketResidencyDomain;
}
interface BuiltinLoaded { readonly type: "builtin-ibl"; readonly item: RuntimePackageResourcePrewarmItem }
interface ExternalLoaded { readonly type: "external"; readonly item: RuntimePackagePrewarmItem; readonly packageValue: DeepRuntimePackage }
type Prepared = RenderPrepared | BuiltinPrepared | ExternalPrepared | CameraLoaded;
interface RenderPrepared { readonly type: "render"; readonly residency: RuntimePackageResidencyOwner }
interface BuiltinPrepared { readonly type: "builtin-ibl" }
interface ExternalPrepared { readonly type: "external"; readonly value: unknown }

/**
 * Browser consumer for RuntimePackagePrewarmExecutor. Each candidate stages in
 * an isolated residency domain, so a new revision can upload while the active
 * projection retains the previous resource identities for an atomic swap.
 */
export function createRuntimePackageWebGpuPrewarmAdapter(options: RuntimePackageWebGpuPrewarmOptions):
RuntimePackagePrewarmAdapter<Loaded, Prepared> {
  validateOptions(options);
  return Object.freeze({
    async load(item: RuntimePackagePrewarmItem, packageValue: DeepRuntimePackage,
      _signal: AbortSignal): Promise<Loaded> {
      if (item.type === "shader-pipeline") return { type: "external", item, packageValue };
      if (item.resourceKind === "scene-camera") return { type: "camera", camera: validateRuntimeSceneCamera(packageValue.payloads[item.resourceId]) };
      if (item.resourceKind === "render-packet") {
        const payload = packageValue.payloads[item.resourceId];
        const packet = materializeRuntimeRenderPacket(payload, `$.payloads.${item.resourceId}`);
        const baked = bakeRenderPacketForResidency(packet, bakeOptions(item));
        assertBakeEvidence(item, baked);
        return { type: "render", item, baked, domain: createPacketResidencyDomain(options.session, options.budgets) };
      }
      if (item.resourceKind === "ibl-environment" && item.resourceId === BUILTIN_RUNTIME_IBL_ID) {
        return { type: "builtin-ibl", item };
      }
      return { type: "external", item, packageValue };
    },
    async prepare(item: RuntimePackagePrewarmItem, loaded: Loaded, signal: AbortSignal): Promise<Prepared> {
      if (signal.aborted) throw aborted(signal);
      if (loaded.type === "render") return prepareRender(loaded, options.nextFrame(), signal);
      if (loaded.type === "builtin-ibl") return { type: "builtin-ibl" };
      if (loaded.type === "camera") return loaded;
      if (item.type === "shader-pipeline") {
        const custom = options.prepareShaderPipeline;
        const value = custom
          ? await custom(item, loaded.packageValue, signal)
          : options.shaderExecutor
            ? await options.shaderExecutor.prepare(loaded.packageValue.payloads[item.resourceId], [item.passId], signal)
            : undefined;
        if (!value) throw new Error("Runtime package shader prewarm requires a ShaderPackageExecutor or pipeline handler.");
        return { type: "external", value };
      }
      if (item.resourceKind === "deep2d-runtime") {
        if (!options.prepareDeep2d) throw new Error("Runtime package Deep2D prewarm requires a Browser resource handler.");
        return { type: "external", value: await options.prepareDeep2d(item, loaded.packageValue, signal) };
      }
      throw new Error(`Unsupported Browser runtime prewarm resource: ${item.resourceKind}.`);
    },
    commit(plan: RuntimePackagePrewarmPlan,
      candidates: readonly RuntimePackagePrewarmCandidate<Loaded, Prepared>[]): void {
      const render = candidates.find((candidate): candidate is RuntimePackagePrewarmCandidate<RenderLoaded, RenderPrepared>
        & { readonly item: RuntimePackageResourcePrewarmItem } => candidate.item.type === "resource"
          && candidate.item.resourceKind === "render-packet"
          && candidate.loaded.type === "render" && candidate.prepared.type === "render");
      if (!render) throw new Error("Runtime package Browser prewarm did not produce a render packet publication.");
      const camera = candidates.find(candidate => candidate.prepared.type === "camera")?.prepared;
      options.commit(plan, Object.freeze({ item: render.item, baked: render.loaded.baked,
        projection: render.prepared.residency.projection, residency: render.prepared.residency.publicApi,
        camera: camera?.type === "camera" ? camera.camera : null }));
    },
    release(item: RuntimePackagePrewarmItem, loaded: Loaded, prepared: Prepared | undefined): void {
      if (loaded.type === "render") {
        releaseRender(loaded, prepared?.type === "render" ? prepared : undefined); return;
      }
      if (prepared?.type === "external") options.releaseExternal?.(item, prepared.value);
    },
  });
}

async function prepareRender(loaded: RenderLoaded, frame: number, signal: AbortSignal): Promise<RenderPrepared> {
  if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError("Runtime package prewarm frame must be a non-negative integer.");
  const ticket = loaded.domain.registerPacket(`runtime-prewarm:${loaded.item.cacheKey}`, loaded.baked.packet);
  try {
    // Initial publication keeps only the mandatory drawable fallback resident.
    // Omitted fine LOD buffers are therefore genuinely absent from GPU memory;
    // later domain frames can upload them and evict them again under the same budget.
    const requests = createPacketResidencyRequestPlanner(loaded.baked.packet).plan([]);
    const projection = await loaded.domain.load(ticket, { frame, signal, requests, allowPartialLod: true });
    return Object.freeze({ type: "render", residency: new RuntimePackageResidencyOwner(loaded.domain,
      ticket, loaded.baked.packet, projection, frame) });
  } catch (error) {
    loaded.domain.unregister(ticket); throw error;
  }
}

function bakeOptions(item: RuntimePackageResourcePrewarmItem) {
  const bake = item.bake;
  if (!bake) throw new Error("Runtime package render prewarm item is missing bake evidence.");
  return { quality: bake.quality, recipeVersion: bake.recipeVersion,
    ...(bake.boundsHlod ? { boundsHlod: bake.boundsHlod.options } : {}) } as const;
}

function assertBakeEvidence(item: RuntimePackageResourcePrewarmItem, baked: DeepBakedResidencyPacket): void {
  const expected = item.bake;
  if (!expected || expected.cacheKey !== baked.cacheKey || expected.sourceHash !== baked.sourceHash) {
    throw new Error("Runtime package render bake differs from its prewarm plan.");
  }
}

function releaseRender(loaded: RenderLoaded, prepared: RenderPrepared | undefined): void {
  const failures: unknown[] = [];
  if (prepared) {
    attempt(() => prepared.residency.dispose(), failures);
  }
  attempt(() => loaded.domain.dispose(), failures);
  if (failures.length) throw new AggregateError(failures, "Runtime package Browser render prewarm release failed.");
}

class RuntimePackageResidencyOwner {
  private planner;
  private current: ResidentPacketProjection;
  private latestFrame: number;
  private closed = false;
  private pending = false;
  readonly publicApi: RuntimePackageWebGpuResidency;
  constructor(private readonly domain: PacketResidencyDomain, private readonly ticket: PacketResidencyTicket,
    packet: DeepBakedResidencyPacket["packet"], projection: ResidentPacketProjection, frame: number) {
    this.planner = createPacketResidencyRequestPlanner(packet); this.current = projection; this.latestFrame = frame;
    const owner = this;
    this.publicApi = Object.freeze({
      get projection() { return owner.current; },
      get residentBytes() { return owner.domain.residentBytes; },
      update: (input: Parameters<RuntimePackageWebGpuResidency["update"]>[0]) => owner.update(input),
    });
  }
  get projection(): ResidentPacketProjection { return this.current; }
  async update(input: Parameters<RuntimePackageWebGpuResidency["update"]>[0]): Promise<ResidentPacketProjection> {
    if (this.closed) throw new Error("Runtime package residency is disposed.");
    if (this.pending) throw new Error("Runtime package residency update is already running.");
    if (!input || !Number.isSafeInteger(input.frame) || input.frame <= this.latestFrame || !Array.isArray(input.demands)) {
      throw new TypeError("Runtime package residency update is invalid or stale.");
    }
    this.pending = true;
    try {
      const requests = this.planner.plan(input.demands,
        input.textureMipLevels ? { textureMipLevels: input.textureMipLevels } : undefined);
      const next = await this.domain.load(this.ticket, { frame: input.frame, requests, allowPartialLod: true,
        ...(input.signal ? { signal: input.signal } : {}) });
      const previous = this.current;
      this.current = next; this.latestFrame = input.frame;
      previous.release();
      return next;
    } finally { this.pending = false; }
  }
  dispose(): void {
    if (this.closed) return;
    if (this.pending) throw new Error("Runtime package residency cannot be disposed during an update.");
    this.closed = true; this.current.release(); this.domain.unregister(this.ticket);
  }
}

function attempt(action: () => void, failures: unknown[]): void {
  try { action(); } catch (error) { failures.push(error); }
}

function validateOptions(options: RuntimePackageWebGpuPrewarmOptions): void {
  if (!options || typeof options !== "object" || typeof options.nextFrame !== "function" || typeof options.commit !== "function") {
    throw new TypeError("Runtime package Browser prewarm options are invalid.");
  }
  if (options.shaderExecutor && options.prepareShaderPipeline) {
    throw new TypeError("Runtime package Browser prewarm accepts one shader pipeline executor path.");
  }
}

function aborted(signal: AbortSignal): Error {
  const error = new Error(signal.reason instanceof Error ? signal.reason.message : "Runtime package prewarm was aborted.");
  error.name = "AbortError"; return error;
}
