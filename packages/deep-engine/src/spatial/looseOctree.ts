import {
  aabbCenter,
  aabbContains,
  aabbHalfExtents,
  aabbIntersects,
  aabbIntersectsFrustum,
  sameAabb,
  validateSpatialAabb,
  validateSpatialFrustum,
} from "./bounds.js";
import {
  createOctreeNode,
  DEEP_SPATIAL_INDEX_LIMITS,
  DEFAULT_SPATIAL_MASK,
  octreeChildSlot,
  octreeChildSpec,
  resolveOctreeOptions,
  validateSpatialId,
  validateSpatialMask,
  type OctreeNode,
  type SpatialRecord,
} from "./octreeInternals.js";
import { executeOctreeQuery } from "./octreeQuery.js";
import {
  SpatialIndexError,
  type LooseOctreeConfiguration,
  type LooseOctreeOptions,
  type LooseOctreeStats,
  type SpatialAabb,
  type SpatialEntryOptions,
  type SpatialFrustum,
  type SpatialItemId,
  type SpatialQueryOptions,
  type SpatialQueryResult,
} from "./types.js";

export { DEEP_SPATIAL_INDEX_LIMITS } from "./octreeInternals.js";

/** Sparse loose octree for incremental scene candidate generation. */
export class LooseOctreeIndex<TId extends SpatialItemId = string> {
  readonly bounds: SpatialAabb;
  readonly options: Readonly<LooseOctreeConfiguration>;

  private readonly root: OctreeNode<TId>;
  private readonly records = new Map<TId, SpatialRecord<TId>>();
  private readonly overflow = new Set<SpatialRecord<TId>>();
  private nodeCount = 1;
  private budgetLimitedCount = 0;
  private nextOrdinal = 0;
  private stateRevision = 0;

  constructor(options: LooseOctreeOptions) {
    this.options = resolveOctreeOptions(options);
    this.bounds = validateSpatialAabb(options?.bounds, { requireVolume: true, label: "Loose octree bounds" });
    this.root = createOctreeNode<TId>(
      null,
      -1,
      0,
      aabbCenter(this.bounds),
      aabbHalfExtents(this.bounds),
      this.options.looseness,
    );
  }

  get size(): number {
    return this.records.size;
  }

  get revision(): number {
    return this.stateRevision;
  }

  get stats(): LooseOctreeStats {
    return Object.freeze({
      entries: this.records.size,
      nodes: this.nodeCount,
      overflowEntries: this.overflow.size,
      budgetLimitedEntries: this.budgetLimitedCount,
      revision: this.stateRevision,
    });
  }

  has(id: TId): boolean {
    return this.records.has(id);
  }

  getBounds(id: TId): SpatialAabb | undefined {
    return this.records.get(id)?.bounds;
  }

  getMask(id: TId): number | undefined {
    return this.records.get(id)?.mask;
  }

  insert(id: TId, bounds: SpatialAabb, options: SpatialEntryOptions = {}): void {
    validateSpatialId(id);
    const nextBounds = validateSpatialAabb(bounds, { label: `Spatial entry ${String(id)}` });
    const mask = validateSpatialMask(options.mask ?? DEFAULT_SPATIAL_MASK);
    if (this.records.has(id)) {
      throw new SpatialIndexError("duplicate-id", `Spatial entry already exists: ${String(id)}.`);
    }
    if (this.records.size >= this.options.maxEntries) {
      throw new SpatialIndexError("capacity-exceeded", `Spatial entry capacity ${this.options.maxEntries} was exceeded.`);
    }
    const record: SpatialRecord<TId> = {
      id,
      ordinal: this.nextOrdinal,
      bounds: nextBounds,
      mask,
      node: null,
      overflow: false,
      budgetLimited: false,
    };
    this.nextOrdinal += 1;
    this.records.set(id, record);
    this.attach(record);
    this.stateRevision += 1;
  }

  update(id: TId, bounds: SpatialAabb, options: SpatialEntryOptions = {}): boolean {
    validateSpatialId(id);
    const record = this.records.get(id);
    if (!record) throw new SpatialIndexError("missing-id", `Spatial entry does not exist: ${String(id)}.`);
    const nextBounds = validateSpatialAabb(bounds, { label: `Spatial entry ${String(id)}` });
    const nextMask = validateSpatialMask(options.mask ?? record.mask);
    if (sameAabb(record.bounds, nextBounds) && record.mask === nextMask) return false;

    // Validation is complete before detaching, so rejected updates cannot corrupt the index.
    if ((record.node && aabbContains(record.node.looseBounds, nextBounds))
      || (record.overflow && !aabbContains(this.root.looseBounds, nextBounds))) {
      record.bounds = nextBounds;
      record.mask = nextMask;
      this.stateRevision += 1;
      return true;
    }
    this.detach(record);
    record.bounds = nextBounds;
    record.mask = nextMask;
    this.attach(record);
    this.stateRevision += 1;
    return true;
  }

