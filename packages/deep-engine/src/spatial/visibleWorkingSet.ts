import { LooseOctreeIndex } from "./looseOctree.js";
import { ScreenSpaceLodSelector } from "./lodSelector.js";
import { validateSpatialLimit } from "./octreeInternals.js";
import { SpatialIndexError, type SpatialAabb, type SpatialItemId } from "./types.js";
import { buildWorkingSetBatches, compareIds } from "./workingSetBatches.js";
import {
  patchedVisibleObject,
  sameLodProfile,
  sameVisibleObject,
  validateVisibleObject,
  type ValidatedVisibleObject,
} from "./workingSetValidation.js";
import type {
  CpuVisibleWorkingSetConfiguration,
  CpuVisibleWorkingSetFrame,
  CpuVisibleWorkingSetOptions,
  CpuVisibleWorkingSetStats,
  VisibleObjectPatch,
  VisibleObjectRegistration,
  VisibleWorkingSetFrameInput,
} from "./workingSetTypes.js";

/** CPU broad-phase and LOD coordinator. It deliberately has no GPU or renderer dependency. */
export class CpuVisibleWorkingSet<TId extends SpatialItemId = string> {
  readonly configuration: Readonly<CpuVisibleWorkingSetConfiguration>;

  private readonly spatial: LooseOctreeIndex<TId>;
  private readonly lod: ScreenSpaceLodSelector<TId>;
  private readonly records = new Map<TId, ValidatedVisibleObject<TId>>();
  private readonly instanceOwners = new Map<SpatialItemId, TId>();
  private readonly suspendedSpatialIds = new Set<TId>();
  private registryGeneration = 0;
  private frameRevision = 0;

  constructor(options: CpuVisibleWorkingSetOptions) {
    if (!options || typeof options !== "object") {
      throw new SpatialIndexError("invalid-options", "CPU visible working set options are required.");
    }
    const maxEntries = options.maxEntries ?? 250_000;
    this.lod = new ScreenSpaceLodSelector({
      maxTrackedObjects: maxEntries,
      defaultHysteresisRatio: options.defaultHysteresisRatio ?? 0.1,
    });
    this.spatial = new LooseOctreeIndex({
      bounds: options.bounds,
      maxEntries,
      ...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
      ...(options.looseness === undefined ? {} : { looseness: options.looseness }),
    });
    this.configuration = Object.freeze({
      ...this.spatial.options,
      defaultHysteresisRatio: this.lod.options.defaultHysteresisRatio,
    });
  }

  get revision(): number {
    return this.frameRevision;
  }

  get generation(): number {
    return this.registryGeneration;
  }

  get size(): number {
    return this.records.size;
  }

  get stats(): CpuVisibleWorkingSetStats {
    const spatial = this.spatial.stats;
    return Object.freeze({
      revision: this.frameRevision,
      generation: this.registryGeneration,
      registeredObjects: this.records.size,
      registeredInstances: this.instanceOwners.size,
      activeSpatialObjects: this.spatial.size,
      trackedLodObjects: this.lod.trackedObjects,
      spatialNodes: spatial.nodes,
      spatialOverflowEntries: spatial.overflowEntries,
    });
  }

  has(id: TId): boolean {
    return this.records.has(id);
  }

  get(id: TId): VisibleObjectRegistration<TId> | undefined {
    return this.records.get(id);
  }

  hasSpatialBounds(id: TId): boolean {
    return this.records.has(id) && !this.suspendedSpatialIds.has(id);
  }

  register(input: VisibleObjectRegistration<TId>): void {
    const record = validateVisibleObject(input, this.lod.options);
    if (this.records.has(record.id)) {
      throw new SpatialIndexError("duplicate-id", `Visible object already exists: ${String(record.id)}.`);
    }
    this.assertInstanceAvailable(record.instanceId, record.id);
    if (this.records.size >= this.configuration.maxEntries) {
      throw new SpatialIndexError("capacity-exceeded", `Visible object capacity ${this.configuration.maxEntries} was exceeded.`);
    }
    this.spatial.insert(record.id, record.bounds, { mask: record.mask });
    this.records.set(record.id, record);
    this.instanceOwners.set(record.instanceId, record.id);
    this.registryGeneration += 1;
  }

  update(id: TId, patch: VisibleObjectPatch): boolean {
    const current = this.requireRecord(id);
    const next = validateVisibleObject(patchedVisibleObject(current, patch), this.lod.options);
    this.assertInstanceAvailable(next.instanceId, id);
    if (sameVisibleObject(current, next)) return false;

    // Index mutation is the only operation that may reject after validation; maps update only after it succeeds.
    if (!this.suspendedSpatialIds.has(id)) this.spatial.update(id, next.bounds, { mask: next.mask });
    if (current.instanceId !== next.instanceId) {
      this.instanceOwners.delete(current.instanceId);
      this.instanceOwners.set(next.instanceId, id);
    }
    this.records.set(id, next);
    if (current.hysteresisRatio !== next.hysteresisRatio || !sameLodProfile(current.levels, next.levels)) {
      this.lod.remove(id);
    }
    this.registryGeneration += 1;
    return true;
  }

