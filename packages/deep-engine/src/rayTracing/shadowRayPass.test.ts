/// <reference types="@webgpu/types" />
import { describe, expect, it } from "vitest";
import { ShadowRayMaskPass, packDirectionalShadowRays, shadowMaskFromTlas } from "./shadowRayPass.js";
import { IncrementalTlasScene } from "./incrementalTlas.js";
import { buildTlas, traceTlasClosest, type TlasInstanceDescriptor, type TraceQuery } from "./tlas.js";
import { packRayBatch, RAY_TRACE_WORKGROUP_SIZE } from "./rayTraceLayout.js";
import type { RayBlasDescriptor } from "./rayBackendTypes.js";

/** 地板网格 + 双遮挡体 BLAS（与 probe 场景同构的小型版）。 */
function floorBlas(): RayBlasDescriptor {
  const stride = 11, vertices: number[] = [], indices: number[] = [];
  for (let z = 0; z < stride; z++) for (let x = 0; x < stride; x++) vertices.push(x * 2 - 10, 0, z * 2 - 10);
  for (let z = 0; z < stride - 1; z++) for (let x = 0; x < stride - 1; x++) {
    const a = z * stride + x;
    indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
  }
  return { id: "floor", vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
}

function boxBlas(id: string, cx: number, cz: number, half: number, y0: number, y1: number): RayBlasDescriptor {
  const x0 = cx - half, x1 = cx + half, z0 = cz - half, z1 = cz + half;
  const v = (x: number, y: number, z: number): number[] => [x, y, z];
  const corners = [v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1),
    v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1)];
  const quads = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const vertices: number[] = [], indices: number[] = [];
  quads.forEach((quad, qi) => {
    const base = qi * 4;
    quad.forEach(c => vertices.push(...corners[c]!));
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  return { id, vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
}

const BLAS_LIST = [floorBlas(), boxBlas("blockA", -2, 0, 1.5, 0, 3), boxBlas("blockB", 3, 2, 1, 0, 2)];
const INSTANCES: TlasInstanceDescriptor[] = BLAS_LIST.map((blas, index) => ({
  id: blas.id, blas, worldToLocal: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], mask: 1 << index,
}));

/** 地面受光点 + 斜上方向光：部分遮挡/部分可见。 */
function receiverBatch(count: number) {
  const receivers = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) receivers.set([-6 + i * 12 / (count - 1), 0.01, -4 + (i % 5) * 2], i * 3);
  return packDirectionalShadowRays(receivers, 0.3, 1, 0.15, 40, 0xff);
}

interface StubState {
  features: Set<string>;
  buffers: Map<string, { data: Uint8Array; destroyed: boolean }>;
  dispatches: number[];
  forcedOverflow: number;
  queries: TraceQuery[];
  createCount: Map<string, number>;
  lastBindGroup?: readonly GPUBindGroupEntry[];
}

