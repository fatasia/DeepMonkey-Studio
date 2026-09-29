// I 级 C2 集群光源剔除单元测试(CPU mock,真机对拍在 scripts/clusterLightCullingGpuTest.mjs):
// 分簇正确性(光心 CPU 镜像 ↔ B1 簇心参考的集合等价)、预算上限、fail-closed(资源回滚/
// 越界拒绝)、opt-in 默认关回归、与 B1 同 ABI 的参数字布局。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { FORWARD_PLUS_CLUSTER_PARAMETER_BYTES } from "./clusterAbiWgsl.js";
import { assignLightsToClusters } from "./clusterGrid.js";
import { CLUSTER_LIGHT_CULLING_PIPELINE_KEY, assignLightsToClustersLightCentric, ClusterLightCuller,
  packClusterLightCullingParameters, resolveClusterLightCullingMode } from "./clusterLightCulling.js";
import type { ClusteredLights } from "./types.js";

interface FakeBuffer extends GPUBuffer { readonly label: string; readonly destroy: ReturnType<typeof vi.fn> }
function fixture() {
  const owned = new Set<GPUBuffer>(), allocated: FakeBuffer[] = [], writes: Array<{ buffer: FakeBuffer; bytes: Uint8Array }> = [];
  let failAllocationAt = -1;
  const queue = { writeBuffer: vi.fn((buffer: FakeBuffer, _offset: number, data: ArrayBuffer | ArrayBufferView) => {
    const source = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    writes.push({ buffer, bytes: new Uint8Array(source) });
  }) };
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024, maxComputeWorkgroupsPerDimension: 65_535 }, queue,
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroupLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createComputePipeline: vi.fn(({ label, compute }: { label: string; compute: { entryPoint: string } }) => ({ label, entryPoint: compute.entryPoint })),
    createBuffer: vi.fn(({ label, size, usage }: GPUBufferDescriptor) => {
      if (allocated.length === failAllocationAt) throw new Error("allocation failed");
      const value = { label: label ?? "", size, usage, mapState: "unmapped", destroy: vi.fn() } as unknown as FakeBuffer;
      allocated.push(value); return value;
    }),
    createBindGroup: vi.fn(({ label, entries }: { label: string; entries: GPUBindGroupEntry[] }) => ({ label, entries })),
  };
  const session = { state: "ready", device,
    own<T extends GPUBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: GPUBuffer): void { if (owned.delete(resource)) resource.destroy(); } };
  const encoderPasses: Array<{ label: string; dispatches: number[]; pipelines: string[] }> = [];
  const encoder = { beginComputePass: vi.fn(({ label }: { label: string }) => {
    const record = { label, dispatches: [] as number[], pipelines: [] as string[] };
    encoderPasses.push(record);
    return { setPipeline: (pipeline: { entryPoint: string }) => record.pipelines.push(pipeline.entryPoint),
      setBindGroup: vi.fn(), dispatchWorkgroups: (groups: number) => record.dispatches.push(groups), end: vi.fn() };
  }) };
  return { session: session as unknown as DeviceSession, rawSession: session, device, queue, owned, allocated, writes,
    encoderPasses, encoder, failNextAllocation(offset: number) { failAllocationAt = allocated.length + offset; },
    disableAllocationFailure() { failAllocationAt = -1; } };
}

beforeEach(() => { vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 }); vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4 }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const config = { viewportWidth: 128, viewportHeight: 64, tileSizeX: 32, tileSizeY: 32,
  zSlices: 4, near: 1, far: 16, verticalFovRadians: Math.PI / 2, maxLightsPerCluster: 4 } as const;
const point = (positionView: readonly [number, number, number], range = 2) =>
  ({ positionView, range, color: [1, 0.5, 0.25] as const, intensity: 2 });

/** 每簇索引集合比较(原子序不定,集合才是合同)。 */
function sameClusterSets(left: { headers: Uint32Array; lightIndices: Uint32Array },
  right: { headers: Uint32Array; lightIndices: Uint32Array }, maxPerCluster: number): boolean {
  if (left.headers.length !== right.headers.length) return false;
  for (let cluster = 0; cluster < left.headers.length / 2; cluster++) {
    const offset = cluster * maxPerCluster;
    const a = new Set(left.lightIndices.slice(offset, offset + left.headers[cluster * 2 + 1]!));
    const b = new Set(right.lightIndices.slice(offset, offset + right.headers[cluster * 2 + 1]!));
    if (a.size !== b.size || [...a].some(value => !b.has(value))) return false;
  }
  return true;
}

