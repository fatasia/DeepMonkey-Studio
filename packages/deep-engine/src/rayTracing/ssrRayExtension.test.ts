import { describe, expect, it } from "vitest";
import { screenSpaceReflectionCpu, type ScreenSpaceReflectionCpuInput } from "../postprocess/screenSpaceReflectionCpu.js";
import type { ScreenSpaceReflectionCpuOptions } from "../postprocess/screenSpaceReflectionTypes.js";
import { buildTracedScene, traceClosest } from "./rayTrace.js";
import { RayTraceGpuExecutor, type RayTraceBatchResult } from "./rayTraceExecutor.js";
import type { RayBatchQuery, RayBlasDescriptor } from "./rayBackendTypes.js";
import { HIT_STATUS, RAY_RECORD_WORDS } from "./rayTraceLayout.js";
import { buildSsrRayExtensionBatch, collectSsrRayExtensionCandidates,
  resolveSsrRayExtensionOptions, SSR_RAY_EXTENSION_MAX_RAYS_PER_FRAME,
  screenSpaceReflectionCpuWithRayExtension, synthesizeSsrRayExtensionHits,
  type SsrRayExtensionExecutor, type SsrRayExtensionOptions } from "./ssrRayExtension.js";

const OPTIONS: ScreenSpaceReflectionCpuOptions = { verticalFovRadians: Math.PI / 3, maxDistance: 20,
  thickness: 0.5, steps: 32, refines: 4, edgeFade: 0.08, fresnelF0: 0.05 };
const IDENTITY: SsrRayExtensionOptions["viewToBlas"] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const EXTENSION = { enabled: true, albedo: [0.8, 0.6, 0.4] as const, ambient: [1, 1, 1] as const,
  tMax: 64, viewToBlas: IDENTITY };

/** 均匀深度 + 均匀视空间法线的 16x16 帧；normal 经 (v+1)/2 编码。 */
function frame(depth: number, normal: readonly [number, number, number]): ScreenSpaceReflectionCpuInput {
  const width = 16, height = 16;
  return { width, height, depth: new Array<number>(width * height).fill(depth),
    normals: new Array<number>(width * height * 3).fill(0)
      .map((_, index) => (normal[index % 3]! + 1) / 2),
    color: new Array<number>(width * height * 3).fill(0).map((_, index) => 0.1 + (index % 3) * 0.1) };
}

/** 背面失效帧：法线正对相机 → SSR 反射 z≥0 全 miss，但每个像素都有 origin 可延长。 */
const backfacingFrame = (): ScreenSpaceReflectionCpuInput => frame(5, [0, 0, 1]);

class RecordingExecutor implements SsrRayExtensionExecutor {
  calls = 0;
  lastQuery: RayBatchQuery | undefined;
  constructor(private readonly respond: (query: RayBatchQuery) => Promise<RayTraceBatchResult>) {}
  traceBatch(query: RayBatchQuery): Promise<RayTraceBatchResult> {
    this.calls += 1; this.lastQuery = query; return this.respond(query);
  }
}

const hitAll = (t: number): RecordingExecutor => new RecordingExecutor(async (query) => ({
  hits: Array.from({ length: query.tMax.length }, () => ({ t, primitiveIndex: 0 })),
  stackOverflows: 0, rawRecords: [] }));