/** stub 设备：模拟 shadow_ray_mask_batch（以 traceTlasClosest 为内核语义），全套 buffer 合同校验。 */
function stubDevice(state: StubState & StubExtras): GPUDevice {
  const buffer = (label: string): { data: Uint8Array; destroyed: boolean } => {
    const found = state.buffers.get(label);
    if (found === undefined) throw new Error(`stub: unknown buffer ${label}`);
    return found;
  };
  const copies: Array<[string, string, number, number, number]> = [];
  return {
    features: { has: (f: string) => state.features.has(f) } as unknown as GPUAdapterFeatures,
    pushErrorScope(): void {}, popErrorScope: () => Promise.resolve(null),
    createShaderModule: ({ code }: { code: string }) => ({ code }) as unknown as GPUShaderModule,
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }) as unknown as GPUComputePipeline,
    createBindGroup: ({ entries }: { entries: readonly GPUBindGroupEntry[] }) => {
      state.lastBindGroup = entries;
      return { entries } as unknown as GPUBindGroup;
    },
    createBuffer: ({ label, size }: { label: string; size: number }) => {
      state.createCount.set(label, (state.createCount.get(label) ?? 0) + 1);
      const entry = { data: new Uint8Array(size), destroyed: false };
      state.buffers.set(label, entry);
      return { label, destroy: () => { entry.destroyed = true; },
        mapAsync: async (): Promise<void> => {},
        getMappedRange: () => entry.data.buffer,
        unmap: (): void => {} } as unknown as GPUBuffer;
    },
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline(): void {}, setBindGroup(): void {},
        dispatchWorkgroups: (x: number): void => { state.dispatches.push(x); }, end(): void {},
      }) as unknown as GPUComputePassEncoder,
      copyBufferToBuffer: (source: GPUBuffer, sOff: number, destination: GPUBuffer, dOff: number, size: number): void => {
        copies.push([source.label, destination.label, sOff, dOff, size]);
      },
      finish: () => ({}) as GPUCommandBuffer,
    }) as unknown as GPUCommandEncoder,
    queue: {
      writeBuffer: (target: GPUBuffer, offset: number, data: ArrayBuffer | ArrayBufferView, dataOffset = 0, size?: number): void => {
        const entry = buffer(target.label);
        const view = data instanceof ArrayBuffer ? new Uint8Array(data)
          : new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
        const elementBytes = data instanceof ArrayBuffer ? 1
          : (data as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
        const byteOffset = data instanceof ArrayBuffer ? dataOffset : dataOffset * elementBytes;
        const byteLength = (size ?? view.byteLength / elementBytes - dataOffset) * elementBytes;
        entry.data.set(view.subarray(byteOffset, byteOffset + byteLength), offset);
      },
      submit: (): void => {
        // 模拟内核：从 uniform 读 rayCount，从 rayStream 读射线，以 traceTlasClosest 仲裁遮挡。
        const rayCount = new Uint32Array(buffer("shadow-rays-uniform").data.buffer)[0]!;
        const rays = new Float32Array(buffer("shadow-rays-stream").data.buffer);
        const masks = new Uint32Array(buffer("shadow-rays-masks").data.buffer);
        state.queries = [];
        for (let i = 0; i < rayCount; i++) {
          const query = { ox: rays[i * 8]!, oy: rays[i * 8 + 1]!, oz: rays[i * 8 + 2]!, tMax: rays[i * 8 + 3]!,
            dx: rays[i * 8 + 4]!, dy: rays[i * 8 + 5]!, dz: rays[i * 8 + 6]! };
          state.queries.push(query);
          masks[i] = state.simulate === undefined ? 1 : (state.simulate(query) ? 1 : 0);
        }
        new Uint32Array(buffer("shadow-rays-overflows").data.buffer)[0] = Math.max(0, state.forcedOverflow);
        // 读回 copy 在 submit 末尾统一应用（真机时序：dispatch 后 copy）。
        for (const [source, destination, sOff, dOff, size] of copies) {
          buffer(destination).data.set(buffer(source).data.subarray(sOff, sOff + size), dOff);
        }
      },
    } as unknown as GPUQueue,
  } as unknown as GPUDevice;
}

interface StubExtras {
  simulate?: (query: TraceQuery) => boolean;
  forcedOverflow: number;
}

function makePass(scene: IncrementalTlasScene, extras: Partial<StubExtras> = {}, features = new Set<string>()) {
  const state = Object.assign({
    features, buffers: new Map(), dispatches: [] as number[], forcedOverflow: 0,
    queries: [] as TraceQuery[], createCount: new Map<string, number>(),
    simulate: undefined as ((query: TraceQuery) => boolean) | undefined,
  }, extras) as StubState & StubExtras;
  state.features = features;
  const device = stubDevice(state);
  const packed = scene.packed;
  const pass = new ShadowRayMaskPass(device, packed);
  const tlas = scene.packed.instanceCount > 0 ? referenceTlas(scene) : undefined;
  return { pass, state, tlas };
}

function referenceTlas(scene: IncrementalTlasScene) {
  const instances = INSTANCES;
  const bounds = instances.map((_, index) => {
    const placement = scene.packed.placements.find(p => p.instanceIndex === index)!;
    return { minX: placement.minX, minY: placement.minY, minZ: placement.minZ, maxX: placement.maxX, maxY: placement.maxY, maxZ: placement.maxZ };
  });
  return { instances, instanceBounds: bounds, built: { nodes: [], order: [] } } as unknown as ReturnType<typeof buildTlas>;
}

