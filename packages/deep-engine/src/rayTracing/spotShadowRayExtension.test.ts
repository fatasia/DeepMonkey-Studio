import { describe, expect, it } from "vitest";
import type { RayBatchQuery } from "./rayBackendTypes.js";
import { HIT_STATUS, RAY_RECORD_WORDS } from "./rayTraceLayout.js";
import { RayTraceGpuTlasExecutor } from "./rayTraceTlasExecutor.js";
import { buildTlas, traceTlasClosest, type TlasBuildResult } from "./tlas.js";
import { packTlasScene, TLAS_INSTANCE_SENTINEL } from "./tlasLayout.js";
import { baselineSpotShadowVisibility, buildSpotShadowRayExtensionBatch,
  collectSpotShadowRayExtensionCandidates, composeSpotShadowRayVisibility,
  resolveSpotShadowRayExtensionOptions, SPOT_SHADOW_RAY_EXTENSION_MAX_RAYS_PER_FRAME,
  spotShadowVisibilityWithRayExtension, type SpotShadowRayExtensionBatchResult,
  type SpotShadowRayExtensionExecutor, type SpotShadowRayExtensionOptions,
  type SpotShadowRayExtensionPoint } from "./spotShadowRayExtension.js";

const LIGHT = { x: 0, y: 4, z: 0, radius: 0.5 };
const EXTENSION: SpotShadowRayExtensionOptions = { enabled: true, light: LIGHT };
const point = (x: number, y: number, z: number, nx: number, ny: number, nz: number, v: number): SpotShadowRayExtensionPoint =>
  ({ worldX: x, worldY: y, worldZ: z, normalX: nx, normalY: ny, normalZ: nz, pcssVisibility: v });

class RecordingExecutor implements SpotShadowRayExtensionExecutor {
  calls = 0;
  lastQuery: RayBatchQuery | undefined;
  constructor(private readonly respond: (query: RayBatchQuery) => Promise<SpotShadowRayExtensionBatchResult>) {}
  traceBatch(query: RayBatchQuery): Promise<SpotShadowRayExtensionBatchResult> {
    this.calls += 1; this.lastQuery = query; return this.respond(query);
  }
}
const occludeAll = (): RecordingExecutor => new RecordingExecutor(async (query) => ({ hits: Array.from({ length: query.tMax.length }, () => ({ t: 1 })) }));
const revealAll = (): RecordingExecutor => new RecordingExecutor(async (query) => ({ hits: Array.from({ length: query.tMax.length }, () => undefined) }));

describe("resolveSpotShadowRayExtensionOptions", () => {
  it("applies defaults and clamps the frame budget to the hard limit", () => {
    expect(resolveSpotShadowRayExtensionOptions(EXTENSION)).toMatchObject({ samplesPerPixel: 4,
      normalOffset: 1e-3, occluderMask: 0xffff_ffff, penumbraMin: 0, penumbraMax: 1, stride: 1,
      maxRaysPerFrame: SPOT_SHADOW_RAY_EXTENSION_MAX_RAYS_PER_FRAME });
    expect(resolveSpotShadowRayExtensionOptions({ ...EXTENSION, maxRaysPerFrame: 20000 }).maxRaysPerFrame)
      .toBe(SPOT_SHADOW_RAY_EXTENSION_MAX_RAYS_PER_FRAME);
    expect(resolveSpotShadowRayExtensionOptions({ ...EXTENSION, samplesPerPixel: 2 }).samplesPerPixel).toBe(2);
  });
  it("fails fast on contract violations (light, samples, offset, mask, penumbra, budget, stride)", () => {
    const light = { x: Number.NaN, y: 0, z: 0, radius: 0 };
    expect(() => resolveSpotShadowRayExtensionOptions({ ...EXTENSION, light })).toThrow(/light/);
    expect(() => resolveSpotShadowRayExtensionOptions({ ...EXTENSION, light: { ...LIGHT, radius: -1 } })).toThrow(/radius/);
    expect(() => resolveSpotShadowRayExtensionOptions({ ...EXTENSION, samplesPerPixel: 0 })).toThrow(/samplesPerPixel/);
    expect(() => resolveSpotShadowRayExtensionOptions({ ...EXTENSION, samplesPerPixel: 9 })).toThrow(/samplesPerPixel/);
    expect(() => resolveSpotShadowRayExtensionOptions({ ...EXTENSION, normalOffset: -1 })).toThrow(/normalOffset/);
    expect(() => resolveSpotShadowRayExtensionOptions({ ...EXTENSION, occluderMask: -1 })).toThrow(/occluderMask/);
    expect(() => resolveSpotShadowRayExtensionOptions({ ...EXTENSION, occluderMask: 0x1_0000_0000 })).toThrow(/occluderMask/);
    expect(() => resolveSpotShadowRayExtensionOptions({ ...EXTENSION, penumbraMin: 0.6, penumbraMax: 0.6 })).toThrow(/penumbra/);
    expect(() => resolveSpotShadowRayExtensionOptions({ ...EXTENSION, penumbraMax: 1.5 })).toThrow(/penumbra/);
    expect(() => resolveSpotShadowRayExtensionOptions({ ...EXTENSION, maxRaysPerFrame: -1 })).toThrow(/maxRaysPerFrame/);
    expect(() => resolveSpotShadowRayExtensionOptions({ ...EXTENSION, stride: 0 })).toThrow(/stride/);
  });
});

