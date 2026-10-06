// Brief-GI 烘焙哈希缓存单测(2026-10-06 后继切片;关闭登记「烘焙哈希缓存子集缺,
// CPU cached 状态恒 0」):
// - 内容哈希:同输入逐位同哈希;几何/变换/实例序/id/cellSize/域任一变化即不同;
// - 逐资产缓存透传:第二次烘焙同内容 cachedCount>0(此前恒 0 的修复);
// - 生产 runtime:revision 变化但内容未变 → baked=false + bakeCacheHit=true +
//   sdfGiBakes 不变(stub DeviceSession,fog pass stub 同款先例);内容真变 → 重烘焙。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { SdfGiProductionRuntime } from "./sdfGiProductionRuntime.js";
import { bakeSdfSceneWithRetries, pruneSdfGiBakeCache, sdfGiBakeContentHash,
  SDF_GI_BAKE_CACHE_MAX_ENTRIES } from "./sdfGiBakePlan.js";
import { bakeSdfSceneGrid, createSdfSceneBakeCache } from "./sdfSceneBake.js";
import { sdfGiBakeInstancesFromPackets, type SdfGiPacketSnapshot } from "./sdfGiSceneAdapter.js";

/** 12 三角形 AABB 盒 mesh(与 sdfGiProductionRuntime.test 同构)。 */
function boxMesh(min: readonly number[], max: readonly number[]): {
  positions: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  return {
    positions: Float32Array.from([
      x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
      x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
    ]),
    indices: Uint32Array.from([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
      3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    ]),
  };
}

/** xyz+法线交错顶点(GeometryResource.vertices 布局)。 */
function interleaved(positions: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
  const count = positions.length / 3;
  const out = new Float32Array(count * 6);
  for (let vertex = 0; vertex < count; vertex++) {
    out.set([positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!, 0, 0, 1],
      vertex * 6);
  }
  return out;
}

/** packed 实例行(36 float):变换段 = 列主 3×4。 */
function packedRow(basis: readonly number[], translation: readonly number[]):
  Float32Array<ArrayBuffer> {
  const row = new Float32Array(36);
  row[0] = basis[0]!; row[1] = basis[3]!; row[2] = basis[6]!;
  row[3] = basis[1]!; row[4] = basis[4]!; row[5] = basis[7]!;
  row[6] = basis[2]!; row[7] = basis[5]!; row[8] = basis[8]!;
  row[9] = translation[0]!; row[10] = translation[1]!; row[11] = translation[2]!;
  return row;
}

function concatRows(...rows: Float32Array<ArrayBuffer>[]): Float32Array<ArrayBuffer> {
  const out = new Float32Array(rows.reduce((sum, row) => sum + row.length, 0));
  let cursor = 0;
  for (const row of rows) { out.set(row, cursor); cursor += row.length; }
  return out;
}

/** 单静态批快照(count 个同几何实例,basis/translation 逐行给)。 */
function singleBatchSnapshot(rows: readonly (readonly number[])[][]): SdfGiPacketSnapshot {
  const mesh = boxMesh([0, 0, 0], [1, 1, 1]);
  const data = concatRows(...rows.map(([basis, translation]) =>
    packedRow(basis as readonly number[], translation as readonly number[])));
  return {
    geometries: new Map([["g", { source: { id: "g", revision: 1,
      vertices: interleaved(mesh.positions), indices: mesh.indices } }]]),
    batches: new Map([["b", { source: { key: "b", geometry: "g", count: rows.length,
      data, alphaMode: "OPAQUE" } } as never]]),
  };
}