describe("shadow ray mask pass (stub device)", () => {
  it("end-to-end: GPU mask equals the CPU occlusion mirror on a mixed scene", async () => {
    const scene = new IncrementalTlasScene(BLAS_LIST);
    scene.updateInstances(INSTANCES);
    const built = makePass(scene);
    // stub 内核语义 = traceTlasClosest 遮挡仲裁（与 GPU 合同同构）。
    const tlas = buildTlas(INSTANCES);
    (built.state as StubState & StubExtras).simulate = (query) => traceTlasClosest(tlas, query, 0xff) === undefined;
    const query = receiverBatch(48);
    const result = await built.pass.dispatchMask(query);
    const expected = shadowMaskFromTlas(tlas, toQueries(query));
    expect([...result.mask]).toEqual([...expected]);
    expect(result.stackOverflows).toBe(0);
    expect(built.state.dispatches).toEqual([Math.ceil(48 / RAY_TRACE_WORKGROUP_SIZE)]);
  });

  it("keeps scene buffers persistent across dispatches (skeleton contract)", async () => {
    const scene = new IncrementalTlasScene(BLAS_LIST);
    scene.updateInstances(INSTANCES);
    const built = makePass(scene);
    const tlas = buildTlas(INSTANCES);
    (built.state as StubState & StubExtras).simulate = (query) => traceTlasClosest(tlas, query, 0xff) === undefined;
    await built.pass.dispatchMask(receiverBatch(16));
    const counts = new Map(built.state.createCount);
    await built.pass.dispatchMask(receiverBatch(16));
    for (const [label, count] of built.state.createCount) {
      if (label.startsWith("shadow-rays-nodes") || label.startsWith("shadow-rays-instances")
        || label.startsWith("shadow-rays-vertices") || label.startsWith("shadow-rays-indices")
        || label.startsWith("shadow-rays-order")) {
        expect(counts.get(label)).toBe(count);
      }
    }
  });

  it("fails closed on stack overflow sentinel and budget overflow", async () => {
    const scene = new IncrementalTlasScene(BLAS_LIST);
    scene.updateInstances(INSTANCES);
    const built = makePass(scene, { forcedOverflow: 3 });
    await expect(built.pass.dispatchMask(receiverBatch(4)))
      .rejects.toThrow(/stack overflow/);
    const oversized = packDirectionalShadowRays(new Float32Array(3_000_000 * 3).fill(1), 0, 1, 0, 1);
    await expect(built.pass.dispatchMask(oversized)).rejects.toThrow(/maxBatchRays/);
  });

  it("rejects the f16 variant without the shader-f16 feature (fail-closed)", () => {
    const scene = new IncrementalTlasScene(BLAS_LIST, { f16: true });
    scene.updateInstances(INSTANCES);
    const state = { features: new Set<string>(), buffers: new Map(), dispatches: [], forcedOverflow: 0,
      queries: [], createCount: new Map() } as StubState & StubExtras;
    expect(() => new ShadowRayMaskPass(stubDevice(state) as GPUDevice, scene.packed, { f16: true }))
      .toThrow(/shader-f16/);
    state.features = new Set(["shader-f16"]);
    expect(() => new ShadowRayMaskPass(stubDevice(state) as GPUDevice, scene.packed, { f16: true })).not.toThrow();
  });

  it("guards updateTlasRegion against BLAS-changing packs and rewrites the region on match", () => {
    const scene = new IncrementalTlasScene(BLAS_LIST);
    scene.updateInstances(INSTANCES);
    const built = makePass(scene);
    const other = new IncrementalTlasScene([BLAS_LIST[0]!]);
    other.updateInstances([{ id: "floor", blas: BLAS_LIST[0]!, worldToLocal: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], mask: 1 }]);
    expect(() => built.pass.updateTlasRegion(other.packed)).toThrow(/unchanged BLAS/);
    const moved = scene.updateInstances(INSTANCES.map((instance, index) => index === 0 ? instance
      : { ...instance, worldToLocal: [1, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 3] }));
    expect(() => built.pass.updateTlasRegion(moved)).not.toThrow();
    expect(built.pass.packed).toBe(moved);
  });

  it("validates directional shadow batch inputs", () => {
    expect(() => packDirectionalShadowRays(new Float32Array(3), 0, 0, 0, 1)).toThrow(/nonzero/);
    expect(() => packDirectionalShadowRays(new Float32Array(3), 0, 1, 0, -1)).toThrow(/positive/);
    expect(() => packDirectionalShadowRays(new Float32Array(4), 0, 1, 0, 1)).toThrow(/3 floats/);
    const batch = packDirectionalShadowRays(new Float32Array([1, 2, 3, 4, 5, 6]), 0, 2, 0, 5, 0b11);
    const length = Math.hypot(0, 2, 0);
    expect([...batch.directions]).toEqual([0, 2 / length, 0, 0, 2 / length, 0]);
    expect([...batch.tMax]).toEqual([5, 5]);
    expect(batch.mask).toBe(0b11);
    expect(packRayBatch(batch).byteLength).toBe(2 * 32);
  });
});

function toQueries(query: ReturnType<typeof packDirectionalShadowRays>): TraceQuery[] {
  const result: TraceQuery[] = [];
  for (let i = 0; i < query.tMax.length; i++) {
    result.push({ ox: query.origins[i * 3]!, oy: query.origins[i * 3 + 1]!, oz: query.origins[i * 3 + 2]!,
      dx: query.directions[i * 3]!, dy: query.directions[i * 3 + 1]!, dz: query.directions[i * 3 + 2]!, tMax: query.tMax[i]! });
  }
  return result;
}