describe("collectSpotShadowRayExtensionCandidates", () => {
  it("keeps exactly the open penumbra band (endpoints 0 and 1 stay on PCSS)", () => {
    const points = [0, 0.25, 0.5, 0.75, 1].map((v) => point(0, 0, 0, 0, 1, 0, v));
    const { candidates, penumbraPixels } = collectSpotShadowRayExtensionCandidates(points,
      resolveSpotShadowRayExtensionOptions(EXTENSION));
    expect(penumbraPixels).toBe(3);
    expect(candidates.map((candidate) => candidate.index)).toEqual([1, 2, 3]);
    for (const candidate of candidates) expect(candidate.samples).toHaveLength(4);
  });
  it("skips degenerate shading points sitting on the light surface (no ray to fire)", () => {
    // normalOffset=0 才会让原点贴光面（默认 1e-3 会把原点推离光源，非退化）。
    const zero = resolveSpotShadowRayExtensionOptions({ ...EXTENSION, light: { ...LIGHT, radius: 0 }, normalOffset: 0 });
    const { candidates, penumbraPixels } = collectSpotShadowRayExtensionCandidates(
      [point(0, 4, 0, 0, 1, 0, 0.5), point(0, 0, 0, 0, 1, 0, 0.5)], zero);
    expect(penumbraPixels).toBe(2);
    expect(candidates.map((candidate) => candidate.index)).toEqual([1]);
  });
  it("honours the stride gate over the penumbra ordinal sequence", () => {
    const points = [0.2, 0.4, 0.6, 0.8].map((v) => point(0, 0, 0, 0, 1, 0, v));
    const strided = collectSpotShadowRayExtensionCandidates(points,
      resolveSpotShadowRayExtensionOptions({ ...EXTENSION, stride: 2 }));
    expect(strided.penumbraPixels).toBe(4);
    expect(strided.candidates.map((candidate) => candidate.index)).toEqual([0, 2]);
  });
});

describe("ray construction (via collect + batch)", () => {
  const resolved = (over: Partial<SpotShadowRayExtensionOptions> = {}) =>
    resolveSpotShadowRayExtensionOptions({ ...EXTENSION, ...over });
  it("offsets the origin along the normal and aims unit directions at the light with shrunk tMax", () => {
    const zero = resolveSpotShadowRayExtensionOptions({ ...EXTENSION, light: { x: 4, y: 2, z: 3, radius: 0 },
      normalOffset: 0.5 });
    const { candidates } = collectSpotShadowRayExtensionCandidates([point(1, 2, 3, 0, 1, 0, 0.5)], zero);
    const candidate = candidates[0]!;
    expect([candidate.originX, candidate.originY, candidate.originZ]).toEqual([1, 2.5, 3]);
    const dist = Math.hypot(3, -0.5, 0);
    expect(candidate.samples).toHaveLength(4); // 点光：4 个采样同一方向。
    for (const sample of candidate.samples) {
      expect([sample.dirX, sample.dirY, sample.dirZ]).toEqual([3 / dist, -0.5 / dist, 0]);
      expect(sample.dist).toBeCloseTo(dist, 12);
    }
    const batch = buildSpotShadowRayExtensionBatch(candidates, zero);
    // tMax 经 Float32Array 承载（f32 存储舍入），期望值须过 Math.fround。
    expect(batch.query.tMax[0]).toBe(Math.fround(dist * (1 - 1e-4)));
    expect(batch.query.mask).toBe(0xffff_ffff);
  });
  it("samples the light surface deterministically inside the light radius", () => {
    const { candidates } = collectSpotShadowRayExtensionCandidates([point(0, 0, 0, 0, 1, 0, 0.5)], resolved());
    const candidate = candidates[0]!;
    const directions = new Set(candidate.samples.map((sample) => `${sample.dirX},${sample.dirY},${sample.dirZ}`));
    expect(directions.size).toBe(4); // 面光：4 个采样方向互异。
    for (const sample of candidate.samples) {
      expect(Math.hypot(sample.dirX, sample.dirY, sample.dirZ)).toBeCloseTo(1, 12);
      const endpoint = [candidate.originX + sample.dirX * sample.dist,
        candidate.originY + sample.dirY * sample.dist, candidate.originZ + sample.dirZ * sample.dist];
      expect(Math.hypot(endpoint[0]! - LIGHT.x, endpoint[1]! - LIGHT.y, endpoint[2]! - LIGHT.z))
        .toBeLessThanOrEqual(LIGHT.radius + 1e-9);
    }
    const again = collectSpotShadowRayExtensionCandidates([point(0, 0, 0, 0, 1, 0, 0.5)], resolved());
    expect(JSON.stringify(again.candidates)).toBe(JSON.stringify(candidates));
  });
});

