/**
 * 增量 TLAS（compute BVH 光追骨架·实例层基座）：BLAS 段构建期一次缓存（SAH），实例
 * Transform 变更只重写 TLAS 节点段 + 实例记录——BLAS 节点/顶点/索引段与全局段基址
 * （nodeBase/triangleBase/vertexBase，按 blasList 顺序固定）驻留不动，GPU 侧仅需
 * 重传易变区域（ShadowRayMaskPass.updateTlasRegion 接线）。
 *
 * == 合同 ==
 * - BLAS 构建单一来源 buildSahBvh（确定性；f16 档 serializeBvhNodesF16 外扩量化）；
 * - TLAS 段构建单一来源 buildTlasFromWorldBounds（tlas.ts；与 buildTlas 同口径防分叉）；
 * - 实例世界盒：缓存 BLAS 根盒 8 角经 localToWorld 逆变换取三轴 min/max 后 fround
 *   （与 tlas.buildTlas 逐位同口径），更新期零三角形级工作；
 * - 未缓存 BLAS 引用 fail-closed 抛错；BLAS 集变更（增删/换几何）须新建场景对象。
 */

import { buildSahBvh, type SahBvhOptions } from "./blasBuilder.js";
import type { RayBlasDescriptor } from "./rayBackendTypes.js";
import { BVH_NODE_F16_STRIDE_BYTES, BVH_NODE_STRIDE_BYTES, serializeBvhNodes, serializeBvhNodesF16 } from "./rayTraceLayout.js";
import { buildTlasFromWorldBounds, invertAffine3x4, type TlasInstanceBounds, type TlasInstanceDescriptor } from "./tlas.js";
import type { TlasBlasPlacement, TlasPackedScene } from "./tlasLayout.js";

export interface IncrementalTlasOptions {
  /** f16 压缩节点档（nodes buffer 全档 32B/节点；默认 false）。 */
  readonly f16?: boolean;
  /** buildSahBvh 选项透传（maxLeafSize/binCount/maxDepth）。 */
  readonly sah?: SahBvhOptions;
}

export interface IncrementalTlasStats {
  /** 构建期 BLAS 构建次数（=去重 BLAS 数；更新期恒 0——增量的定义）。 */
  readonly blasBuilds: number;
  /** updateInstances 调用次数。 */
  readonly tlasRebuilds: number;
  /** 最近一次更新重写的字节数（TLAS 节点段 + 实例记录；BLAS 段不计）。 */
  readonly lastRewrittenBytes: number;
}

interface BlasSegment {
  readonly blas: RayBlasDescriptor;
  readonly nodeBytes: ArrayBuffer;
  readonly order: ReadonlyArray<number>;
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly rootBounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | undefined;
}

export class IncrementalTlasScene {
  private readonly segments = new Map<RayBlasDescriptor, BlasSegment>();
  private readonly segmentOrder: readonly RayBlasDescriptor[];
  private readonly bases = new Map<RayBlasDescriptor, { nodeBase: number; triangleBase: number; vertexBase: number }>();
  /** BLAS 段拼接（构建期一次；实例更新不动）。 */
  readonly blasSegmentBytes: ArrayBuffer;
  readonly blasVertices: Float32Array;
  readonly blasIndices: Uint32Array;
  readonly blasNodeCount: number;
  readonly triangleCount: number;
  private tlasRebuilds = 0;
  private lastRewrittenBytes = 0;
  private readonly nodeFormat: "f32" | "f16";
  private current: TlasPackedScene;