describe("resolveSsrRayExtensionOptions", () => {
  it("applies defaults and clamps the frame budget to the hard limit", () => {
    expect(resolveSsrRayExtensionOptions(EXTENSION)).toMatchObject({ stride: 1,
      maxRaysPerFrame: SSR_RAY_EXTENSION_MAX_RAYS_PER_FRAME, tMax: 64 });
    expect(resolveSsrRayExtensionOptions({ ...EXTENSION, maxRaysPerFrame: 20000 }).maxRaysPerFrame)
      .toBe(SSR_RAY_EXTENSION_MAX_RAYS_PER_FRAME);
    expect(resolveSsrRayExtensionOptions({ ...EXTENSION, stride: 2 }).stride).toBe(2);
  });
  it("fails fast on contract violations (energy terms, transform, budget, stride)", () => {
    expect(() => resolveSsrRayExtensionOptions({ ...EXTENSION, albedo: [0.8, 1.2, 0.4] })).toThrow(/albedo/);
    expect(() => resolveSsrRayExtensionOptions({ ...EXTENSION, ambient: [1, -1, 1] })).toThrow(/ambient/);
    expect(() => resolveSsrRayExtensionOptions({ ...EXTENSION, tMax: 0 })).toThrow(/tMax/);
    expect(() => resolveSsrRayExtensionOptions({ ...EXTENSION, viewToBlas: [1, 0, 0] })).toThrow(/viewToBlas/);
    expect(() => resolveSsrRayExtensionOptions({ ...EXTENSION, maxRaysPerFrame: -1 })).toThrow(/maxRaysPerFrame/);
    expect(() => resolveSsrRayExtensionOptions({ ...EXTENSION, stride: 0 })).toThrow(/stride/);
  });
});

describe("collectSsrRayExtensionCandidates", () => {
  const resolved = resolveSsrRayExtensionOptions(EXTENSION);
  const missCount = (result: { trace: Float32Array }): number =>
    result.trace.reduce((count, value, index) => count + (index % 4 === 3 && value === 0 ? 1 : 0), 0);
  it("recognizes every extendable miss pixel and none of the SSR hits", () => {
    const backface = collectSsrRayExtensionCandidates(backfacingFrame(), OPTIONS, resolved);
    expect(backface.missedPixels).toBe(64);
    expect(backface.candidates).toHaveLength(64);
    for (const candidate of backface.candidates) {
      expect(candidate.reflectZ).toBeGreaterThan(0); // 背面失效族：反射朝相机平面之后。
      expect(candidate.originZ).toBe(-5);
      expect(Number.isFinite(candidate.reflectX + candidate.reflectY + candidate.reflectZ)).toBe(true);
    }
    // 屏幕外 / 步进耗尽族（reflectZ<0 也入选）：候选集恰等于「mask==0 且有 origin」的像素。
    const tilted = collectSsrRayExtensionCandidates(frame(5, [0, -0.447, 0.894]), OPTIONS, resolved);
    const baseline = screenSpaceReflectionCpu(frame(5, [0, -0.447, 0.894]), OPTIONS);
    expect(tilted.candidates).toHaveLength(missCount(baseline));
    expect(tilted.missedPixels).toBe(missCount(baseline));
    for (const candidate of tilted.candidates) {
      expect(baseline.trace[(candidate.halfY * tilted.traceWidth + candidate.halfX) * 4 + 3]).toBe(0);
    }
  });
  it("skips depth-less pixels (no origin to extend) and honours the stride gate", () => {
    const hole = backfacingFrame();
    // 半分辨率像素 (halfY=0) 采样全分辨率奇数行 y=1：置 y∈{0,1} 两行为深度缺失。
    for (let x = 0; x < 16; x++) { hole.depth[x] = 0; hole.depth[16 + x] = 0; }
    const collected = collectSsrRayExtensionCandidates(hole, OPTIONS, resolved);
    expect(collected.missedPixels).toBe(56);
    expect(collected.candidates).toHaveLength(56);
    expect(collectSsrRayExtensionCandidates(backfacingFrame(), OPTIONS,
      resolveSsrRayExtensionOptions({ ...EXTENSION, stride: 2 })).candidates).toHaveLength(16);
  });
});

