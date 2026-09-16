/// <reference types="@webgpu/types" />
import type { PreparedBatch } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import { packFrustum } from "./gpuFrustumPacking.js";
import { PacketLodSceneCache, type PacketGeometryBoundsMap,
  type PacketLodBatchMapping as BatchMapping, type PacketLodSceneInputs } from "./packetLodSceneCache.js";
import { GpuLodSelector } from "./gpuLodSelector.js";
import { GPU_LOD_MAX_LEVELS, type GpuLodResult } from "./gpuLodTypes.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import type { PacketLodDraw, PacketLodFrameStats, PacketLodView } from "./packetLodTypes.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";
import { PACKET_LOD_BUDGET_RECORD_STRIDE, PACKET_LOD_BUDGET_UNIFORM_SIZE, PACKET_LOD_BUDGET_WGSL,
  PACKET_LOD_DRAW_UNIFORM_SIZE, PACKET_LOD_INDIRECT_STRIDE, PACKET_LOD_INDIRECT_WGSL,
  PACKET_LOD_WORKGROUP_SIZE } from "./packetLodWgsl.js";

const INSTANCE_STRIDE = 144, PREVIOUS_STRIDE = 48, MAX_U32 = 0xffff_ffff;
type LodProfile = Exclude<NonNullable<PreparedBatch["lod"]>, { strategy: "author-selected" }>;
interface SceneBuffers {
  readonly objects: GPUBuffer; readonly levels: GPUBuffer; readonly capacity: number;
  readonly budgetRecords: GPUBuffer; readonly budgetPrefix: GPUBuffer; readonly budgetBlocks: GPUBuffer;
  readonly budgetUniform: GPUBuffer; budgetGroup: GPUBindGroup; budgetBindings: readonly GPUBuffer[];
  readonly count: number; readonly revision: number; readonly topology: string;
  readonly mappings: readonly BatchMapping[];
}
interface DrawResources {
  readonly capacity: number; readonly levelCount: number; readonly compacted: GPUBuffer;
  readonly previous: GPUBuffer; readonly indirect: GPUBuffer; readonly uniform: GPUBuffer;
  readonly levelPrefix: GPUBuffer; readonly levelBlocks: GPUBuffer;
  group: GPUBindGroup; bindings: readonly GPUBuffer[];
}
interface PendingFrame { readonly result: GpuLodResult; readonly scene: SceneBuffers; readonly previous: SceneBuffers | undefined }
/** Bridges packet LOD metadata to selection, stable global budgets, compaction, and indirect draws. */
export class ScreenSpacePacketLodResources {
  private readonly budgetLayout: GPUBindGroupLayout;
  private readonly drawLayout: GPUBindGroupLayout;
  private readonly budgetPipelines: readonly GPUComputePipeline[];
  private readonly drawPipelines: readonly GPUComputePipeline[];
  private readonly drawsByBatch = new Map<string, DrawResources>();
  private activeDraws = new Map<string, readonly PacketLodDraw[]>();
  private selector: GpuLodSelector | undefined;
  private scene: SceneBuffers | undefined;
  private pending: PendingFrame | undefined;
  private disposed = false;

