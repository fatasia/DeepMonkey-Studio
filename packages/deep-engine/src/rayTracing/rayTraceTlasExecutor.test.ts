import { describe, expect, it } from "vitest";
import { HIT_STATUS, RAY_RECORD_WORDS } from "./rayTraceLayout.js";
import { RAY_BACKEND_LIMITS, type RayBatchQuery, type RayBlasDescriptor } from "./rayBackendTypes.js";
import { buildTracedScene, traceClosest, type TraceQuery } from "./rayTrace.js";
import { buildTlas, traceTlasClosest, type TlasBuildResult } from "./tlas.js";
import { packTlasScene, TLAS_INSTANCE_SENTINEL } from "./tlasLayout.js";
import { compareTlasGpuAgainstCpu, planTlasDispatch, RayTraceGpuTlasExecutor } from "./rayTraceTlasExecutor.js";

function quadBlas(id: string): RayBlasDescriptor {
  return { id, vertices: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) };
}

function gridBlas(id: string): RayBlasDescriptor {
  const stride = 9;
  const vertices = new Float32Array(stride * stride * 3);
  for (let y = 0; y < stride; y++) for (let x = 0; x < stride; x++) {
    vertices.set([x, y, Math.sin(x * 13.7 + y * 7.3)], (y * stride + x) * 3);
  }
  const indices: number[] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const a = y * stride + x, b = a + 1, c = a + stride, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { id, vertices, indices: Uint32Array.from(indices) };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

// —— stub GPU：以 CPU traceTlasClosest 模拟两级 kernel 数值输出（全局 prim 经 placement 折算），
//    验证执行器接线（打包/字节布局/mask uniform/读回解析）；WGSL 数值语义由真机 runner 仲裁。 ——
class StubBuffer {
  readonly data: Uint8Array;
  constructor(readonly label: string, readonly size: number) { this.data = new Uint8Array(size); }
  mapAsync(): Promise<void> { return Promise.resolve(); }
  getMappedRange(): ArrayBuffer { return this.data.buffer; }
  unmap(): void {}
  destroy(): void {}
}

interface StubState { tlas: TlasBuildResult; rayCount: number; mask: number; forcedOverflow: number;
  statusOverride: number; sentinelInstanceOnHit: boolean; dispatch: [number, number, number] | undefined; bufferCount: number }

function simulateTlasKernel(state: StubState, buffers: Map<string, StubBuffer>): void {
  const rays = new Float32Array(buffers.get("rt-tlas-rays")!.data.buffer);
  const hits = buffers.get("rt-tlas-hits")!;
  const hitFloats = new Float32Array(hits.data.buffer);
  const hitWords = new Uint32Array(hits.data.buffer);
  const placementByInstance = new Map(packTlasScene(state.tlas).placements.map((placement) => [placement.instanceIndex, placement]));
  const instanceIndexOf = (id: string): number => state.tlas.instances.findIndex((entry) => entry.id === id);
  for (let index = 0; index < state.rayCount; index++) {
    const base = index * RAY_RECORD_WORDS;
    const hit = traceTlasClosest(state.tlas, { ox: rays[base]!, oy: rays[base + 1]!, oz: rays[base + 2]!,
      dx: rays[base + 4]!, dy: rays[base + 5]!, dz: rays[base + 6]!, tMax: rays[base + 3]! }, state.mask);
    hitFloats[index * 4] = hit ? Math.fround(hit.t) : -1;
    hitWords[index * 4 + 1] = hit
      ? placementByInstance.get(instanceIndexOf(hit.instanceId))!.triangleBase + hit.primitiveIndex : 0xffff_ffff;
    hitWords[index * 4 + 2] = hit ? HIT_STATUS.hit : HIT_STATUS.miss;
    hitWords[index * 4 + 3] = hit && !state.sentinelInstanceOnHit ? instanceIndexOf(hit.instanceId) : TLAS_INSTANCE_SENTINEL;
    if (state.statusOverride !== 0) hitWords[index * 4 + 2] = state.statusOverride;
  }
  new Uint32Array(buffers.get("rt-tlas-overflows")!.data.buffer)[0] = state.forcedOverflow;
}

function stubDevice(state: StubState): GPUDevice {
  const buffers = new Map<string, StubBuffer>();
  const copies: Array<[StubBuffer, StubBuffer, number]> = [];
  const stub = (buffer: GPUBuffer): StubBuffer => buffers.get((buffer as unknown as StubBuffer).label)!;
  return {
    pushErrorScope(): void {}, popErrorScope: () => Promise.resolve(null),
    createShaderModule: ({ code }) => ({ code }) as GPUShaderModule,
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }) as unknown as GPUComputePipeline,
    createBindGroup: ({ entries }) => ({ entries }) as unknown as GPUBindGroup,
    createBuffer: ({ label, size }) => {
      state.bufferCount += 1;
      const buffer = new StubBuffer(label, size);
      buffers.set(label, buffer);
      return buffer as unknown as GPUBuffer;
    },
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline(): void {}, setBindGroup(): void {},
        dispatchWorkgroups: (x: number, y = 1, z = 1) => { state.dispatch = [x, y, z]; },
        end(): void {},
      }) as unknown as GPUComputePassEncoder,
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
        simulateTlasKernel(state, buffers);
        for (const [source, destination, size] of copies) {
          new Uint8Array(destination.data.buffer).set(new Uint8Array(source.data.buffer, 0, size));
        }
      },
    } as unknown as GPUQueue,
  } as unknown as GPUDevice;
}

