import type { Document } from "@gltf-transform/core";
import type { ProbeAabb } from "@bim-studio/deep-engine";
import { PROBE_BAKE_MAX_DIRTY_BOUNDS, convergeDirtyBounds, dirtyBoundsFromLightDelta, expandProbeAabb,
  regionsAffectedByBounds } from "./lightmapProbeRegions";
import { bakePreparedProbeRegion, prepareProbeBake, probeRegionStateHash,
  type ProbeBakeOptions, type PreparedProbeBake } from "./lightmapProbeBaker";
import type { BakeLightState } from "./modelOptimizer";

/** 间接传播余量:脏域按最大灯距的该比例外扩,覆盖一跳反弹把灯光变化带到影响域之外的场景。 */
const INDIRECT_PROPAGATION_RATIO = 1.5;

/**
 * 增量重烘编排层:按区域缓存烘焙结果,灯光状态变化自动派生脏域(对齐 GI probeClipmap 的
 * dirtyBounds 语义),外部脏域(几何变化等)由调用方传入。
 *
 * 决策合同:哈希是复用的最终闸门——未命中脏域且状态哈希与缓存一致的区域直接字节级复用
 * (返回的就是上次烘焙的那个 Float32Array,视作不可变);命中脏域的区域无条件重烘,因为
 * 调用方可能知道哈希覆盖不到的影响(如区域外几何遮挡变化)。
 */

export interface ProbeRegionOutcome {
  key: string;
  probeCount: number;
  stateHash: string;
  decision: "rebaked" | "reused";
  reason: "no-cache" | "dirty-bounds" | "state-hash-changed" | "hash-match";
  bakeMs: number;
  dirtyByBounds: boolean;
  affectedLightIds: string[];
  overlappingPrimitives: number;
  records: Float32Array;
  bytes: Uint8Array;
}

export interface IncrementalProbeBakeResult {
  layoutKey: string;
  quality: ProbeBakeOptions["quality"];
  probeCount: number;
  regionCount: number;
  regionsRebaked: number;
  regionsReused: number;
  regionsDirtyByBounds: number;
  lightDirtyBounds: number;
  externalDirtyBounds: number;
  prepareMs: number;
  hashMs: number;
  rebakeMs: number;
  totalMs: number;
  rebakedBytes: number;
  reusedBytes: number;
  regions: ProbeRegionOutcome[];
}

interface RegionCacheEntry {
  stateHash: string;
  records: Float32Array;
  probeCount: number;
}

export class IncrementalProbeBaker {
  private cache = new Map<string, RegionCacheEntry>();
  private layoutKey: string | null = null;
  private previousLights: BakeLightState[] | null = null;

  /** 灯光状态变化 → 受影响区域重烘;未变区域字节级复用。几何变化请传 externalDirtyBounds。 */
  async bake(document: Document, options: ProbeBakeOptions,
    externalDirtyBounds?: readonly ProbeAabb[]): Promise<IncrementalProbeBakeResult> {
    const totalStarted = nowMs();
    const prepareStarted = nowMs();
    const prepared = await prepareProbeBake(document, options);
    try {
      return this.bakePrepared(prepared, options, externalDirtyBounds ?? [], totalStarted, nowMs() - prepareStarted);
    } finally {
      prepared.dispose();
    }
  }

  /** 丢弃全部缓存;下一次 bake 等价全量。 */
  reset(): void {
    this.cache.clear();
    this.layoutKey = null;
    this.previousLights = null;
  }

  private lightDeltaBounds(prepared: PreparedProbeBake, lights: readonly BakeLightState[]): ProbeAabb[] {
    if (!this.previousLights) return [];
    const raw = dirtyBoundsFromLightDelta(this.previousLights, lights, prepared.sceneBounds);
    if (raw.length === 0) return [];
    const margin = prepared.preset.indirectSamples > 0 ? INDIRECT_PROPAGATION_RATIO * maxLightRange(lights) : 0;
    return convergeDirtyBounds(raw.map(bounds => expandProbeAabb(bounds, margin)), prepared.sceneBounds);
  }