  upsert(id: TId, bounds: SpatialAabb, options: SpatialEntryOptions = {}): "inserted" | "updated" | "unchanged" {
    if (!this.records.has(id)) {
      this.insert(id, bounds, options);
      return "inserted";
    }
    return this.update(id, bounds, options) ? "updated" : "unchanged";
  }

  remove(id: TId): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    this.detach(record);
    this.records.delete(id);
    this.stateRevision += 1;
    return true;
  }

  clear(): void {
    if (this.records.size === 0) return;
    this.records.clear();
    this.overflow.clear();
    this.root.entries.length = 0;
    this.root.children.fill(undefined);
    this.nodeCount = 1;
    this.budgetLimitedCount = 0;
    this.nextOrdinal = 0;
    this.stateRevision += 1;
  }

  rebuild(): void {
    if (this.records.size === 0) return;
    const records = [...this.records.values()].sort((left, right) => left.ordinal - right.ordinal);
    this.overflow.clear();
    this.root.entries.length = 0;
    this.root.children.fill(undefined);
    this.nodeCount = 1;
    this.budgetLimitedCount = 0;
    for (const record of records) {
      record.node = null;
      record.overflow = false;
      record.budgetLimited = false;
      this.attach(record);
    }
    this.stateRevision += 1;
  }

  queryAabb(bounds: SpatialAabb, options: SpatialQueryOptions = {}): SpatialQueryResult<TId> {
    const query = validateSpatialAabb(bounds, { label: "Spatial AABB query" });
    return executeOctreeQuery(
      this.root,
      this.overflow,
      this.records.size,
      this.options.maxEntries,
      (nodeBounds) => aabbIntersects(nodeBounds, query),
      (entryBounds) => aabbIntersects(entryBounds, query),
      options,
    );
  }

  queryFrustum(frustum: SpatialFrustum, options: SpatialQueryOptions = {}): SpatialQueryResult<TId> {
    const query = validateSpatialFrustum(frustum);
    return executeOctreeQuery(
      this.root,
      this.overflow,
      this.records.size,
      this.options.maxEntries,
      (nodeBounds) => aabbIntersectsFrustum(nodeBounds, query),
      (entryBounds) => aabbIntersectsFrustum(entryBounds, query),
      options,
    );
  }

  private attach(record: SpatialRecord<TId>): void {
    if (!aabbContains(this.root.looseBounds, record.bounds)) {
      record.overflow = true;
      this.overflow.add(record);
      return;
    }
    let node = this.root;
    while (node.depth < this.options.maxDepth) {
      const slot = octreeChildSlot(aabbCenter(record.bounds), node.center);
      let child = node.children[slot];
      if (!child) {
        const spec = octreeChildSpec(node, slot, this.options.looseness);
        if (!aabbContains(spec.looseBounds, record.bounds)) break;
        if (this.nodeCount >= this.options.maxNodes) {
          record.budgetLimited = true;
          this.budgetLimitedCount += 1;
          break;
        }
        child = createOctreeNode(node, slot, node.depth + 1, spec.center, spec.halfExtents, this.options.looseness);
        node.children[slot] = child;
        this.nodeCount += 1;
      } else if (!aabbContains(child.looseBounds, record.bounds)) {
        break;
      }
      node = child;
    }
    record.node = node;
    node.entries.push(record);
  }

  private detach(record: SpatialRecord<TId>): void {
    if (record.budgetLimited) {
      this.budgetLimitedCount -= 1;
      record.budgetLimited = false;
    }
    if (record.overflow) {
      this.overflow.delete(record);
      record.overflow = false;
      return;
    }
    const node = record.node;
    if (!node) return;
    const index = node.entries.indexOf(record);
    if (index >= 0) node.entries.splice(index, 1);
    record.node = null;
    this.prune(node);
  }

  private prune(start: OctreeNode<TId>): void {
    let node: OctreeNode<TId> | null = start;
    while (node.parent && node.entries.length === 0 && node.children.every((child) => child === undefined)) {
      const parent: OctreeNode<TId> = node.parent;
      parent.children[node.parentSlot] = undefined;
      this.nodeCount -= 1;
      node = parent;
    }
  }
}