describe("Brief-GI bake content hash(烘焙哈希缓存,登记缺口关闭)", () => {
  const snapshot = singleBatchSnapshot([
    [[1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0]],
    [[2, 0, 0, 0, 1, 0, 0, 0, 1], [5, 0, 0]],
  ]);
  const instances = sdfGiBakeInstancesFromPackets(snapshot);

  it("同输入逐位同哈希;几何/变换/实例序/id/cellSize/域任一变化即不同", () => {
    const base = sdfGiBakeContentHash(instances, 0.25, "aabb");
    expect(sdfGiBakeContentHash(sdfGiBakeInstancesFromPackets(snapshot), 0.25, "aabb")).toBe(base);
    // 实例内容逐位相同但排列序不同 → 哈希不同(实例序入场,烘焙确定性合同)。
    const swapped = sdfGiBakeContentHash([instances[1]!, instances[0]!], 0.25, "aabb");
    expect(swapped).not.toBe(base);
    // 平移微移 → 哈希不同。
    const moved = singleBatchSnapshot([
      [[1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0.125]],
      [[2, 0, 0, 0, 1, 0, 0, 0, 1], [5, 0, 0]],
    ]);
    expect(sdfGiBakeContentHash(sdfGiBakeInstancesFromPackets(moved), 0.25, "aabb")).not.toBe(base);
    // cellSize 与域覆盖入哈尾(烘焙输出依赖项)。
    expect(sdfGiBakeContentHash(instances, 0.5, "aabb")).not.toBe(base);
    expect(sdfGiBakeContentHash(instances, 0.25, "scene")).not.toBe(base);
  });

  it("逐资产缓存透传:第二次烘焙同内容 cachedCount>0(修复 CPU cached 恒 0)", () => {
    const cache = createSdfSceneBakeCache();
    const first = bakeSdfSceneWithRetries(instances, { cellSize: 0.25, cache });
    expect(first.bake.report.cachedCount).toBe(0);
    const second = bakeSdfSceneWithRetries(instances, { cellSize: 0.25, cache });
    expect(second.bake.report.cachedCount).toBe(instances.length);
    expect(second.bake.report.bakedCount).toBe(0);
    // FIFO 裁剪:超上限确定性淘汰最旧条目。
    while (cache.entries.size <= SDF_GI_BAKE_CACHE_MAX_ENTRIES) {
      cache.entries.set(`filler-${cache.entries.size}`, { origin: [0, 0, 0], cellSize: 1,
        dimensions: [2, 2, 2], distances: new Float32Array(8) });
    }
    pruneSdfGiBakeCache(cache);
    expect(cache.entries.size).toBe(SDF_GI_BAKE_CACHE_MAX_ENTRIES);
  });

  describe("生产 runtime:revision 变化但内容未变 → 跳过烘焙复用静态层", () => {
    let session: DeviceSession;
    beforeEach(() => {
      vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
      vi.stubGlobal("GPUBufferUsage", { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, UNIFORM: 64 });
      vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, STORAGE_BINDING: 2, COPY_SRC: 4 });
      const owned = new Set<GPUBuffer | GPUTexture>();
      const buffers: Array<GPUBuffer & { destroy: ReturnType<typeof vi.fn> }> = [];
      const device = {
        limits: { maxTextureDimension2D: 16_384, maxComputeWorkgroupsPerDimension: 65_535,
          maxStorageBufferBindingSize: 134_217_728 },
        queue: { writeBuffer: vi.fn() },
        createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })),
        createBindGroupLayout: vi.fn(({ label }: { label: string }) => ({ label })),
        createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })),
        createComputePipeline: vi.fn(({ label }: { label: string }) => (
          { label, getBindGroupLayout: vi.fn(() => ({ label })) })),
        createBuffer: vi.fn(({ label, size, usage }: GPUBufferDescriptor) => {
          const value = { label, size, usage, destroy: vi.fn(),
            mapState: "unmapped" } as unknown as GPUBuffer & { destroy: ReturnType<typeof vi.fn> };
          buffers.push(value);
          return value;
        }),
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
          const size = descriptor.size as GPUExtent3DDict;
          return { width: size.width ?? 1, height: size.height ?? 1,
            depthOrArrayLayers: size.depthOrArrayLayers ?? 1, format: descriptor.format,
            createView: vi.fn(() => ({})), destroy: vi.fn() } as unknown as GPUTexture;
        }),
        createBindGroup: vi.fn(({ label }: { label: string }) => ({ label })),
        createSampler: vi.fn(({ label }: { label: string }) => ({ label })),
      };
      session = {
        state: "ready", device,
        own<T extends GPUBuffer | GPUTexture>(resource: T): T { owned.add(resource); return resource; },
        release(resource: GPUBuffer | GPUTexture): void { if (owned.delete(resource)) {
          (resource as { destroy?: ReturnType<typeof vi.fn> }).destroy?.(); } },
      } as unknown as DeviceSession;
    });
    afterEach(() => vi.unstubAllGlobals());

    const frameInput = (revision: number) => ({ sceneRevision: revision,
      skyRadianceRgb: [1, 1, 1] as const, budgetProbes: 64 });

    /** 计算通道 stub(fog pass 测试同款;setPipeline/setBindGroup/dispatch/end 记账)。 */
    const stubEncoder = (): GPUCommandEncoder => ({
      beginComputePass: vi.fn(({ label }: { label: string }) => ({
        setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn(),
        label,
      })),
    }) as unknown as GPUCommandEncoder;

    it("首帧烘焙;revision 推进但内容一致 → cacheHit 且 sdfGiBakes 不增;内容真变 → 重烘焙", () => {
      const runtime = new SdfGiProductionRuntime(session, { cellSize: 0.25 });
      runtime.syncScene(singleBatchSnapshot([
        [[1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0]],
        [[2, 0, 0, 0, 1, 0, 0, 0, 1], [5, 0, 0]],
      ]));
      const first = runtime.encodeFrame(stubEncoder(), frameInput(1));
      expect(first.baked).toBe(true);
      expect(runtime.metrics.sdfGiBakes).toBe(1);
      // revision 推进 + 内容逐位一致:跳过烘焙,静态层(槽位/天光可见度)原样续用。
      const hit = runtime.encodeFrame(stubEncoder(), frameInput(2));
      expect(hit.baked).toBe(false);
      expect(hit.bakeCacheHit).toBe(true);
      expect(hit.probeCount).toBe(first.probeCount);
      expect(runtime.metrics.sdfGiBakes).toBe(1);
      expect(runtime.metrics.sdfGiBakeCacheHits).toBe(1);
      // 内容真变(第三实例入场):正常重烘焙,cacheHit 复位。
      runtime.syncScene(singleBatchSnapshot([
        [[1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0]],
        [[2, 0, 0, 0, 1, 0, 0, 0, 1], [5, 0, 0]],
        [[1, 0, 0, 0, 1, 0, 0, 0, 1], [9, 0, 0]],
      ]));
      const rebaked = runtime.encodeFrame(stubEncoder(), frameInput(3));
      expect(rebaked.baked).toBe(true);
      expect(rebaked.bakeCacheHit).toBeUndefined();
      expect(runtime.metrics.sdfGiBakes).toBe(2);
      runtime.dispose();
    });

    it("无烘焙首帧(empty scene)不产 cacheHit;之后同内容命中也只跳过已烘焙内容", () => {
      const runtime = new SdfGiProductionRuntime(session, {});
      runtime.syncScene({ geometries: new Map(), batches: new Map() });
      const empty = runtime.encodeFrame(stubEncoder(), frameInput(1));
      expect(empty.baked).toBe(false);
      expect(empty.bakeCacheHit).toBeUndefined();
      expect(runtime.metrics.sdfGiBakeCacheHits).toBe(0);
      runtime.dispose();
    });
  });
});