describe("buildSpotShadowRayExtensionBatch", () => {
  const resolved = resolveSpotShadowRayExtensionOptions(EXTENSION);
  const candidates = [0.25, 0.5, 0.75].map((v, index) => ({ index, originX: index, originY: 0, originZ: 0,
    samples: [0, 1, 2, 3].map((ordinal) => ({ dirX: ordinal + 1, dirY: 0, dirZ: 0, dist: 4 + ordinal })) }));
  it("flattens candidate-major, repeats origins per sample and passes the occluder mask through", () => {
    const masked = resolveSpotShadowRayExtensionOptions({ ...EXTENSION, occluderMask: 0x2 });
    const batch = buildSpotShadowRayExtensionBatch(candidates.slice(0, 2), masked);
    expect(batch.query.tMax.length).toBe(8);
    expect(batch.query.mask).toBe(0x2);
    expect([...batch.query.origins]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]);
    expect([...batch.query.directions].slice(0, 8)).toEqual([1, 0, 0, 2, 0, 0, 3, 0]);
    expect([...batch.query.tMax].slice(4, 6))
      .toEqual([Math.fround(4 * (1 - 1e-4)), Math.fround(5 * (1 - 1e-4))]); // 候选 1 样本 dist 4,5。
    expect(batch.clamped).toBe(false);
  });
  it("clamps the dispatch to the ray budget and flags the downgrade (including zero-ray frames)", () => {
    const clamped = buildSpotShadowRayExtensionBatch(candidates,
      resolveSpotShadowRayExtensionOptions({ ...EXTENSION, maxRaysPerFrame: 8 }));
    expect(clamped.query.tMax.length).toBe(8);
    expect(clamped.dispatched).toHaveLength(2);
    expect(clamped.clamped).toBe(true);
    const empty = buildSpotShadowRayExtensionBatch(candidates,
      resolveSpotShadowRayExtensionOptions({ ...EXTENSION, maxRaysPerFrame: 3 }));
    expect(empty.query.tMax.length).toBe(0);
    expect(empty.dispatched).toHaveLength(0);
    expect(empty.clamped).toBe(true);
  });
});

describe("composeSpotShadowRayVisibility", () => {
  it("counts misses as visible, keeps non-dispatched points at the PCSS baseline bit-exactly", () => {
    const points = [point(0, 0, 0, 0, 1, 0, 0.1), point(1, 0, 0, 0, 1, 0, 0.3)];
    const candidate = { index: 0, originX: 0, originY: 0, originZ: 0,
      samples: [0, 1, 2, 3].map(() => ({ dirX: 0, dirY: 1, dirZ: 0, dist: 4 })) };
    const { visibility, replacedPixels } = composeSpotShadowRayVisibility(points, [candidate], 4,
      [undefined, undefined, { t: 2 }, { t: 3 }]);
    expect(replacedPixels).toBe(1);
    expect(visibility[0]).toBe(0.5);
    expect(visibility[1]).toBe(Math.fround(0.3));
  });
});