  private bakePrepared(prepared: PreparedProbeBake, options: ProbeBakeOptions,
    externalDirtyBounds: readonly ProbeAabb[], totalStarted: number, prepareMs: number): IncrementalProbeBakeResult {
    const plan = prepared.plan;
    if (this.layoutKey !== null && this.layoutKey !== plan.layout.layoutKey) {
      // 探针布局变化(场景包围盒/质量档)意味着缓存探针不再是同一批位置,整体失效。
      this.cache.clear();
    }
    const lightDirty = this.lightDeltaBounds(prepared, options.lights);
    const dirtyBounds = [...externalDirtyBounds, ...lightDirty];
    const dirtyRegionKeys = new Set(
      (dirtyBounds.length > PROBE_BAKE_MAX_DIRTY_BOUNDS
        ? plan.regions
        : regionsAffectedByBounds(plan, dirtyBounds)).map(region => region.key),
    );
    const hashStarted = nowMs();
    const regions: ProbeRegionOutcome[] = [];
    let rebakeMs = 0;
    let rebakedBytes = 0;
    let reusedBytes = 0;
    let regionsRebaked = 0;
    let regionsReused = 0;
    for (const region of plan.regions) {
      const state = probeRegionStateHash(prepared, region, options.lights);
      const cached = this.cache.get(region.key);
      const dirty = dirtyRegionKeys.has(region.key);
      const probeCount = region.probes.length;
      const reusable = cached !== undefined && !dirty
        && cached.stateHash === state.hash && cached.probeCount === probeCount;
      if (reusable) {
        const entry = cached!;
        regionsReused += 1;
        reusedBytes += entry.records.byteLength;
        regions.push({
          key: region.key, probeCount, stateHash: entry.stateHash,
          decision: "reused", reason: "hash-match", bakeMs: 0, dirtyByBounds: dirty,
          affectedLightIds: state.affectedLightIds, overlappingPrimitives: state.overlappingPrimitives,
          records: entry.records, bytes: new Uint8Array(entry.records.buffer, entry.records.byteOffset, entry.records.byteLength),
        });
        continue;
      }
      const baked = bakePreparedProbeRegion(prepared, region, options.lights);
      rebakeMs += baked.bakeMs;
      rebakedBytes += baked.bytes.byteLength;
      regionsRebaked += 1;
      this.cache.set(region.key, { stateHash: baked.stateHash, records: baked.records, probeCount });
      regions.push({
        key: region.key, probeCount, stateHash: baked.stateHash,
        decision: "rebaked",
        reason: !cached ? "no-cache" : dirty && cached.stateHash === baked.stateHash ? "dirty-bounds" : "state-hash-changed",
        bakeMs: baked.bakeMs, dirtyByBounds: dirty,
        affectedLightIds: baked.affectedLightIds, overlappingPrimitives: baked.overlappingPrimitives,
        records: baked.records, bytes: baked.bytes,
      });
    }
    const hashMs = nowMs() - hashStarted;
    this.layoutKey = plan.layout.layoutKey;
    // 深拷贝向量字段:调用方可能原地改写 position/direction 数组,共享引用会让下一次脏域判定漏检。
    this.previousLights = options.lights.map(light =>
      ({ ...light, direction: [...light.direction] as [number, number, number], position: [...light.position] as [number, number, number] }));
    return {
      layoutKey: plan.layout.layoutKey,
      quality: options.quality,
      probeCount: plan.layout.probeCount,
      regionCount: plan.regions.length,
      regionsRebaked, regionsReused,
      regionsDirtyByBounds: dirtyRegionKeys.size,
      lightDirtyBounds: lightDirty.length,
      externalDirtyBounds: externalDirtyBounds.length,
      prepareMs, hashMs, rebakeMs,
      totalMs: nowMs() - totalStarted,
      rebakedBytes, reusedBytes,
      regions,
    };
  }
}

function maxLightRange(lights: readonly BakeLightState[]): number {
  // 方向光的 range 无空间语义(影响域已是全场景),不参与外扩余量。
  return lights.reduce((max, light) => light.type === "point" ? Math.max(max, light.range) : max, 0);
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}
