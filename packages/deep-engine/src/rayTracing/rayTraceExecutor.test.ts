import { describe, expect, it } from "vitest";
import { buildBvh } from "./bvhBuilder.js";
import { HIT_STATUS, RAY_RECORD_WORDS } from "./rayTraceLayout.js";
import { RAY_BACKEND_LIMITS, type RayBlasDescriptor, type RayBatchQuery } from "./rayBackendTypes.js";
import { compareGpuAgainstCpu, planRayTraceDispatch, RayTraceGpuExecutor } from "./rayTraceExecutor.js";
import { buildTracedScene, traceClosest, type TraceQuery, type TracedScene } from "./rayTrace.js";

function gridBlas(cells: number): RayBlasDescriptor {
  const stride = cells + 1;
  const vertices = new Float32Array(stride * stride * 3);
  for (let y = 0; y < stride; y++) for (let x = 0; x < stride; x++) {
    vertices.set([x, y, Math.sin(x * 13.7 + y * 7.3)], (y * stride + x) * 3);
  }
  const indices: number[] = [];
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
    const a = y * stride + x, b = a + 1, c = a + stride, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { id: "executor-grid", vertices, indices: Uint32Array.from(indices) };
}

function rayFan(count: number): RayBatchQuery {
  const origins = new Float32Array(count * 3), directions = new Float32Array(count * 3), tMax = new Float32Array(count);
  for (let step = 0; step < count; step++) {
    const angle = step / count * Math.PI * 2;
    origins.set(step % 2 === 0 ? [3, 3, 5] : [0.5, 0.5, 3], step * 3);
    directions.set([Math.cos(angle), Math.sin(angle), step % 4 === 0 ? -1 : -0.5], step * 3);
    tMax[step] = 64;
  }
  return { origins, directions, tMax, mask: 0xff };
}

function toQueries(query: RayBatchQuery): TraceQuery[] {
  const list: TraceQuery[] = [];
  for (let index = 0; index < query.tMax.length; index++) {
    list.push({ ox: query.origins[index * 3]!, oy: query.origins[index * 3 + 1]!, oz: query.origins[index * 3 + 2]!,
      dx: query.directions[index * 3]!, dy: query.directions[index * 3 + 1]!, dz: query.directions[index * 3 + 2]!,
      tMax: query.tMax[index]! });
  }
  return list;
}

// —— stub GPU：以 CPU 遍历模拟 kernel 数值输出，验证执行器接线（打包/字节布局/读回解析）；
//    WGSL 数值语义本身由 scripts/rayTraceGpuTest.mjs 真机 runner 仲裁。 ——
class StubBuffer {
  readonly data: Uint8Array;
  constructor(readonly label: string, readonly size: number, readonly usage: number) {
    this.data = new Uint8Array(size);
  }
  mapAsync(): Promise<void> { return Promise.resolve(); }
  getMappedRange(): ArrayBuffer { return this.data.buffer; }
  unmap(): void {}
  destroy(): void {}
}

interface StubState { scene: TracedScene; rayCount: number; forcedOverflow: number; statusOverride: number;
  dispatch: [number, number, number] | undefined; bufferCount: number }

function simulateKernel(state: StubState, buffers: Map<string, StubBuffer>): void {
  const rays = new Float32Array(buffers.get("rt-rays")!.data.buffer);
  const hits = buffers.get("rt-hits")!;
  const hitFloats = new Float32Array(hits.data.buffer);
  const hitWords = new Uint32Array(hits.data.buffer);
  for (let index = 0; index < state.rayCount; index++) {
    const base = index * RAY_RECORD_WORDS;
    const hit = traceClosest(state.scene, { ox: rays[base]!, oy: rays[base + 1]!, oz: rays[base + 2]!,
      dx: rays[base + 4]!, dy: rays[base + 5]!, dz: rays[base + 6]!, tMax: rays[base + 3]! });
    hitFloats[index * 4] = hit ? Math.fround(hit.t) : -1;
    hitWords[index * 4 + 1] = hit ? hit.primitiveIndex : 0xffff_ffff;
    hitWords[index * 4 + 2] = hit ? HIT_STATUS.hit : HIT_STATUS.miss;
  }
  if (state.statusOverride !== 0) hitWords[2] = state.statusOverride;
  new Uint32Array(buffers.get("rt-overflows")!.data.buffer)[0] = state.forcedOverflow;
}