  remove(id: TId): boolean {
    const current = this.records.get(id);
    if (!current) return false;
    if (!this.suspendedSpatialIds.has(id) && !this.spatial.remove(id)) {
      throw new SpatialIndexError("missing-metadata", `Spatial index lost registered object ${String(id)}.`);
    }
    this.suspendedSpatialIds.delete(id);
    this.records.delete(id);
    this.instanceOwners.delete(current.instanceId);
    this.lod.remove(id);
    this.registryGeneration += 1;
    return true;
  }

  suspendSpatialBounds(id: TId): boolean {
    this.requireRecord(id);
    if (this.suspendedSpatialIds.has(id)) return false;
    if (!this.spatial.remove(id)) throw new SpatialIndexError("missing-metadata", `Spatial index lost registered object ${String(id)}.`);
    this.suspendedSpatialIds.add(id);
    this.lod.remove(id);
    this.registryGeneration += 1;
    return true;
  }

  resumeSpatialBounds(id: TId, bounds: SpatialAabb): boolean {
    const current = this.requireRecord(id);
    const next = validateVisibleObject(patchedVisibleObject(current, { bounds }), this.lod.options);
    if (!this.suspendedSpatialIds.has(id)) return this.update(id, { bounds });
    this.spatial.insert(id, next.bounds, { mask: next.mask });
    this.records.set(id, next);
    this.suspendedSpatialIds.delete(id);
    this.registryGeneration += 1;
    return true;
  }

  clear(): void {
    if (this.records.size === 0) return;
    this.spatial.clear();
    this.records.clear();
    this.instanceOwners.clear();
    this.suspendedSpatialIds.clear();
    this.lod.reset();
    this.registryGeneration += 1;
    this.frameRevision += 1;
  }

  resetForCameraJump(): void {
    this.lod.resetForCameraJump();
    this.frameRevision += 1;
  }

  resetVisibilityState(): void {
    this.resetForCameraJump();
  }

  buildFrame(input: VisibleWorkingSetFrameInput): CpuVisibleWorkingSetFrame<TId> {
    if (!input || typeof input !== "object") {
      throw new SpatialIndexError("invalid-options", "Visible working set frame input is required.");
    }
    const maxQueryCandidates = validateSpatialLimit(
      input.maxQueryCandidates ?? this.configuration.maxEntries,
      this.configuration.maxEntries,
    );
    const spatialResult = this.spatial.queryFrustum(input.frustum, {
      ...(input.mask === undefined ? {} : { mask: input.mask }),
      limit: this.configuration.maxEntries,
    });
    const matched = spatialResult.ids.map((id) => this.requireCandidateRecord(id));
    matched.sort(compareRegistryPriority);
    const submitted = matched.slice(0, maxQueryCandidates);
    const lodResult = this.lod.selectFrame(
      submitted.map((record) => ({
        id: record.id,
        bounds: record.bounds,
        levels: record.levels,
        priority: record.priority,
        hysteresisRatio: record.hysteresisRatio,
      })),
      input.camera,
      input.viewport,
      input.budget ?? {},
    );
    const built = buildWorkingSetBatches(lodResult.selections, this.records);
    const nextRevision = this.frameRevision + 1;
    const frame: CpuVisibleWorkingSetFrame<TId> = Object.freeze({
      revision: nextRevision,
      generation: this.registryGeneration,
      candidates: built.candidates,
      batches: built.batches,
      query: Object.freeze({
        visitedNodes: spatialResult.visitedNodes,
        testedEntries: spatialResult.testedEntries,
        matchedEntries: spatialResult.matchedEntries,
        submittedToLod: submitted.length,
        truncated: spatialResult.matchedEntries > submitted.length,
      }),
      renderedTriangles: built.triangles,
    });
    this.frameRevision = nextRevision;
    return frame;
  }

  private requireRecord(id: TId): ValidatedVisibleObject<TId> {
    const record = this.records.get(id);
    if (!record) throw new SpatialIndexError("missing-id", `Visible object does not exist: ${String(id)}.`);
    return record;
  }

  private requireCandidateRecord(id: TId): ValidatedVisibleObject<TId> {
    const record = this.records.get(id);
    if (!record) throw new SpatialIndexError("missing-metadata", `Spatial candidate ${String(id)} has no metadata.`);
    return record;
  }

  private assertInstanceAvailable(instanceId: SpatialItemId, objectId: TId): void {
    const owner = this.instanceOwners.get(instanceId);
    if (owner !== undefined && owner !== objectId) {
      throw new SpatialIndexError("duplicate-instance", `Instance ${String(instanceId)} already belongs to ${String(owner)}.`);
    }
  }
}

function compareRegistryPriority<TId extends SpatialItemId>(
  left: ValidatedVisibleObject<TId>,
  right: ValidatedVisibleObject<TId>,
): number {
  return right.priority - left.priority || compareIds(left.id, right.id);
}