function makeExecutor(tlas: TlasBuildResult, options: Partial<Pick<StubState,
  "forcedOverflow" | "statusOverride" | "sentinelInstanceOnHit">> = {}) {
  const state: StubState = { tlas, rayCount: 0, mask: 0xff, forcedOverflow: options.forcedOverflow ?? 0,
    statusOverride: options.statusOverride ?? 0, sentinelInstanceOnHit: options.sentinelInstanceOnHit ?? false,
    dispatch: undefined, bufferCount: 0 };
  return { executor: new RayTraceGpuTlasExecutor(stubDevice(state), tlas), state };
}

describe("ray trace tlas gpu executor (stub device)", () => {
  it("matches the single-BLAS reference under identity transform (two-level vs single-level)", async () => {
    const blas = gridBlas("solo");
    const tlas = buildTlas([{ id: "solo", blas, worldToLocal: IDENTITY, mask: 1 }]);
    const { executor, state } = makeExecutor(tlas);
    const rayCount = 24;
    const rays: RayBatchQuery = { origins: new Float32Array(rayCount * 3), directions: new Float32Array(rayCount * 3),
      tMax: new Float32Array(rayCount), mask: 0xff };
    const queries: TraceQuery[] = [];
    for (let step = 0; step < rayCount; step++) {
      const angle = step / rayCount * Math.PI * 2;
      rays.origins.set([4, 4, 9], step * 3);
      rays.directions.set([Math.cos(angle), Math.sin(angle), -0.7], step * 3);
      rays.tMax[step] = 64;
      queries.push({ ox: 4, oy: 4, oz: 9, dx: Math.cos(angle), dy: Math.sin(angle), dz: -0.7, tMax: 64 });
    }
    state.rayCount = rayCount;
    const result = await executor.traceBatch(rays);
    expect(state.dispatch).toEqual([Math.ceil(rayCount / 64), 1, 1]);
    const scene = buildTracedScene(blas);
    queries.forEach((query, index) => {
      const single = traceClosest(scene, query);
      const twoLevel = result.hits[index];
      expect(twoLevel === undefined).toBe(single === undefined);
      if (single !== undefined && twoLevel !== undefined) {
        // 恒等变换单实例：全局三角下标 == BLAS 局部下标，两级结果须与单级逐值一致。
        expect(twoLevel.primitiveIndex).toBe(single.primitiveIndex);
        expect(twoLevel.instanceIndex).toBe(0);
        expect(twoLevel.t).toBeCloseTo(single.t, 6);
      }
    });
    expect(compareTlasGpuAgainstCpu(tlas, queries, result.hits, executor.packed.placements, 0xff).passed).toBe(true);
  });

  it("selects the nearest translated instance, honours mask and detects comparator mismatches", async () => {
    const tlas = buildTlas([
      { id: "near", blas: quadBlas("near"), worldToLocal: IDENTITY, mask: 0b01 },
      { id: "far", blas: quadBlas("far"), worldToLocal: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 5], mask: 0b01 },
      // worldToLocal z-2 ⇒ 实例世界位置 z=+2：比 near 更近，掩码放宽后 CPU 最近命中会改变。
      { id: "masked-away", blas: quadBlas("masked"), worldToLocal: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -2], mask: 0b10 },
    ]);
    const { executor, state } = makeExecutor(tlas);
    const rays: RayBatchQuery = { origins: new Float32Array([0, 0, 5, 0, 0, 5]), directions: new Float32Array([0, 0, -1, 0, 0, -1]),
      tMax: new Float32Array([64, 64]), mask: 0b01 };
    state.rayCount = 2;
    const result = await executor.traceBatch(rays);
    expect(result.hits[0]).toMatchObject({ t: 5, instanceIndex: 0 });
    expect(result.hits[1]).toMatchObject({ instanceIndex: 0 });
    expect(result.rawRecords[0]).toMatchObject({ instanceIndex: 0, status: HIT_STATUS.hit });
    const queries: TraceQuery[] = [{ ox: 0, oy: 0, oz: 5, dx: 0, dy: 0, dz: -1, tMax: 64 },
      { ox: 0, oy: 0, oz: 5, dx: 0, dy: 0, dz: -1, tMax: 64 }];
    expect(compareTlasGpuAgainstCpu(tlas, queries, result.hits, executor.packed.placements, 0b01).passed).toBe(true);
    // 掩码放宽到 0b11 后 CPU 参考改变，同一 GPU 结果必须被判为不一致（比较器敏感度）。
    expect(compareTlasGpuAgainstCpu(tlas, queries, result.hits, executor.packed.placements, 0b11).mismatchCount).toBeGreaterThan(0);
    const wrongInstance = result.hits.map((hit) => (hit ? { ...hit, instanceIndex: 2 } : undefined));
    expect(compareTlasGpuAgainstCpu(tlas, queries, wrongInstance, executor.packed.placements, 0b01).mismatchCount).toBe(2);
  });

  it("skips the gpu for empty tlas / zero rays and rejects over-budget batches", async () => {
    const empty = { id: "empty", vertices: new Float32Array(0), indices: new Uint32Array(0) };
    const solo = buildTlas([{ id: "solo", blas: quadBlas("solo"), worldToLocal: IDENTITY, mask: 1 }]);
    const { executor, state } = makeExecutor(buildTlas([{ id: "void", blas: empty, worldToLocal: IDENTITY, mask: 1 }]));
    const rays: RayBatchQuery = { origins: new Float32Array([0, 0, 5]), directions: new Float32Array([0, 0, -1]), tMax: new Float32Array([8]), mask: 1 };
    const result = await executor.traceBatch(rays);
    expect(result.hits).toEqual([undefined]);
    expect(state.bufferCount).toBe(0);
    const zero = await makeExecutor(solo).executor.traceBatch({ origins: new Float32Array(0), directions: new Float32Array(0),
      tMax: new Float32Array(0), mask: 0 });
    expect(zero.hits).toEqual([]);
    const overBudget: RayBatchQuery = { origins: new Float32Array(0), directions: new Float32Array(0),
      tMax: new Float32Array(RAY_BACKEND_LIMITS.maxBatchRays + 1), mask: 0 };
    await expect(makeExecutor(solo).executor.traceBatch(overBudget)).rejects.toThrow("maxBatchRays");
    // 手工构造绕过 buildTlas 的 id 防线，直达执行器自身的 validateRayBlas fail-closed 分支。
    const badState: StubState = { tlas: solo, rayCount: 0, mask: 1, forcedOverflow: 0, statusOverride: 0,
      sentinelInstanceOnHit: false, dispatch: undefined, bufferCount: 0 };
    const badTlas: TlasBuildResult = { built: solo.built,
      instances: [{ id: "bad", blas: { id: "", vertices: new Float32Array(0), indices: new Uint32Array(0) },
        worldToLocal: IDENTITY, mask: 1 }], instanceBounds: [] };
    expect(() => new RayTraceGpuTlasExecutor(stubDevice(badState), badTlas)).toThrow("BLAS id is required");
  });

  it("fails closed on overflow sentinel, unknown status and sentinel instance on hit", async () => {
    const tlas = buildTlas([{ id: "solo", blas: quadBlas("solo"), worldToLocal: IDENTITY, mask: 1 }]);
    const rays: RayBatchQuery = { origins: new Float32Array([0, 0, 5]), directions: new Float32Array([0, 0, -1]), tMax: new Float32Array([8]), mask: 1 };
    const overflow = makeExecutor(tlas, { forcedOverflow: 2 });
    overflow.state.rayCount = 1;
    await expect(overflow.executor.traceBatch(rays)).rejects.toThrow("stack overflow");
    const unknown = makeExecutor(tlas, { statusOverride: 9 });
    unknown.state.rayCount = 1;
    await expect(unknown.executor.traceBatch(rays)).rejects.toThrow("Unknown hit status 9");
    const sentinel = makeExecutor(tlas, { sentinelInstanceOnHit: true });
    sentinel.state.rayCount = 1;
    await expect(sentinel.executor.traceBatch(rays)).rejects.toThrow("sentinel instanceIndex");
  });

  it("plans dispatch geometry from the packed scene", () => {
    const blas = gridBlas("plan");
    const executor = makeExecutor(buildTlas([
      { id: "a", blas, worldToLocal: IDENTITY, mask: 1 },
      { id: "b", blas, worldToLocal: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 5], mask: 1 },
    ])).executor;
    const plan = planTlasDispatch(executor.packed, 129);
    expect(plan).toMatchObject({ rayCount: 129, instanceCount: 2, dispatchX: 3, hitBytes: 129 * 16, rayBytes: 129 * 32,
      tlasNodeCount: executor.packed.tlasNodeCount, triangleCount: blas.indices.length / 3 * 2 });
    expect(plan.nodeBytes).toBe((plan.tlasNodeCount + plan.blasNodeCount) * 48);
    expect(plan.instanceBytes).toBe(2 * 128);
  });
});