  constructor(blasList: readonly RayBlasDescriptor[], options: IncrementalTlasOptions = {}) {
    this.nodeFormat = options.f16 === true ? "f16" : "f32";
    const serialize = this.nodeFormat === "f16" ? serializeBvhNodesF16 : serializeBvhNodes;
    const stride = this.nodeFormat === "f16" ? BVH_NODE_F16_STRIDE_BYTES : BVH_NODE_STRIDE_BYTES;
    this.segmentOrder = blasList;
    let nodeCursor = 0, triangleCursor = 0, vertexCursor = 0;
    for (const blas of blasList) {
      if (this.segments.has(blas)) throw new Error(`Duplicate BLAS descriptor in incremental scene: ${blas.id}`);
      const built = buildSahBvh({ vertices: blas.vertices, indices: blas.indices }, options.sah);
      const nodeBytes = serialize(built);
      this.segments.set(blas, { blas, nodeBytes, order: built.order,
        triangleCount: built.order.length, vertexCount: blas.vertices.length / 3,
        rootBounds: built.nodes[0] === undefined ? undefined
          : { minX: built.nodes[0].minX, minY: built.nodes[0].minY, minZ: built.nodes[0].minZ,
            maxX: built.nodes[0].maxX, maxY: built.nodes[0].maxY, maxZ: built.nodes[0].maxZ } });
      this.bases.set(blas, { nodeBase: nodeCursor, triangleBase: triangleCursor, vertexBase: vertexCursor });
      nodeCursor += nodeBytes.byteLength / stride;
      triangleCursor += built.order.length;
      vertexCursor += blas.vertices.length / 3;
    }
    this.blasNodeCount = nodeCursor;
    this.triangleCount = triangleCursor;
    this.blasSegmentBytes = concatSegments([...this.segments.values()].map(s => s.nodeBytes));
    this.blasVertices = new Float32Array(vertexCursor * 3);
    this.blasIndices = new Uint32Array(triangleCursor * 3);
    for (const blas of blasList) {
      const base = this.bases.get(blas)!;
      this.blasVertices.set(blas.vertices, base.vertexBase * 3);
      for (let i = 0; i < blas.indices.length; i++) {
        this.blasIndices[base.triangleBase * 3 + i] = base.vertexBase + blas.indices[i]!;
      }
    }
    this.current = this.emptyPacked();
  }