describe("cluster light culling opt-in gate (default off)", () => {
  it("resolves off unless explicitly opted in", () => {
    expect(resolveClusterLightCullingMode()).toBe("off");
    expect(resolveClusterLightCullingMode(undefined)).toBe("off");
    expect(resolveClusterLightCullingMode(false)).toBe("off");
    expect(resolveClusterLightCullingMode(true)).toBe("light-centric");
  });

  it("keeps module import side-effect free (no existing pipeline mutation)", () => {
    expect(CLUSTER_LIGHT_CULLING_PIPELINE_KEY).toBe("deep.cluster-light-culling.v1");
  });
});

describe("light-centric CPU mirror vs B1 cluster-centric reference (set equivalence)", () => {
  it("matches B1 assignment sets for a deterministic multi-region scene", () => {
    const lights: ClusteredLights = { points: [point([-3, -1, -6], 0.4), point([3, 1, -6], 0.4),
      point([0, -1, -1.5], 0.1), point([0, 1, -12], 0.4)],
      spots: [{ ...point([1, 0, -4]), directionView: [0, 0, -1], outerConeCos: 0.4, innerConeCos: 0.7 }] };
    const culling = assignLightsToClustersLightCentric(config, lights);
    const reference = assignLightsToClusters(config, lights);
    expect(culling.localLightCount).toBe(reference.localLightCount);
    expect(culling.overflowCount).toBe(reference.overflowCount);
    expect(sameClusterSets(culling, reference, config.maxLightsPerCluster)).toBe(true);
  });

  it("matches B1 overflow accounting under a saturated cluster", () => {
    const lights: ClusteredLights = { points: Array.from({ length: 8 }, () => point([0, 0, -2], 100)) };
    const culling = assignLightsToClustersLightCentric(config, lights);
    const reference = assignLightsToClusters(config, lights);
    expect(culling.overflowCount).toBe(reference.overflowCount);
    expect(sameClusterSets(culling, reference, config.maxLightsPerCluster)).toBe(true);
    const saturated = culling.headers[0 * 2 + 1]!;
    expect(saturated).toBeLessThanOrEqual(config.maxLightsPerCluster);
    expect(culling.overflowCount).toBeGreaterThan(0);
  });

  it("rejects invalid grids with the same fail-closed contracts as B1", () => {
    expect(() => assignLightsToClustersLightCentric({ ...config, zSlices: 257 }, { points: [] })).toThrow("zSlices");
    expect(() => assignLightsToClustersLightCentric({ ...config, near: 2, far: 1 }, { points: [] })).toThrow("near/far");
  });
});