describe("spotShadowVisibilityWithRayExtension", () => {
  const points = [point(0, 0, 0, 0, 1, 0, 0.1), point(1, 0, 0, 0, 1, 0, 0), point(2, 0, 0, 0, 1, 0, 1)];
  it("is bit-identical to the PCSS baseline when the switch is off (executor untouched)", async () => {
    const executor = occludeAll();
    const result = await spotShadowVisibilityWithRayExtension(points, { ...EXTENSION, enabled: false }, executor);
    expect(result.extension).toMatchObject({ enabled: false, dispatchedRays: 0, replacedPixels: 0 });
    expect([...result.visibility]).toEqual([...baselineSpotShadowVisibility(points)]);
    expect(result.visibility[0]).toBe(Math.fround(0.1));
    expect(executor.calls).toBe(0);
  });
  it("replaces penumbra pixels with occlusion results and leaves band endpoints on PCSS", async () => {
    const executor = occludeAll();
    const result = await spotShadowVisibilityWithRayExtension(points, EXTENSION, executor);
    expect(executor.calls).toBe(1);
    expect(executor.lastQuery!.tMax.length).toBe(4);
    expect(executor.lastQuery!.mask).toBe(0xffff_ffff);
    expect(result.extension).toMatchObject({ enabled: true, penumbraPixels: 1, candidates: 1,
      dispatchedRays: 4, samplesPerPixel: 4, replacedPixels: 1, budgetClamped: false });
    expect(result.visibility[0]).toBe(0);
    expect(result.visibility[1]).toBe(0);
    expect(result.visibility[2]).toBe(1);
    expect(result.extension.degradedReason).toBeUndefined();
    const revealed = await spotShadowVisibilityWithRayExtension(points, EXTENSION, revealAll());
    expect(revealed.visibility[0]).toBe(1);
  });
  it("downgrades beyond the per-frame budget and keeps excess pixels on PCSS", async () => {
    const many = [0.2, 0.4, 0.6].map((v) => point(0, 0, 0, 0, 1, 0, v));
    const result = await spotShadowVisibilityWithRayExtension(many,
      { ...EXTENSION, maxRaysPerFrame: 8 }, occludeAll());
    expect(result.extension).toMatchObject({ dispatchedRays: 8, budgetClamped: true, replacedPixels: 2 });
    expect(result.visibility[2]).toBe(Math.fround(0.6));
  });
  it("falls back to the untouched PCSS baseline when the executor fails", async () => {
    const baseline = baselineSpotShadowVisibility(points);
    const failing = new RecordingExecutor(async () => {
      throw new Error("Two-level ray trace stack overflow (capacity 32) on 3 ray(s); batch rejected (fail-closed).");
    });
    const result = await spotShadowVisibilityWithRayExtension(points, EXTENSION, failing);
    expect(result.extension.degradedReason).toMatch(/stack overflow/);
    expect(result.extension.dispatchedRays).toBe(4);
    expect(result.extension.replacedPixels).toBe(0);
    expect([...result.visibility]).toEqual([...baseline]);
  });
});