  private readonly inputs: PacketLodSceneCache;
  constructor(private readonly session: DeviceSession, private readonly sharedInputs?: PacketLodSceneCache) {
    this.inputs = sharedInputs ?? new PacketLodSceneCache(session);
    const device = session.device;
    this.budgetLayout = device.createBindGroupLayout({ label: "Deep packet LOD budget layout", entries: [
      ...Array.from({ length: 5 }, (_, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE,
        buffer: { type: binding < 2 ? "read-only-storage" : "storage" } as GPUBufferBindingLayout })),
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: PACKET_LOD_BUDGET_UNIFORM_SIZE } },
    ] });
    this.drawLayout = device.createBindGroupLayout({ label: "Deep packet LOD draw layout", entries: [
      ...Array.from({ length: 8 }, (_, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE,
        buffer: { type: binding < 3 ? "read-only-storage" : "storage" } as GPUBufferBindingLayout })),
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: PACKET_LOD_DRAW_UNIFORM_SIZE } },
    ] });
    this.budgetPipelines = computePipelines(device, this.budgetLayout, PACKET_LOD_BUDGET_WGSL, "budget",
      ["classifyBudget", "scanBudgetLocal", "scanBudgetBlocks", "applyBudget"]);
    this.drawPipelines = computePipelines(device, this.drawLayout, PACKET_LOD_INDIRECT_WGSL, "draw",
      ["scanLevelLocal", "scanLevelBlocks", "compactLevels"]);
  }

  encode(encoder: GPUCommandEncoder, batches: ReadonlyMap<string, CachedPacketBatch>,
    geometries: ReadonlyMap<string, CachedPacketGeometry>, revision: number, view: PacketLodView,
    bounds: PacketGeometryBoundsMap = geometries): PacketLodFrameStats {
    this.assertReady();
    if (this.pending) throw new Error("A packet LOD frame is already pending submission.");
    const lodBatches = [...batches.values()].filter((batch): batch is CachedPacketBatch & { source: PreparedBatch & { lod: LodProfile } } => batch.source.lod !== undefined && batch.source.lod.strategy !== "author-selected");
    if (!lodBatches.length) { this.clearScene(); return emptyStats(); }
    const previous = this.scene, staged = this.stageScene(lodBatches, geometries, bounds, revision);
    const selector = this.selector ??= new GpuLodSelector(this.session);
    const topologyChanged = staged.topology !== previous?.topology;
    let result: GpuLodResult | undefined;
    try {
      result = selector.encode(encoder, { objects: staged.objects, levels: staged.levels,
        count: staged.count, revision }, { camera: view.camera, viewport: view.viewport,
        cameraJump: view.cameraJump === true || topologyChanged });
      const workgroups = Math.ceil(staged.count / PACKET_LOD_WORKGROUP_SIZE);
      this.ensureBudgetGroup(staged, result); this.writeBudget(staged, workgroups, view);
      const budgetPass = encoder.beginComputePass({ label: "Deep packet LOD global stable budget" });
      budgetPass.setBindGroup(0, staged.budgetGroup);
      this.budgetPipelines.forEach((pipeline, index) => {
        budgetPass.setPipeline(pipeline); budgetPass.dispatchWorkgroups(index === 2 ? 1 : workgroups);
      });
      budgetPass.end();
      const valid = new Set(staged.mappings.map(mapping => mapping.batch.source.key));
      this.pruneDraws(valid); this.activeDraws = new Map();
      let indirectDraws = 0;
      for (const mapping of staged.mappings) {
        const resources = this.ensureDrawResources(mapping, staged);
        this.writeUniform(resources.uniform, mapping);
        const pass = encoder.beginComputePass({ label: `Deep packet LOD ${mapping.batch.source.key}` });
        pass.setBindGroup(0, resources.group);
        const batchWorkgroups = Math.ceil(mapping.batch.source.count / PACKET_LOD_WORKGROUP_SIZE);
        this.drawPipelines.forEach((pipeline, index) => {
          pass.setPipeline(pipeline); pass.dispatchWorkgroups(index === 1 ? 1 : batchWorkgroups);
        });
        pass.end();
        const draws = mapping.residentLevelIndices.map(index => {
          const level = mapping.profile.levels[index]!;
          return {
          geometry: level.geometry, instances: resources.compacted, previousTransforms: resources.previous,
          instanceByteOffset: index * resources.capacity * INSTANCE_STRIDE,
          previousByteOffset: index * resources.capacity * PREVIOUS_STRIDE,
          indirect: resources.indirect, indirectOffset: index * PACKET_LOD_INDIRECT_STRIDE,
          } satisfies PacketLodDraw;
        });
        this.activeDraws.set(mapping.batch.source.key, Object.freeze(draws)); indirectDraws += draws.length;
      }
      // Budget and compaction always write GPU state, even when selector records are reused.
      this.pending = { result, scene: staged, previous };
      return { inputObjects: staged.count, selectionBatches: staged.mappings.length, indirectDraws,
        historyReset: result.updated && result.historyReset };
    } catch (error) {
      this.activeDraws.clear();
      failWithResourceCleanup(error, "Packet LOD encoding failed.", [
        () => { if (result?.updated) selector.cancel(result); },
        () => { if (staged.budgetRecords !== previous?.budgetRecords) this.releaseScene(staged); },
      ]);
    }
  }

  draws(batchKey: string): readonly PacketLodDraw[] | undefined { return this.activeDraws.get(batchKey); }

  commitFrame(): void {
    if (!this.pending) return;
    const { result, scene, previous } = this.pending;
    this.scene = scene; this.pending = undefined;
    runResourceCleanup("Packet LOD frame commit failed.", [() => { if (result.updated) this.selector!.commit(result); },
      () => { if (previous && previous.budgetRecords !== scene.budgetRecords) this.releaseScene(previous); }]);
  }

  cancelFrame(): void {
    if (!this.pending) return;
    const { result, scene, previous } = this.pending;
    this.pending = undefined; this.activeDraws.clear();
    runResourceCleanup("Packet LOD frame cancellation failed.", [() => { if (result.updated) this.selector!.cancel(result); },
      () => { if (scene.budgetRecords !== previous?.budgetRecords) this.releaseScene(scene); }]);
  }

  failFrame(): void {
    if (!this.pending) return;
    const { result, scene, previous } = this.pending;
    this.pending = undefined; this.activeDraws.clear();
    runResourceCleanup("Packet LOD failed-frame cleanup failed.", [() => { if (result.updated) this.selector!.fail(result); },
      () => { if (scene.budgetRecords !== previous?.budgetRecords) this.releaseScene(scene); }]);
  }

  dispose(): void {
    if (this.disposed) return;
    const pending = this.pending, selector = this.selector, scene = this.scene, draws = [...this.drawsByBatch.values()];
    this.disposed = true; this.pending = undefined; this.selector = undefined; this.scene = undefined;
    this.activeDraws.clear(); this.drawsByBatch.clear();
    runResourceCleanup("Packet LOD resource disposal failed.", [
      () => { if (pending?.result.updated) selector?.fail(pending.result); },
      () => selector?.dispose(),
      () => { if (pending && pending.scene.budgetRecords !== scene?.budgetRecords) this.releaseScene(pending.scene); },
      () => { if (scene) this.releaseScene(scene); },
      ...draws.map(value => () => this.releaseDraws(value)),
      () => { if (!this.sharedInputs) this.inputs.clear(); },
    ]);
  }

  private stageScene(batches: readonly (CachedPacketBatch & { source: PreparedBatch & { lod: LodProfile } })[],
    geometries: ReadonlyMap<string, CachedPacketGeometry>,
    bounds: PacketGeometryBoundsMap, revision: number): SceneBuffers {
    if (this.scene?.revision === revision) return this.scene;
    const inputs = this.inputs.prepare(batches, geometries, bounds, revision), current = this.scene;
    const reusable = current && current.capacity >= inputs.capacity && inputs.capacity * 4 >= current.capacity;
    const candidate = reusable ? current : this.allocateScene(inputs);
    return { ...candidate, ...inputs };
  }

  private allocateScene(inputs: PacketLodSceneInputs): SceneBuffers {
    const capacity = inputs.capacity;
    const created: GPUBuffer[] = [];
    try {
      const make = (label: string, size: number, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) => {
        const value = this.ownBuffer(label, size, usage); created.push(value); return value;
      };
      const blocks = Math.ceil(capacity / PACKET_LOD_WORKGROUP_SIZE);
      return { ...inputs,
        budgetRecords: make("Deep packet LOD budget records", capacity * PACKET_LOD_BUDGET_RECORD_STRIDE),
        budgetPrefix: make("Deep packet LOD budget local prefix", capacity * PACKET_LOD_BUDGET_RECORD_STRIDE),
        budgetBlocks: make("Deep packet LOD budget block offsets", blocks * PACKET_LOD_BUDGET_RECORD_STRIDE),
        budgetUniform: make("Deep packet LOD global budget", PACKET_LOD_BUDGET_UNIFORM_SIZE,
          GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
        budgetGroup: undefined as unknown as GPUBindGroup, budgetBindings: [],
        capacity };
    } catch (error) { failWithResourceCleanup(error, "Packet LOD scene allocation failed.",
      created.map(value => () => this.session.release(value))); }
  }

  private ensureDrawResources(mapping: BatchMapping, scene: SceneBuffers): DrawResources {
    const key = mapping.batch.source.key, needed = nextCapacity(mapping.batch.source.count), old = this.drawsByBatch.get(key);
    let value = old;
    if (!old || old.capacity < needed || needed * 4 < old.capacity || old.levelCount !== mapping.profile.levels.length) {
      value = this.allocateDraws(needed, mapping.profile.levels.length);
      this.drawsByBatch.set(key, value);
      if (old) this.releaseDraws(old);
    }
    const bindings = [scene.budgetRecords, mapping.batch.buffer, mapping.batch.previousBuffer,
      value!.levelPrefix, value!.levelBlocks, value!.compacted, value!.previous, value!.indirect];
    if (!sameBuffers(value!.bindings, bindings)) {
      value!.group = this.session.device.createBindGroup({ label: "Deep packet LOD indirect bindings", layout: this.drawLayout,
        entries: [...bindings.map((buffer, binding) => ({ binding, resource: { buffer } })),
          { binding: 8, resource: { buffer: value!.uniform } }] });
      value!.bindings = bindings;
    }
    return value!;
  }

  private allocateDraws(capacity: number, levelCount: number): DrawResources {
    const created: GPUBuffer[] = [];
    try {
      const make = (label: string, size: number, usage: GPUBufferUsageFlags) => { const value = this.ownBuffer(label, size, usage); created.push(value); return value; };
      const compacted = make("Deep packet LOD compacted instances", capacity * levelCount * INSTANCE_STRIDE,
        GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC);
      const previous = make("Deep packet LOD compacted previous transforms", capacity * levelCount * PREVIOUS_STRIDE, GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX);
      const levelPrefix = make("Deep packet LOD level local prefix", capacity * GPU_LOD_MAX_LEVELS * 4, GPUBufferUsage.STORAGE);
      const levelBlocks = make("Deep packet LOD level block offsets", Math.ceil(capacity / PACKET_LOD_WORKGROUP_SIZE) * GPU_LOD_MAX_LEVELS * 4, GPUBufferUsage.STORAGE);
      const indirect = make("Deep packet LOD indirect draws", GPU_LOD_MAX_LEVELS * PACKET_LOD_INDIRECT_STRIDE,
        GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC);
      const uniform = make("Deep packet LOD draw parameters", PACKET_LOD_DRAW_UNIFORM_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      return { capacity, levelCount, compacted, previous, indirect, uniform, levelPrefix, levelBlocks,
        group: undefined as unknown as GPUBindGroup, bindings: [] };
    } catch (error) { failWithResourceCleanup(error, "Packet LOD draw allocation failed.",
      created.map(value => () => this.session.release(value))); }
  }

  private ensureBudgetGroup(scene: SceneBuffers, result: GpuLodResult): void {
    const bindings = [result.records, scene.objects, scene.budgetPrefix, scene.budgetBlocks, scene.budgetRecords];
    if (sameBuffers(scene.budgetBindings, bindings)) return;
    scene.budgetGroup = this.session.device.createBindGroup({ label: "Deep packet LOD budget bindings", layout: this.budgetLayout,
      entries: [...bindings.map((buffer, binding) => ({ binding, resource: { buffer } })),
        { binding: 5, resource: { buffer: scene.budgetUniform } }] });
    scene.budgetBindings = bindings;
  }

  private writeBudget(scene: SceneBuffers, workgroups: number, view: PacketLodView): void {
    const data = new ArrayBuffer(PACKET_LOD_BUDGET_UNIFORM_SIZE), uints = new Uint32Array(data), floats = new Float32Array(data);
    uints.set([scene.count, workgroups, budgetValue(view.budget?.maxObjects, scene.count, "object"),
      budgetValue(view.budget?.maxTriangles, MAX_U32, "triangle")]);
    floats.set(new Float32Array(packFrustum(view.frustum)), 4);
    this.session.device.queue.writeBuffer(scene.budgetUniform, 0, data);
  }

  private writeUniform(buffer: GPUBuffer, mapping: BatchMapping): void {
    const data = new ArrayBuffer(PACKET_LOD_DRAW_UNIFORM_SIZE), uints = new Uint32Array(data);
    uints.set([mapping.offset, mapping.batch.source.count, this.drawsByBatch.get(mapping.batch.source.key)!.capacity, mapping.profile.levels.length]);
    mapping.profile.levels.forEach((level, index) => uints.set([level.triangles * 3, 0, 0, 0], 4 + index * 4));
    this.session.device.queue.writeBuffer(buffer, 0, data);
  }

  private clearScene(): void {
    const pending = this.pending, selector = this.selector, scene = this.scene, draws = [...this.drawsByBatch.values()];
    this.pending = undefined; this.selector = undefined; this.scene = undefined;
    this.activeDraws.clear(); this.drawsByBatch.clear();
    runResourceCleanup("Packet LOD scene clearing failed.", [
      () => { if (pending?.result.updated) selector?.fail(pending.result); }, () => selector?.dispose(),
      () => { if (pending && pending.scene.budgetRecords !== scene?.budgetRecords) this.releaseScene(pending.scene); },
      () => { if (scene) this.releaseScene(scene); }, ...draws.map(value => () => this.releaseDraws(value)),
      () => { if (!this.sharedInputs) this.inputs.clear(); },
    ]);
  }
  private pruneDraws(valid: ReadonlySet<string>): void {
    const retired = [...this.drawsByBatch].filter(([key]) => !valid.has(key));
    for (const [key] of retired) this.drawsByBatch.delete(key);
    runResourceCleanup("Superseded packet LOD draw retirement failed.",
      retired.map(([, value]) => () => this.releaseDraws(value)));
  }
  private releaseDraws(value: DrawResources): void { runResourceCleanup("Packet LOD draw disposal failed.", [
    () => this.session.release(value.compacted), () => this.session.release(value.previous),
    () => this.session.release(value.indirect), () => this.session.release(value.uniform),
    () => this.session.release(value.levelPrefix), () => this.session.release(value.levelBlocks)]); }
  private releaseScene(value: SceneBuffers): void { runResourceCleanup("Packet LOD selection scene disposal failed.", [
    () => this.session.release(value.budgetRecords), () => this.session.release(value.budgetPrefix),
    () => this.session.release(value.budgetBlocks), () => this.session.release(value.budgetUniform)]); }
  private ownBuffer(label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer { return this.session.own(this.session.device.createBuffer({ label, size: Math.max(4, size), usage })); }
  private assertReady(): void { if (this.disposed || this.session.state !== "ready") throw new Error("Packet LOD resources are not ready."); }
}

function budgetValue(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`LOD ${label} budget must be a nonnegative integer.`);
  return Math.min(value, MAX_U32);
}
function nextCapacity(count: number): number { return Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(1, count)))); }
function sameBuffers(left: readonly GPUBuffer[], right: readonly GPUBuffer[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function emptyStats(): PacketLodFrameStats { return { inputObjects: 0, selectionBatches: 0, indirectDraws: 0, historyReset: false }; }

function computePipelines(device: GPUDevice, layout: GPUBindGroupLayout, code: string, label: string,
  entries: readonly string[]): readonly GPUComputePipeline[] {
  const module = device.createShaderModule({ label: `Deep packet LOD ${label} WGSL`, code });
  const pipelineLayout = device.createPipelineLayout({ label: `Deep packet LOD ${label} pipeline layout`, bindGroupLayouts: [layout] });
  return entries.map(entryPoint => device.createComputePipeline({ label: `Deep packet LOD ${entryPoint}`,
    layout: pipelineLayout, compute: { module, entryPoint } }));
}