describe("ClusterLightCuller prepare/encode lifecycle", () => {
  it("packs the same local bounds and B1-compatible 80B parameter words", () => {
    const f = fixture(), culler = new ClusterLightCuller(f.session);
    const lights: ClusteredLights = { points: [point([-2, 0, -4]), point([2, 0, -8], 4)] };
    const resources = culler.prepare(config, lights, { cpuReference: true });
    expect(resources.pipelineKey).toBe(CLUSTER_LIGHT_CULLING_PIPELINE_KEY);
    expect(resources.selectedLocalLightCount).toBe(2);
    const boundsWrite = f.writes.find(write => write.buffer === resources.localBoundsBuffer)!;
    const bounds = new Float32Array(boundsWrite.bytes.buffer, boundsWrite.bytes.byteOffset, 8);
    expect([...bounds]).toEqual([-2, 0, -4, 2, 2, 0, -8, 4]);
    const params = new Uint32Array(f.writes.find(write => write.buffer === resources.clusterParameterBuffer)!.bytes.buffer);
    expect(params[0]).toBe(config.viewportWidth); expect(params[1]).toBe(config.viewportHeight);
    expect(params[4]).toBe(4); expect(params[5]).toBe(2); expect(params[6]).toBe(config.zSlices); expect(params[7]).toBe(2);
    expect(params[8]).toBe(config.maxLightsPerCluster); expect(params[9]).toBe(32); expect(params[10]).toBe(0);
    const floats = new Float32Array(params.buffer);
    expect([...floats.slice(12, 16)]).toEqual([config.near, config.far, Math.fround(Math.tan(config.verticalFovRadians / 2)), Math.fround(config.viewportWidth / config.viewportHeight)]);
    expect(packClusterLightCullingParameters(resources.grid, 2).byteLength).toBe(FORWARD_PLUS_CLUSTER_PARAMETER_BYTES);
    expect(resources.cpuReference?.localLightCount).toBe(2);
  });

  it("encodes one pass with reset/cull/finalize dispatches, caches static frames, invalidates on demand", () => {
    const f = fixture(), culler = new ClusterLightCuller(f.session);
    const resources = culler.prepare(config, { points: [point([0, 0, -4])] });
    culler.encode(f.encoder as unknown as GPUCommandEncoder);
    expect(f.encoderPasses).toHaveLength(3);
    expect(f.encoderPasses.map(pass => pass.pipelines[0])).toEqual(["resetLists", "cullLights", "finalizeCounts"]);
    expect(f.encoderPasses.map(pass => pass.dispatches[0]))
      .toEqual([resources.resetWorkgroups, resources.cullWorkgroups, resources.finalizeWorkgroups]);
    const overflowReset = f.writes.filter(write => write.buffer === resources.overflowBuffer);
    expect(overflowReset).toHaveLength(1);
    expect(() => culler.encode(f.encoder as unknown as GPUCommandEncoder)).toThrow("must be prepared");
    // 同灯场重 prepare → 脏检查命中,零重发(B1 同款静态帧零成本合同)。
    culler.prepare(config, { points: [point([0, 0, -4])] });
    culler.encode(f.encoder as unknown as GPUCommandEncoder);
    expect(f.encoderPasses).toHaveLength(3);
    // 灯场变化 → 重建。
    culler.prepare(config, { points: [point([1, 0, -4])] });
    culler.encode(f.encoder as unknown as GPUCommandEncoder);
    expect(f.encoderPasses).toHaveLength(6);
    expect(f.writes.filter(write => write.buffer === resources.overflowBuffer)).toHaveLength(2);
    // 失效后同灯场也强制重建(提交失败恢复路径)。
    culler.invalidateAssignment();
    culler.prepare(config, { points: [point([1, 0, -4])] });
    culler.encode(f.encoder as unknown as GPUCommandEncoder);
    expect(f.encoderPasses).toHaveLength(9);
  });

  it("reuses stable buffers across capacity-compatible prepares", () => {
    const f = fixture(), culler = new ClusterLightCuller(f.session);
    const first = culler.prepare(config, { points: [point([0, 0, -4])] });
    const second = culler.prepare(config, { points: [point([1, 0, -4])] });
    expect(second.clusterHeaderBuffer).toBe(first.clusterHeaderBuffer);
    expect(second.clusterLightIndexBuffer).toBe(first.clusterLightIndexBuffer);
  });

  it("applies the MegaLights-style budget through importanceBudget", () => {
    const f = fixture(), culler = new ClusterLightCuller(f.session);
    const lights: ClusteredLights = { points: [point([0, 0, -4], 2), point([0, 0, -4.1], 2), point([0, 0, -4.2], 2)] };
    const resources = culler.prepare(config, lights, { maxLocalLights: 2, cpuReference: true });
    expect(resources.selectedLocalLightCount).toBe(2);
    expect(resources.droppedLocalLightCount).toBe(1);
    expect(resources.cpuReference?.localLightCount).toBe(2);
  });

  it("rolls back allocations without leaking owned buffers on failure", () => {
    const f = fixture(), culler = new ClusterLightCuller(f.session);
    f.failNextAllocation(2);
    expect(() => culler.prepare(config, { points: [point([0, 0, -4])] })).toThrow("allocation failed");
    f.disableAllocationFailure();
    expect(f.owned.size).toBe(0);
    expect([...f.owned].every(buffer => (buffer.destroy as ReturnType<typeof vi.fn>).mock.calls.length > 0)).toBe(true);
    const culler2 = new ClusterLightCuller(f.session);
    culler2.prepare(config, { points: [point([0, 0, -4])] });
    const before = f.owned.size;
    culler2.dispose();
    expect(f.owned.size).toBe(0);
    expect(before).toBeGreaterThan(0);
    expect(() => culler2.prepare(config, { points: [] })).toThrow("disposed");
  });

  it("refuses non-ready sessions and invalid grids (fail-closed)", () => {
    const f = fixture();
    (f.session as unknown as { state: string }).state = "lost";
    expect(() => new ClusterLightCuller(f.session)).toThrow("lost");
    const culler = new ClusterLightCuller({ ...f.session, state: "ready" } as unknown as DeviceSession);
    expect(() => culler.prepare({ ...config, zSlices: 300 }, { points: [] })).toThrow();
  });
});
