import type { RenderPacket } from "../renderPacket.js";
import type { RenderView } from "../webgpu/pbrRendererTypes.js";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import type { PbrResidencyFrameTarget } from "../webgpu/pbrResidencyStream.js";
import { createSceneChunkResidency, type SceneChunkResidency } from "../webgpu/sceneChunkResidency.js";
import { stageSceneChunkFrame } from "../webgpu/sceneChunkFrameStage.js";
import { failWithResourceCleanup } from "../webgpu/resourceCleanup.js";
import { AuthorChunkCatalog } from "./authorChunkCatalog.js";

export interface AuthorChunkStreamRuntime extends PbrResidencyFrameTarget { readonly session: DeviceSession }
export interface AuthorChunkStreamDiagnostics {
  readonly path: "full-packet" | "scene-chunks";
  readonly reason: string;
  readonly chunkCount: number;
  readonly visibleChunks: number;
  readonly prefetchChunks: number;
  readonly derivedCpuBytes: number;
  readonly residentGpuBytes: number;
}
interface CatalogOwner { readonly catalog: AuthorChunkCatalog; readonly residency: SceneChunkResidency; replaceRequired: boolean }
const GPU_BYTES = 128 * 1024 * 1024;

/** One derived catalog per runtime; staged replacements never retire the last drawable catalog early. */
export class AuthorChunkStream {
  private active: CatalogOwner | undefined;
  private frame = 0;
  private closed = false;
  private pending: AbortController | undefined;
  private pendingWork: Promise<boolean> | undefined;
  private generation = 0;
  private state: AuthorChunkStreamDiagnostics = { path: "full-packet", reason: "not-started", chunkCount: 0,
    visibleChunks: 0, prefetchChunks: 0, derivedCpuBytes: 0, residentGpuBytes: 0 };
  constructor(private readonly runtime: AuthorChunkStreamRuntime, private readonly meshlets = false) {}
  get diagnostics(): AuthorChunkStreamDiagnostics { return this.state; }
  get hasCatalog(): boolean { return this.active !== undefined; }
  sync(packet: RenderPacket, full: boolean, view: RenderView, signal?: AbortSignal): Promise<boolean> {
    if (this.closed) return Promise.reject(new Error("Author chunk stream is disposed."));
    const generation = ++this.generation, previous = this.pendingWork;
    this.pending?.abort();
    const controller = new AbortController(); this.pending = controller;
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const work = (async () => {
      if (previous) await previous.catch(() => undefined);
      controller.signal.throwIfAborted();
      if (generation !== this.generation || this.closed) throw new Error("Author chunk sync superseded.");
      return this.execute(packet, full, view, controller.signal);
    })().finally(() => { signal?.removeEventListener("abort", abort); if (this.pending === controller) this.pending = undefined; });
    this.pendingWork = work; return work;
  }
  fullPacketPublished(reason: string): void {
    const old = this.active; this.active = undefined; old?.residency.dispose();
    this.state = { path: "full-packet", reason, chunkCount: 0, visibleChunks: 0, prefetchChunks: 0, derivedCpuBytes: 0, residentGpuBytes: 0 };
  }
  dispose(): void {
    if (this.closed) return; this.closed = true; this.generation++; this.pending?.abort();
    this.fullPacketPublished("disposed");
  }
  private async execute(packet: RenderPacket, full: boolean, view: RenderView, signal: AbortSignal): Promise<boolean> {
    if (packet.deformation !== undefined || packet.instances.some(instance => instance.pose !== undefined)) return false;
    const old = this.active, prior = old?.catalog.batchUpdates;
    let candidate: CatalogOwner | undefined;
    let staged = false;
    try {
      if (!old || old.replaceRequired || full || !old.catalog.update(packet)) candidate = this.create(packet);
      const owner = candidate ?? old!;
      const demands = owner.catalog.demand(view);
      const frame = await owner.residency.update({ frame: ++this.frame, chunks: demands, signal });
      await stageSceneChunkFrame(this.runtime, frame, signal, owner.catalog.batchUpdates);
      staged = true;
      signal.throwIfAborted();
      if (candidate) { this.active = candidate; old?.residency.dispose(); }
      this.state = Object.freeze({ path: "scene-chunks", reason: "static-author-batches;casters-required",
        chunkCount: owner.catalog.chunks.length, visibleChunks: demands.filter(value => value.mode === "visible").length,
        prefetchChunks: demands.filter(value => value.mode === "prefetch").length,
        derivedCpuBytes: owner.catalog.cpuBytes, residentGpuBytes: owner.residency.telemetrySnapshot().residentBytes });
      return true;
    } catch (error) {
      failWithResourceCleanup(error, "Author chunk candidate failed.", [
        () => { if (staged) this.runtime.cancelResidentPacketStage(); },
        () => { if (candidate && candidate !== this.active) candidate.residency.dispose(); },
        () => { if (old && prior) {
        old.catalog.restoreBatchUpdates(prior);
        // A rejected draw may still leave eviction retirements leased by the last good frame.
        // Retry in a fresh domain; never release that visible frame just to unblock its planner.
        old.replaceRequired = true;
        } },
      ]);
    }
  }
  private create(packet: RenderPacket): CatalogOwner {
    const catalog = new AuthorChunkCatalog(packet);
    // Two catalog generations may overlap while the renderer owns the previous frame's leases.
    const residency = createSceneChunkResidency(this.runtime.session,
      { maxResidentBytes: GPU_BYTES, maxUploadBytesPerFrame: GPU_BYTES, retainFrames: 0 }, { meshlets: this.meshlets });
    try { for (const chunk of catalog.chunks) residency.registerChunk(chunk.key, chunk.packet); }
    catch (error) { residency.dispose(); throw error; }
    return { catalog, residency, replaceRequired: false };
  }
}