function stubDevice(state: StubState): GPUDevice {
  const buffers = new Map<string, StubBuffer>();
  const copies: Array<[StubBuffer, StubBuffer, number]> = [];
  const writeBuffer = (buffer: GPUBuffer, offset: number, data: ArrayBufferView | ArrayBuffer,
    dataOffset = 0, size?: number): void => {
    const target = buffers.get(buffer.label)!, elementBytes = "BYTES_PER_ELEMENT" in data ? data.BYTES_PER_ELEMENT : 1;
    const bytes = "BYTES_PER_ELEMENT" in data
      ? new Uint8Array(data.buffer, data.byteOffset + dataOffset * elementBytes,
        (size ?? data.byteLength / elementBytes - dataOffset) * elementBytes)
      : new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset);
    target.data.set(bytes, offset);
  };
  return {
    pushErrorScope(): void {}, popErrorScope: () => Promise.resolve(null),
    createShaderModule: ({ code }) => ({ code }) as GPUShaderModule,
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }) as unknown as GPUComputePipeline,
    createBindGroup: ({ entries }) => ({ entries }) as unknown as GPUBindGroup,
    createBuffer: ({ label, size, usage }) => {
      state.bufferCount += 1;
      const buffer = new StubBuffer(label, size, usage);
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
        copies.push([buffers.get(source.label)!, buffers.get(destination.label)!, size]);
        const view = new Uint8Array(buffers.get(destination.label)!.data.buffer, dOff, size);
        view.set(new Uint8Array(buffers.get(source.label)!.data.buffer, sOff, size));
      },
      finish: () => ({}) as GPUCommandBuffer,
    }) as unknown as GPUCommandEncoder,
    queue: {
      writeBuffer,
      submit: () => {
        simulateKernel(state, buffers);
        for (const [source, destination, size] of copies) {
          new Uint8Array(destination.data.buffer).set(new Uint8Array(source.data.buffer, 0, size));
        }
      },
    } as unknown as GPUQueue,
  } as unknown as GPUDevice;
}

function makeExecutor(blas: RayBlasDescriptor, options: Partial<Pick<StubState, "forcedOverflow" | "statusOverride">> = {}) {
  const scene = buildTracedScene(blas);
  const state: StubState = { scene, rayCount: 0, forcedOverflow: options.forcedOverflow ?? 0,
    statusOverride: options.statusOverride ?? 0, dispatch: undefined, bufferCount: 0 };
  const device = stubDevice(state);
  const executor = new RayTraceGpuExecutor(device, blas);
  return { executor, state, scene };
}