describe("buildSsrRayExtensionBatch", () => {
  const resolved = resolveSsrRayExtensionOptions(EXTENSION);
  const candidate = { halfX: 1, halfY: 2, originX: 1, originY: -2, originZ: -5,
    reflectX: 0.5, reflectY: -0.5, reflectZ: 1, cosTheta: -0.9 };
  it("applies the view→BLAS affine to origins and (unnormalized) directions", () => {
    const scaled = resolveSsrRayExtensionOptions({ ...EXTENSION,
      viewToBlas: [2, 0, 0, 5, 0, 2, 0, 6, 0, 0, 2, 7] });
    const batch = buildSsrRayExtensionBatch([candidate], scaled);
    expect([...batch.query.origins]).toEqual([7, 2, -3]);
    expect([...batch.query.directions]).toEqual([1, -1, 2]);
    expect([...batch.query.tMax]).toEqual([64]);
    expect(batch.clamped).toBe(false);
    const unit = buildSsrRayExtensionBatch([candidate], resolved);
    expect([...unit.query.origins]).toEqual([1, -2, -5]);
    expect([...unit.query.directions]).toEqual([0.5, -0.5, 1]);
  });
  it("clamps the dispatch to the frame budget and flags the downgrade", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => ({ ...candidate, halfX: index }));
    const batch = buildSsrRayExtensionBatch(candidates,
      resolveSsrRayExtensionOptions({ ...EXTENSION, maxRaysPerFrame: 10 }));
    expect(batch.query.tMax.length).toBe(10);
    expect(batch.dispatched).toHaveLength(10);
    expect(batch.clamped).toBe(true);
  });
});

describe("synthesizeSsrRayExtensionHits", () => {
  const resolved = resolveSsrRayExtensionOptions(EXTENSION);
  it("writes albedo×ambient×(fresnel·fade) into the trace slot with SSR mask semantics", () => {
    const input = backfacingFrame();
    const { trace, traceWidth, candidates } = collectSsrRayExtensionCandidates(input, OPTIONS, resolved);
    const center = candidates.find((item) => item.halfX === 4 && item.halfY === 4)!;
    expect(synthesizeSsrRayExtensionHits(trace, traceWidth, input, OPTIONS, resolved,
      [center], [{ t: 0.5, primitiveIndex: 0 }])).toBe(1);
    const base = (4 * traceWidth + 4) * 4;
    const mask = trace[base + 3]!;
    expect(mask).toBeGreaterThan(0);
    expect(mask).toBeCloseTo(0.05, 3); // 中心像素 cosθ→1，Fresnel 收敛到 F0=0.05，边缘 fade=1。
    // trace 以 Float32Array 代理 GPU rgba16float：rgb 断言放宽到 f32 存储舍入级别（6 位）。
    expect(trace[base]!).toBeCloseTo(0.8 * mask, 6);
    expect(trace[base + 1]!).toBeCloseTo(0.6 * mask, 6);
    expect(trace[base + 2]!).toBeCloseTo(0.4 * mask, 6);
  });
  it("keeps misses and offscreen hit points on the existing fallback", () => {
    const input = backfacingFrame();
    const { trace, traceWidth, candidates } = collectSsrRayExtensionCandidates(input, OPTIONS, resolved);
    const before = Float32Array.from(trace);
    expect(synthesizeSsrRayExtensionHits(trace, traceWidth, input, OPTIONS, resolved,
      candidates, new Array(candidates.length).fill(undefined))).toBe(0);
    expect([...trace]).toEqual([...before]);
    // 背面族角落像素 t=2 的命中点飞向相机侧外：投影出屏 → 不写能量，保持 fallback。
    const corner = candidates.find((item) => item.halfX === 0 && item.halfY === 0)!;
    expect(synthesizeSsrRayExtensionHits(trace, traceWidth, input, OPTIONS, resolved,
      [corner], [{ t: 2, primitiveIndex: 0 }])).toBe(0);
  });
});