describe("end to end through RayTraceGpuTlasExecutor (stub device)", () => {
  class StubBuffer {
    readonly data: Uint8Array;
    constructor(readonly label: string, readonly size: number) { this.data = new Uint8Array(size); }
    mapAsync(): Promise<void> { return Promise.resolve(); }
    getMappedRange(): ArrayBuffer { return this.data.buffer; }
    unmap(): void {} destroy(): void {}
  }
  function stubDevice(state: { tlas: TlasBuildResult; rayCount: number; mask: number }): GPUDevice {
    const buffers = new Map<string, StubBuffer>();
    const copies: Array<[StubBuffer, StubBuffer, number]> = [];
    const stub = (buffer: GPUBuffer): StubBuffer => buffers.get((buffer as unknown as StubBuffer).label)!;
    return {
      pushErrorScope(): void {}, popErrorScope: () => Promise.resolve(null),
      createShaderModule: ({ code }) => ({ code }) as GPUShaderModule,
      createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }) as unknown as GPUComputePipeline,
      createBindGroup: ({ entries }) => ({ entries }) as unknown as GPUBindGroup,
      createBuffer: ({ label, size }) => {
        const buffer = new StubBuffer(label, size); buffers.set(label, buffer); return buffer as unknown as GPUBuffer; },
      createCommandEncoder: () => ({
        beginComputePass: () => ({ setPipeline(): void {}, setBindGroup(): void {},
          dispatchWorkgroups(): void {}, end(): void {} }) as unknown as GPUComputePassEncoder,
        copyBufferToBuffer: (source: GPUBuffer, sOff: number, destination: GPUBuffer, dOff: number, size: number) => {
          copies.push([stub(source), stub(destination), size]);
          new Uint8Array(stub(destination).data.buffer, dOff, size).set(new Uint8Array(stub(source).data.buffer, sOff, size));
        },
        finish: () => ({}) as GPUCommandBuffer,
      }) as unknown as GPUCommandEncoder,
      queue: {
        writeBuffer: (buffer: GPUBuffer, offset: number, data: ArrayBufferView | ArrayBuffer, dataOffset = 0, size?: number): void => {
          const target = stub(buffer);
          const elementBytes = "BYTES_PER_ELEMENT" in data ? data.BYTES_PER_ELEMENT : 1;
          const bytes = "BYTES_PER_ELEMENT" in data
            ? new Uint8Array(data.buffer, data.byteOffset + dataOffset * elementBytes,
              (size ?? data.byteLength / elementBytes - dataOffset) * elementBytes)
            : new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset);
          target.data.set(bytes, offset);
          if (target.label === "rt-tlas-uniform") {
            const words = new Uint32Array(target.data.buffer);
            state.rayCount = words[0]!; state.mask = words[1]!;
          }
        },
        submit: () => {
          const rays = new Float32Array(buffers.get("rt-tlas-rays")!.data.buffer);
          const hitFloats = new Float32Array(buffers.get("rt-tlas-hits")!.data.buffer);
          const hitWords = new Uint32Array(buffers.get("rt-tlas-hits")!.data.buffer);
          const triangleBase = packTlasScene(state.tlas).placements[0]!.triangleBase;
          for (let index = 0; index < state.rayCount; index++) {
            const base = index * RAY_RECORD_WORDS;
            const hit = traceTlasClosest(state.tlas, { ox: rays[base]!, oy: rays[base + 1]!, oz: rays[base + 2]!,
              dx: rays[base + 4]!, dy: rays[base + 5]!, dz: rays[base + 6]!, tMax: rays[base + 3]! }, state.mask);
            hitFloats[index * 4] = hit ? Math.fround(hit.t) : -1;
            hitWords[index * 4 + 1] = hit ? triangleBase + hit.primitiveIndex : 0xffff_ffff;
            hitWords[index * 4 + 2] = hit ? HIT_STATUS.hit : HIT_STATUS.miss;
            hitWords[index * 4 + 3] = hit ? 0 : TLAS_INSTANCE_SENTINEL;
          }
          new Uint32Array(buffers.get("rt-tlas-overflows")!.data.buffer)[0] = 0;
          for (const [source, destination, size] of copies) {
            new Uint8Array(destination.data.buffer).set(new Uint8Array(source.data.buffer, 0, size));
          }
        },
      } as unknown as GPUQueue,
    } as unknown as GPUDevice;
  }
  /** 世界空间遮挡体：y=2 处 4x4 四边形（identity 变换），位于 y=0 着色点与 y=4 光源之间。 */
  function occluderTlas(): TlasBuildResult {
    return buildTlas([{ id: "penumbra-occluder", mask: 1, worldToLocal: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
      blas: { id: "occluder-quad", vertices: new Float32Array([-2, 2, -2, 2, 2, -2, 2, 2, 2, -2, 2, 2]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) } }]);
  }
  it("classifies occluded vs clear penumbra pixels through the packed TLAS path", async () => {
    const tlas = occluderTlas();
    const state = { tlas, rayCount: 0, mask: 0xffff_ffff };
    const executor = new RayTraceGpuTlasExecutor(stubDevice(state), tlas);
    const shaded = [point(0, 0, 0, 0, 1, 0, 0.5), point(10, 0, 0, 0, 1, 0, 0.5)];
    const result = await spotShadowVisibilityWithRayExtension(shaded, EXTENSION, executor);
    expect(result.extension).toMatchObject({ enabled: true, penumbraPixels: 2, candidates: 2,
      dispatchedRays: 8, replacedPixels: 2 });
    expect(result.visibility[0]).toBe(0); // 遮挡体正下方：全部采样命中 → 精确全影。
    expect(result.visibility[1]).toBe(1); // 远离遮挡体：全部采样 miss → 精确全亮。
    expect(result.extension.degradedReason).toBeUndefined();
  });
  it("filters occluder instances by the occluder mask bits (masked-out casters stop blocking)", async () => {
    const tlas = occluderTlas();
    const state = { tlas, rayCount: 0, mask: 0xffff_ffff };
    const executor = new RayTraceGpuTlasExecutor(stubDevice(state), tlas);
    const shaded = [point(0, 0, 0, 0, 1, 0, 0.5)];
    const result = await spotShadowVisibilityWithRayExtension(shaded,
      { ...EXTENSION, occluderMask: 0x2 }, executor);
    expect(state.mask).toBe(0x2);
    expect(result.visibility[0]).toBe(1); // 实例 mask=1 与查询 mask=2 无交集 → 全部可见。
    expect(result.extension.replacedPixels).toBe(1);
  });
});