  /** 实例层更新：只重写 TLAS 节点段 + 实例记录（BLAS 段/顶点/索引/段基址不动）。 */
  updateInstances(instances: readonly TlasInstanceDescriptor[]): TlasPackedScene {
    for (const instance of instances) {
      if (!this.segments.has(instance.blas)) {
        throw new Error(`Instance ${instance.id} references BLAS outside the cached set (build a new scene).`);
      }
    }
    const instanceBounds = instances.map((instance): TlasInstanceBounds | undefined => {
      const segment = this.segments.get(instance.blas)!;
      const root = segment.rootBounds;
      if (root === undefined) return undefined; // 空 BLAS 不参与实例盒（tlas.buildTlas 同口径）。
      const localToWorld = invertAffine3x4(instance.worldToLocal);
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const x of [root.minX, root.maxX]) for (const y of [root.minY, root.maxY]) for (const z of [root.minZ, root.maxZ]) {
        const cx = localToWorld[0]! * x + localToWorld[1]! * y + localToWorld[2]! * z + localToWorld[3]!;
        const cy = localToWorld[4]! * x + localToWorld[5]! * y + localToWorld[6]! * z + localToWorld[7]!;
        const cz = localToWorld[8]! * x + localToWorld[9]! * y + localToWorld[10]! * z + localToWorld[11]!;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        if (cz < minZ) minZ = cz; if (cz > maxZ) maxZ = cz;
      }
      return { minX: Math.fround(minX), minY: Math.fround(minY), minZ: Math.fround(minZ),
        maxX: Math.fround(maxX), maxY: Math.fround(maxY), maxZ: Math.fround(maxZ) };
    });
    const built = buildTlasFromWorldBounds(instances, instanceBounds);
    const tlasNodeBytes = this.nodeFormat === "f16" ? serializeBvhNodesF16(built) : serializeBvhNodes(built);
    const recordBytes = new ArrayBuffer(built.order.length * 128);
    const recordFloats = new Float32Array(recordBytes);
    const recordWords = new Uint32Array(recordBytes);
    const vertices = this.blasVertices.slice();
    const indices = this.blasIndices.slice();
    const order = new Uint32Array(this.triangleCount);
    const placements: TlasBlasPlacement[] = [];
    built.order.forEach((instanceIndex, slot) => {
      const instance = instances[instanceIndex]!;
      const segment = this.segments.get(instance.blas)!;
      const base = this.bases.get(instance.blas)!;
      const bounds = instanceBounds[instanceIndex];
      if (bounds === undefined) throw new Error(`TLAS order references empty BLAS instance ${instance.id}.`);
      writeInstanceRecord(recordFloats, recordWords, slot, instance, bounds,
        base.nodeBase, base.triangleBase, instanceIndex);
      for (let local = 0; local < segment.order.length; local++) {
        order[base.triangleBase + local] = base.triangleBase + segment.order[local]!;
      }
      placements.push({ instanceIndex, mask: instance.mask >>> 0, worldToLocal: instance.worldToLocal,
        minX: bounds.minX, minY: bounds.minY, minZ: bounds.minZ, maxX: bounds.maxX, maxY: bounds.maxY, maxZ: bounds.maxZ,
        nodeBase: base.nodeBase, triangleBase: base.triangleBase, vertexBase: base.vertexBase,
        triangleCount: segment.triangleCount });
    });
    this.tlasRebuilds++;
    this.lastRewrittenBytes = tlasNodeBytes.byteLength + recordBytes.byteLength;
    this.current = {
      instanceCount: built.order.length, tlasNodeCount: built.nodes.length, blasNodeCount: this.blasNodeCount,
      triangleCount: this.triangleCount, recordBytes, nodeBytes: concatSegments([tlasNodeBytes, this.blasSegmentBytes]),
      vertices, indices, order, placements,
    };
    return this.current;
  }

  get packed(): TlasPackedScene { return this.current; }
  get stats(): IncrementalTlasStats {
    return { blasBuilds: this.segments.size, tlasRebuilds: this.tlasRebuilds,
      lastRewrittenBytes: this.lastRewrittenBytes };
  }

  private emptyPacked(): TlasPackedScene {
    return { instanceCount: 0, tlasNodeCount: 0, blasNodeCount: this.blasNodeCount, triangleCount: this.triangleCount,
      recordBytes: new ArrayBuffer(0), nodeBytes: this.blasSegmentBytes.slice(0),
      vertices: this.blasVertices.slice(), indices: this.blasIndices.slice(),
      order: new Uint32Array(this.triangleCount), placements: [] };
  }
}

function writeInstanceRecord(floats: Float32Array, words: Uint32Array, slot: number,
  instance: TlasInstanceDescriptor, bounds: TlasInstanceBounds, nodeBase: number, triangleBase: number,
  instanceIndex: number): void {
  const base = slot * 32; // 128B = 32 words（tlasLayout 合同）。
  floats[base] = bounds.minX; floats[base + 1] = bounds.minY; floats[base + 2] = bounds.minZ;
  floats[base + 4] = bounds.maxX; floats[base + 5] = bounds.maxY; floats[base + 6] = bounds.maxZ;
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 4; column++) {
      floats[base + 8 + row * 4 + column] = instance.worldToLocal[row * 4 + column]!;
    }
  }
  words[base + 20] = instanceIndex;
  words[base + 21] = instance.mask >>> 0;
  words[base + 22] = nodeBase;
  words[base + 23] = triangleBase;
}

function concatSegments(segments: readonly ArrayBuffer[]): ArrayBuffer {
  const total = segments.reduce((sum, s) => sum + s.byteLength, 0);
  const out = new ArrayBuffer(total);
  let cursor = 0;
  for (const segment of segments) {
    new Uint8Array(out).set(new Uint8Array(segment), cursor);
    cursor += segment.byteLength;
  }
  return out;
}