describe("screenSpaceReflectionCpuWithRayExtension", () => {
  it("is bit-identical to the SSR baseline when the switch is off (executor untouched)", async () => {
    const baseline = screenSpaceReflectionCpu(backfacingFrame(), OPTIONS);
    const executor = hitAll(0.5);
    const result = await screenSpaceReflectionCpuWithRayExtension(backfacingFrame(), OPTIONS,
      { ...EXTENSION, enabled: false }, executor);
    expect(result.extension).toMatchObject({ enabled: false, dispatchedRays: 0, hits: 0 });
    expect([...result.output]).toEqual([...baseline.output]);
    expect([...result.trace]).toEqual([...baseline.trace]);
    expect(executor.calls).toBe(0);
  });
  it("synthesizes hit energy through the stub executor and stays finite", async () => {
    const executor = hitAll(0.5);
    const result = await screenSpaceReflectionCpuWithRayExtension(backfacingFrame(), OPTIONS,
      EXTENSION, executor);
    expect(executor.calls).toBe(1);
    expect(executor.lastQuery!.tMax.length).toBe(64);
    expect(result.extension).toMatchObject({ enabled: true, missedPixels: 64, candidates: 64,
      dispatchedRays: 64 });
    expect(result.extension.hits).toBeGreaterThan(0);
    expect(result.extension.degradedReason).toBeUndefined();
    expect(result.output.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
  });
  it("downgrades beyond the per-frame budget and keeps the excess on the fallback", async () => {
    const executor = hitAll(0.5);
    const result = await screenSpaceReflectionCpuWithRayExtension(backfacingFrame(), OPTIONS,
      { ...EXTENSION, maxRaysPerFrame: 10 }, executor);
    expect(executor.lastQuery!.tMax.length).toBe(10);
    expect(result.extension).toMatchObject({ dispatchedRays: 10, budgetClamped: true });
    expect(result.extension.hits).toBeLessThanOrEqual(10);
  });
  it("falls back to the untouched SSR result when the executor fails", async () => {
    const baseline = screenSpaceReflectionCpu(backfacingFrame(), OPTIONS);
    const failing = new RecordingExecutor(async () => {
      throw new Error("Ray trace stack overflow (capacity 32) on 3 ray(s); batch rejected (fail-closed).");
    });
    const result = await screenSpaceReflectionCpuWithRayExtension(backfacingFrame(), OPTIONS,
      EXTENSION, failing);
    expect(result.extension.degradedReason).toMatch(/stack overflow/);
    expect(result.extension.dispatchedRays).toBe(64);
    expect(result.extension.hits).toBe(0);
    expect([...result.output]).toEqual([...baseline.output]);
  });
});

describe("end to end through RayTraceGpuExecutor (stub device)", () => {
  // stub GPU 模式沿用 rayTraceExecutor.test.ts：以 CPU traceClosest 模拟 kernel 数值输出。
  class StubBuffer {
    readonly data: Uint8Array;
    constructor(readonly label: string, readonly size: number, readonly usage: number) {
      this.data = new Uint8Array(size);
    }
    mapAsync(): Promise<void> { return Promise.resolve(); }
    getMappedRange(): ArrayBuffer { return this.data.buffer; }
    unmap(): void {} destroy(): void {}
  }
  function stubDevice(state: { rayCount: number; scene: ReturnType<typeof buildTracedScene> }): GPUDevice {
    const buffers = new Map<string, StubBuffer>();
    const copies: Array<[StubBuffer, StubBuffer, number]> = [];
    const writeBuffer = (buffer: GPUBuffer, offset: number, data: ArrayBufferView | ArrayBuffer,
      dataOffset = 0, size?: number): void => {
      const target = buffers.get(buffer.label)!;
      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset)
        : (() => {
          const elementBytes = data.BYTES_PER_ELEMENT;
          const total = data.byteLength / elementBytes;
          return new Uint8Array(data.buffer, data.byteOffset + dataOffset * elementBytes,
            (size ?? total - dataOffset) * elementBytes);
        })();
      target.data.set(bytes, offset);
    };
    return {
      pushErrorScope(): void {}, popErrorScope: () => Promise.resolve(null),
      createShaderModule: ({ code }) => ({ code }) as GPUShaderModule,
      createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }) as unknown as GPUComputePipeline,
      createBindGroup: ({ entries }) => ({ entries }) as unknown as GPUBindGroup,
      createBuffer: ({ label, size, usage }) => {
        const buffer = new StubBuffer(label, size, usage); buffers.set(label, buffer);
        return buffer as unknown as GPUBuffer;
      },
      createCommandEncoder: () => ({
        beginComputePass: () => ({ setPipeline(): void {}, setBindGroup(): void {},
          dispatchWorkgroups(): void {}, end(): void {} }) as unknown as GPUComputePassEncoder,
        copyBufferToBuffer: (source: GPUBuffer, sOff: number, destination: GPUBuffer, dOff: number, size: number) => {
          copies.push([buffers.get(source.label)!, buffers.get(destination.label)!, size]);
          new Uint8Array(buffers.get(destination.label)!.data.buffer, dOff, size).set(
            new Uint8Array(buffers.get(source.label)!.data.buffer, sOff, size));
        },
        finish: () => ({}) as GPUCommandBuffer,
      }) as unknown as GPUCommandEncoder,
      queue: {
        writeBuffer,
        submit: () => {
          const rays = new Float32Array(buffers.get("rt-rays")!.data.buffer);
          const hitFloats = new Float32Array(buffers.get("rt-hits")!.data.buffer);
          const hitWords = new Uint32Array(buffers.get("rt-hits")!.data.buffer);
          for (let index = 0; index < state.rayCount; index++) {
            const slot = index * RAY_RECORD_WORDS;
            const hit = traceClosest(state.scene, { ox: rays[slot]!, oy: rays[slot + 1]!, oz: rays[slot + 2]!,
              dx: rays[slot + 4]!, dy: rays[slot + 5]!, dz: rays[slot + 6]!, tMax: rays[slot + 3]! });
            hitFloats[index * 4] = hit ? Math.fround(hit.t) : -1;
            hitWords[index * 4 + 1] = hit ? hit.primitiveIndex : 0xffff_ffff;
            hitWords[index * 4 + 2] = hit ? HIT_STATUS.hit : HIT_STATUS.miss;
          }
          new Uint32Array(buffers.get("rt-overflows")!.data.buffer)[0] = 0;
          for (const [source, destination, size] of copies) {
            new Uint8Array(destination.data.buffer).set(new Uint8Array(source.data.buffer, 0, size));
          }
        },
      } as unknown as GPUQueue,
    } as unknown as GPUDevice;
  }
  /** 视空间地板 BLAS：y=-3 平面网格，法线 (0,1,0) 的帧反射向下可命中它。 */
  function floorBlas(): RayBlasDescriptor {
    const vertices: number[] = [], indices: number[] = [];
    for (let z = 0; z < 13; z++) for (let x = 0; x < 13; x++) {
      vertices.push(-36 + x * 6, -3, -6 - z * 3);
    }
    const stride = 13;
    for (let z = 0; z < 12; z++) for (let x = 0; x < 12; x++) {
      const a = z * stride + x;
      indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
    }
    return { id: "ssr-extension-floor", vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
  }
  it("dispatches extension rays through the packed executor path and composites their energy", async () => {
    const blas = floorBlas();
    const scene = buildTracedScene(blas);
    const state = { rayCount: 0, scene };
    const executor = new RecordingExecutor(async (query) => {
      state.rayCount = query.tMax.length;
      return new RayTraceGpuExecutor(stubDevice(state), blas).traceBatch(query);
    });
    const result = await screenSpaceReflectionCpuWithRayExtension(frame(5, [0, 1, 0]), OPTIONS,
      { ...EXTENSION, tMax: 64 }, executor);
    expect(executor.calls).toBe(1);
    // 63 而非 64：右下角像素 (7,7) 反射第一步的深度差 0.485 < thickness=0.5，被 SSR 本体
    // 判为屏内命中——候选集合必须精确跟随 SSR 本体的命中/缺失边界，不得凭空多补。
    expect(executor.lastQuery!.tMax.length).toBe(63);
    expect(result.extension).toMatchObject({ dispatchedRays: 63 });
    expect(result.extension.hits).toBeGreaterThan(0); // 上半屏反射向下命中视空间地板。
    const baseline = screenSpaceReflectionCpu(frame(5, [0, 1, 0]), OPTIONS);
    expect(result.output.some((value, index) => value !== baseline.output[index])).toBe(true);
    expect(result.output.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
    expect(result.extension.degradedReason).toBeUndefined();
  });
});
