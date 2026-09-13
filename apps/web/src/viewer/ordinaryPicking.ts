import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import { copyPickingSnapshot, eligiblePickingMesh, geometryStamp, pickingIdle, stampMatches, type GeometryStamp, type PickingBuilder } from "./ordinaryPickingGeometry";
import { indexedMeshHits } from "./ordinaryPickingRaycast";
import { PickingWorker } from "./ordinaryPickingWorker";

type IndexEntry = {
  geometry: THREE.BufferGeometry;
  stamp: GeometryStamp;
  controller: AbortController;
  onDispose: () => void;
  bvh?: MeshBVH;
  bytes: number;
  state: "queued" | "building" | "ready" | "failed";
};
type PickingOptions = { builder?: PickingBuilder; minTriangles?: number; maxSnapshotBytes?: number; maxCacheBytes?: number };
const viewerPickers = new WeakMap<object, OrdinaryPicking>();

export function createOrdinaryPicking(owner: object): OrdinaryPicking {
  const picker = new OrdinaryPicking(); viewerPickers.set(owner, picker); return picker;
}

export function disposeOrdinaryPicking(owner: object): void {
  viewerPickers.get(owner)?.dispose(); viewerPickers.delete(owner);
}

/** 每个 Viewer 独立的惰性拾取缓存；共享 geometry 在本 Viewer 只建一次索引。 */
export class OrdinaryPicking {
  private readonly entries = new Map<THREE.BufferGeometry, IndexEntry>();
  private readonly queue: IndexEntry[] = [];
  private readonly builder: PickingBuilder;
  private readonly minTriangles: number;
  private readonly maxSnapshotBytes: number;
  private readonly maxCacheBytes: number;
  private active: IndexEntry | undefined;
  private enabled = true;
  private disposed = false;
  private bytes = 0;
  private builds = 0;
  private fallbacks = 0;

  constructor(options: PickingOptions = {}) {
    this.builder = options.builder ?? new PickingWorker();
    this.minTriangles = options.minTriangles ?? 20000;
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? 64 * 1024 * 1024;
    this.maxCacheBytes = options.maxCacheBytes ?? 128 * 1024 * 1024;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  diagnostics() {
    return { enabled: this.enabled && !this.disposed, ready: [...this.entries.values()].filter((entry) => entry.state === "ready").length,
      queued: this.queue.length, building: Boolean(this.active), indexBytes: this.bytes, builds: this.builds, fallbacks: this.fallbacks,
      minTriangles: this.minTriangles, maxSnapshotBytes: this.maxSnapshotBytes, maxCacheBytes: this.maxCacheBytes };
  }

  intersectObjects(raycaster: THREE.Raycaster, roots: THREE.Object3D[], excludedRoots: ReadonlySet<THREE.Object3D> = new Set()): THREE.Intersection[] {
    if (!this.enabled || this.disposed) return raycaster.intersectObjects(roots, true);
    const hits: THREE.Intersection[] = [];
    const visit = (object: THREE.Object3D, excluded: boolean) => {
      let propagate = true;
      if (object.layers.test(raycaster.layers)) {
        const eligible = !excluded && eligiblePickingMesh(object, this.minTriangles, this.maxSnapshotBytes) && object.matrixWorld.determinant() !== 0;
        const entry = eligible ? this.current(object.geometry) : undefined;
        if (eligible && entry?.bvh) {
          try { hits.push(...indexedMeshHits(object, entry.bvh, raycaster)); }
          catch { this.remove(entry); this.fallbacks++; object.raycast(raycaster, hits); }
        } else {
          propagate = (object.raycast(raycaster, hits) as unknown) !== false;
          if (eligible) this.enqueue(object.geometry);
        }
      }
      // 与 Raycaster 一致：visible 由调用方的模型列表决定，layers 不阻断子层，自定义 false 才阻断。
      if (propagate) for (const child of object.children) visit(child, excluded);
    };
    for (const root of roots) visit(root, excludedRoots.has(root));
    return hits.sort((a, b) => a.distance - b.distance);
  }

  dispose(): void { this.disposed = true; this.clear(); }

  private current(geometry: THREE.BufferGeometry): IndexEntry | undefined {
    const entry = this.entries.get(geometry);
    if (entry && !stampMatches(geometry, entry.stamp)) { this.remove(entry); return undefined; }
    if (entry) { this.entries.delete(geometry); this.entries.set(geometry, entry); }
    return entry;
  }

  private enqueue(geometry: THREE.BufferGeometry): void {
    if (this.entries.has(geometry) || this.queue.length >= 32) return;
    const entry: IndexEntry = { geometry, stamp: geometryStamp(geometry), controller: new AbortController(),
      onDispose: () => this.remove(entry), bytes: 0, state: "queued" };
    geometry.addEventListener("dispose", entry.onDispose);
    this.entries.set(geometry, entry); this.queue.push(entry);
    this.pump();
  }

  private pump(): void {
    if (this.active || !this.enabled || this.disposed) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.active = entry; entry.state = "building";
    void this.build(entry).finally(() => { if (this.active === entry) this.active = undefined; this.pump(); });
  }

  private async build(entry: IndexEntry): Promise<void> {
    try {
      await pickingIdle(entry.controller.signal);
      const snapshot = await copyPickingSnapshot(entry.geometry, entry.stamp, entry.controller.signal);
      const serialized = await this.builder.build(snapshot, entry.controller.signal);
      if (entry.controller.signal.aborted || !stampMatches(entry.geometry, entry.stamp)) { this.remove(entry); return; }
      const bytes = serialized.roots.reduce((sum, root) => sum + root.byteLength, 0) + (serialized.indirectBuffer?.byteLength ?? 0);
      if (bytes > this.maxCacheBytes) { entry.state = "failed"; return; }
      for (const previous of this.entries.values()) {
        if (this.bytes + bytes <= this.maxCacheBytes) break;
        if (previous.state === "ready") this.remove(previous);
      }
      entry.bvh = MeshBVH.deserialize(serialized, entry.geometry, { setIndex: false });
      entry.state = "ready"; entry.bytes = bytes; this.bytes += bytes; this.builds++;
    } catch {
      if (entry.controller.signal.aborted) return;
      entry.state = "failed"; this.fallbacks++;
    }
  }

  private remove(entry: IndexEntry): void {
    entry.controller.abort(); entry.geometry.removeEventListener("dispose", entry.onDispose);
    if (this.entries.get(entry.geometry) === entry) this.entries.delete(entry.geometry);
    const queued = this.queue.indexOf(entry); if (queued >= 0) this.queue.splice(queued, 1);
    this.bytes -= entry.bytes; entry.bytes = 0; delete entry.bvh;
  }

  private clear(): void {
    for (const entry of this.entries.values()) this.remove(entry);
    this.queue.length = 0; this.builder.dispose();
  }
}