describe("ray trace gpu executor (stub device)", () => {
  it("round-trips a ray fan with CPU-identical hits through the packed buffer path", async () => {
    const { executor, state, scene } = makeExecutor(gridBlas(6));
    const query = rayFan(40);
    state.rayCount = query.tMax.length;
    const result = await executor.traceBatch(query);
    expect(state.dispatch).toEqual([Math.ceil(40 / 64), 1, 1]);
    expect(result.stackOverflows).toBe(0);
    const comparison = compareGpuAgainstCpu(scene, toQueries(query), result.hits);
    expect(comparison.passed).toBe(true);
    expect(comparison.mismatchCount).toBe(0);
    expect(comparison.maxRelativeTDelta).toBeLessThan(1e-5);
    // f32 读回确实产生了量化（stub 用 fround 模拟），证明读回走的是 buffer 而非引用透传。
    expect(Number.isFinite(comparison.maxRelativeTDelta)).toBe(true);
  });

  it("reports misses as undefined exactly like the CPU reference", async () => {
    const { executor, state, scene } = makeExecutor(gridBlas(4));
    const query: RayBatchQuery = { origins: new Float32Array([2, 2, 5, 2, 2, 5]),
      directions: new Float32Array([0, 0, 1, 0, 0, -0.1]), tMax: new Float32Array([8, 1]), mask: 1 };
    state.rayCount = 2;
    const result = await executor.traceBatch(query);
    expect(result.hits[0]).toBeUndefined();
    expect(result.hits[1]).toBeUndefined();
    expect(compareGpuAgainstCpu(scene, toQueries(query), result.hits).passed).toBe(true);
  });

  it("skips the gpu entirely for an empty blas and zero rays", async () => {
    const empty: RayBlasDescriptor = { id: "empty", vertices: new Float32Array(0), indices: new Uint32Array(0) };
    const { executor, state } = makeExecutor(empty);
    const result = await executor.traceBatch(rayFan(3));
    expect(result.hits).toEqual([undefined, undefined, undefined]);
    expect(state.bufferCount).toBe(0);
    const zero = await executor.traceBatch({ origins: new Float32Array(0), directions: new Float32Array(0),
      tMax: new Float32Array(0), mask: 0 });
    expect(zero.hits).toEqual([]);
  });

  it("rejects batches beyond the maxBatchRays budget", async () => {
    const { executor } = makeExecutor(gridBlas(2));
    await expect(executor.traceBatch({ origins: new Float32Array(0), directions: new Float32Array(0),
      tMax: new Float32Array(RAY_BACKEND_LIMITS.maxBatchRays + 1), mask: 0 }))
      .rejects.toThrow("maxBatchRays");
  });

  it("fails closed on stack overflow sentinel and unknown hit status", async () => {
    const { executor, state } = makeExecutor(gridBlas(4), { forcedOverflow: 2 });
    const query = rayFan(4);
    state.rayCount = 4;
    await expect(executor.traceBatch(query)).rejects.toThrow("stack overflow");
    const retried = makeExecutor(gridBlas(4), { statusOverride: 9 });
    retried.state.rayCount = 4;
    await expect(retried.executor.traceBatch(query)).rejects.toThrow("Unknown hit status 9");
  });
});

describe("gpu/cpu comparison contract", () => {
  const scene = buildTracedScene(gridBlas(4));
  const queries: TraceQuery[] = [{ ox: 2, oy: 2, oz: 5, dx: 0, dy: 0, dz: -1, tMax: 32 }];

  it("detects primitive, tolerance and hit-agreement mismatches", () => {
    const hit = traceClosest(scene, queries[0]!)!;
    expect(compareGpuAgainstCpu(scene, queries, [{ t: hit.t, primitiveIndex: hit.primitiveIndex }]).passed).toBe(true);
    expect(compareGpuAgainstCpu(scene, queries, [{ t: hit.t, primitiveIndex: hit.primitiveIndex + 1 }]).mismatchCount).toBe(1);
    expect(compareGpuAgainstCpu(scene, queries, [{ t: hit.t * (1 + 1e-3), primitiveIndex: hit.primitiveIndex }]).mismatchCount).toBe(1);
    expect(compareGpuAgainstCpu(scene, queries, [undefined]).mismatchCount).toBe(1);
    const within = hit.t * (1 + 1e-9);
    expect(compareGpuAgainstCpu(scene, queries, [{ t: within, primitiveIndex: hit.primitiveIndex }]).passed).toBe(true);
  });

  it("requires equal ray counts and matches the dispatch plan", () => {
    expect(() => compareGpuAgainstCpu(scene, queries, [])).toThrow("equal ray counts");
    expect(planRayTraceDispatch(scene, 1)).toMatchObject({ rayCount: 1, nodeCount: scene.built.nodes.length,
      dispatchX: 1, hitBytes: 16, rayBytes: 32, nodeBytes: scene.built.nodes.length * 48 });
    expect(planRayTraceDispatch(scene, 129).dispatchX).toBe(3);
    expect(buildBvh(gridBlas(4)).nodes.length).toBe(planRayTraceDispatch(scene, 1).nodeCount);
  });
});
