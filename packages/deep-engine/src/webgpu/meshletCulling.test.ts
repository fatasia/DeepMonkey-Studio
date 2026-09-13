import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import type { HiZResult } from "./hiZPyramid.js";
import {
  MESHLET_CULL_MIN_COUNT,
  MESHLET_CULL_WGSL,
  MeshletCuller,
  meshletHiZClipTestable,
  meshletHiZVisible,
  meshletNormalConeVisible,
  meshletPlannerRecord,
  nextMeshletCapacity,
} from "./meshletCulling.js";

interface FakeBuffer extends GPUBuffer { readonly label: string; readonly destroy: ReturnType<typeof vi.fn> }
interface FakeTexture extends GPUTexture { readonly label: string; readonly destroy: ReturnType<typeof vi.fn>; readonly createView: ReturnType<typeof vi.fn> }
type FakeResource = FakeBuffer | FakeTexture;

function buffer(label: string, size: number, usage = GPUBufferUsage.STORAGE): FakeBuffer {
  return { label, size, usage, mapState: "unmapped", destroy: vi.fn() } as unknown as FakeBuffer;
}

function texture(label: string, descriptor: Partial<GPUTextureDescriptor> = {}): FakeTexture {
  return { label, width: 64, height: 64, depthOrArrayLayers: 1, mipLevelCount: 7, sampleCount: 1,
    dimension: "2d", format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING, destroy: vi.fn(),
    createView: vi.fn((view = {}) => ({ label: `${label}-view`, descriptor: view })), ...descriptor } as unknown as FakeTexture;
}

function hiz(revision = 0, reversedZ = false, source = texture("hiz")): HiZResult {
  return { texture: source, format: "r32float", width: source.width, height: source.height,
    mipLevelCount: source.mipLevelCount, levels: Array.from({ length: source.mipLevelCount }, (_, level) => ({
      level, width: Math.max(1, Math.floor(source.width / 2 ** level)), height: Math.max(1, Math.floor(source.height / 2 ** level)),
      view: {} as GPUTextureView })), sourceRevision: revision, reversedZ, reduction: reversedZ ? "min" : "max", updated: true };
}

function fixture() {
  const owned = new Set<FakeResource>(), allocated: FakeBuffer[] = [], textures: FakeTexture[] = [];
  const writes: Array<{ buffer: GPUBuffer; data: ArrayBuffer | ArrayBufferView }> = [];
  const queue = { writeBuffer: vi.fn((target: GPUBuffer, _offset: number, data: ArrayBuffer | ArrayBufferView) => writes.push({ buffer: target, data })) };
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024,
      maxUniformBufferBindingSize: 65_536, maxTextureDimension2D: 16_384, maxComputeWorkgroupsPerDimension: 65_535,
      maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256, maxBindingsPerBindGroup: 1000,
      maxStorageBuffersPerShaderStage: 8, maxUniformBuffersPerShaderStage: 12, maxSampledTexturesPerShaderStage: 16 }, queue,
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroupLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createComputePipeline: vi.fn(({ label }: { label: string }) => ({ label })),
    createBuffer: vi.fn(({ label, size, usage }: GPUBufferDescriptor) => {
      const value = buffer(label ?? "", size, usage); allocated.push(value); return value;
    }),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const value = texture(descriptor.label ?? "", descriptor); textures.push(value); return value;
    }),
    createBindGroup: vi.fn(({ label, entries }: { label: string; entries: GPUBindGroupEntry[] }) => ({ label, entries })),
  };
  const session = { state: "ready", device,
    own<T extends FakeResource>(resource: T): T { owned.add(resource); return resource; },
    release(resource: FakeResource): void { if (owned.delete(resource)) resource.destroy(); } };
  return { device, queue, session: session as unknown as DeviceSession, rawSession: session, owned, allocated, textures, writes };
}

function encoderFixture() {
  const passes: Array<{ pipelines: string[]; dispatches: number[] }> = [];
  const encoder = { beginComputePass: vi.fn(() => {
    const record = { pipelines: [] as string[], dispatches: [] as number[] }; passes.push(record);
    return { setBindGroup: vi.fn(), setPipeline: vi.fn((pipeline: { label: string }) => record.pipelines.push(pipeline.label)),
      dispatchWorkgroups: vi.fn((count: number) => record.dispatches.push(count)), end: vi.fn() };
  }) };
  return { encoder: encoder as unknown as GPUCommandEncoder, passes, raw: encoder };
}

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
const frustum = { planes: [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1],
  [0, 0, 1, 0], [0, 0, -1, 1]] as const };
function request(count = MESHLET_CULL_MIN_COUNT, revision = 0) {
  return { descriptors: buffer("descriptors", Math.max(4, count * 16)), bounds: buffer("bounds", Math.max(4, count * 64)), count, revision };
}
function view(overrides: Partial<{ reversedZ: boolean; hiz: HiZResult; worldFromObject: readonly number[] }> = {}) {
  return { viewProjection: identity, worldFromObject: overrides.worldFromObject ?? identity,
    cameraPosition: [0, 0, 5] as const, frustum, viewport: [64, 64] as const,
    reversedZ: overrides.reversedZ ?? false, ...(overrides.hiz ? { hiz: overrides.hiz } : {}) };
}

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, UNIFORM: 8 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("stable WebGPU meshlet culling", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga parsing and semantic validation", () => {
    const validation = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-meshlet-culling.wgsl", "--input-kind", "wgsl"], { input: MESHLET_CULL_WGSL, encoding: "utf8" });
    expect(validation.status, validation.stderr).toBe(0);
    expect(validation.stderr).toBe(""); expect(validation.stdout).toContain("Validation successful");
  });

  it("keeps planner records deterministic and detects uint32 draw overflow", () => {
    expect([...meshletPlannerRecord(7, [11, 32, 19, 6])]).toEqual([7, 11, 32, 19, 6, 18, 57, 0]);
    expect(() => meshletPlannerRecord(0, [0, 1, 0xffff_ffff, 1])).toThrow("overflow");
    expect(nextMeshletCapacity(65)).toBe(128);
  });

  it("keeps degenerate, camera-inside, and non-finite cones visible while rejecting definite backfaces", () => {
    expect(meshletNormalConeVisible([0, 0, 0, 1], [0, 0, 1, -1], [0, 0, 1], [0, 0, -10])).toBe(true);
    expect(meshletNormalConeVisible([0, 0, 0, 2], [0, 0, 1, 1], [0, 0, 1], [0, 0, 1])).toBe(true);
    expect(meshletNormalConeVisible([0, 0, 0, 1], [0, 0, 1, 1], [0, 0, 1], [0, 0, 10])).toBe(true);
    expect(meshletNormalConeVisible([0, 0, 0, 1], [0, 0, 1, 1], [0, 0, 1], [0, 0, -10])).toBe(false);
    expect(meshletNormalConeVisible([0, 0, NaN, 1], [0, 0, 1, 1], [0, 0, 1], [0, 0, -10])).toBe(true);
  });

  it("matches standard/reversed depth and skips unsafe near-plane or NaN projections", () => {
    expect(meshletHiZVisible(0.8, [0.2, 0.3, 0.25, 0.1], false)).toBe(false);
    expect(meshletHiZVisible(0.1, [0.2, 0.3, 0.25, 0.1], false)).toBe(true);
    expect(meshletHiZVisible(0.2, [0.7, 0.8, 0.75, 0.9], true)).toBe(false);
    expect(meshletHiZVisible(0.9, [0.7, 0.8, 0.75, 0.9], true)).toBe(true);
    expect(meshletHiZVisible(NaN, [0.5], false)).toBe(true);
    const valid = Array.from({ length: 8 }, () => [0, 0, 0.5, 1]);
    expect(meshletHiZClipTestable(valid, false)).toBe(true);
    expect(meshletHiZClipTestable(valid, true)).toBe(false);
    expect(meshletHiZClipTestable(valid.map((corner, index) => index ? corner : [0, 0, 0, 1]), false)).toBe(false);
    expect(meshletHiZClipTestable(valid.map((corner, index) => index ? corner : [NaN, 0, 0.5, 1]), false)).toBe(false);
  });

  it("allocates one reusable kernel and emits the four stable-compaction stages", () => {
    const f = fixture(), encoder = encoderFixture(), culler = new MeshletCuller(f.session), input = request();
    const result = culler.encode(encoder.encoder, input, view());
    expect(result.mode).toBe("gpu"); if (result.mode !== "gpu") return;
    expect(result.capacity).toBe(64); expect(result.recordStride).toBe(32);
    expect(result.hizTested).toBe(false); expect(result.normalConeTested).toBe(true);
    expect(f.device.createShaderModule).toHaveBeenCalledOnce(); expect(f.device.createComputePipeline).toHaveBeenCalledTimes(4);
    expect(f.allocated).toHaveLength(7); expect(f.textures).toHaveLength(1);
    expect(encoder.passes[0]!.pipelines).toEqual(["Deep meshlet classify pipeline", "Deep meshlet scanLocal pipeline",
      "Deep meshlet scanBlocks pipeline", "Deep meshlet compact pipeline"]);
    expect(encoder.passes[0]!.dispatches).toEqual([1, 1, 1, 1]);
    const uniform = f.writes[0]!.data as ArrayBuffer;
    expect(new Uint32Array(uniform).slice(68, 72)).toEqual(new Uint32Array([64, 64, 1, 4]));
    const writes = f.writes.length, passes = encoder.passes.length;
    expect(culler.encode(encoder.encoder, input, view())).toMatchObject({ mode: "gpu", updated: false });
    expect(f.writes).toHaveLength(writes); expect(encoder.passes).toHaveLength(passes);
  });

  it("uses optional standard/reversed Hi-Z and rebinds without rebuilding pipelines", () => {
    const f = fixture(), encoder = encoderFixture(), culler = new MeshletCuller(f.session), input = request();
    culler.encode(encoder.encoder, input, view());
    const standard = hiz(0, false), withDepth = culler.encode(encoder.encoder, input, view({ hiz: standard }));
    expect(withDepth).toMatchObject({ mode: "gpu", hizTested: true });
    expect((standard.texture as FakeTexture).createView).toHaveBeenCalledOnce();
    expect(f.device.createComputePipeline).toHaveBeenCalledTimes(4);
    const reversed = hiz(1, true), reverseResult = culler.encode(encoder.encoder, { ...input, revision: 1 }, view({ hiz: reversed, reversedZ: true }));
    expect(reverseResult).toMatchObject({ mode: "gpu", hizTested: true });
    expect(() => culler.encode(encoder.encoder, { ...input, revision: 2 }, view({ hiz: reversed }))).toThrow("incompatible");
    expect(() => culler.encode(encoder.encoder, { ...input, revision: 2 }, view({ hiz: hiz(1, true), reversedZ: true }))).toThrow("without a revision");
  });

  it("disables cone culling conservatively for singular transforms and transforms reflections", () => {
    const f = fixture(), encoder = encoderFixture(), culler = new MeshletCuller(f.session), input = request();
    const singular = [...identity]; singular[0] = 0;
    const first = culler.encode(encoder.encoder, input, view({ worldFromObject: singular }));
    expect(first).toMatchObject({ mode: "gpu", normalConeTested: false });
    const reflection = [...identity]; reflection[0] = -1;
    const second = culler.encode(encoder.encoder, { ...input, revision: 1 }, view({ worldFromObject: reflection }));
    expect(second).toMatchObject({ mode: "gpu", normalConeTested: true });
    const uniform = new Float32Array(f.writes.at(-1)!.data as ArrayBuffer);
    expect([...uniform.slice(32, 36)]).toEqual([0, 0, 5, -1]);
  });

  it("keeps revision identity across direct fallback and rejects silent buffer replacement", () => {
    const f = fixture(), encoder = encoderFixture(), culler = new MeshletCuller(f.session), small = request(63);
    expect(culler.encode(encoder.encoder, small, view())).toEqual({ mode: "direct", inputCount: 63, updated: false });
    expect(f.allocated).toHaveLength(0); expect(encoder.raw.beginComputePass).not.toHaveBeenCalled();
    expect(() => culler.encode(encoder.encoder, request(63), view())).toThrow("without a revision");
    expect(() => culler.encode(encoder.encoder, { ...small, revision: -1 }, view())).toThrow();
  });

  it("grows, shrinks, and releases outputs without touching borrowed ABI buffers", () => {
    const f = fixture(), encoder = encoderFixture(), culler = new MeshletCuller(f.session);
    const largeInput = request(513), large = culler.encode(encoder.encoder, largeInput, view());
    expect(large).toMatchObject({ mode: "gpu", capacity: 1024 });
    const firstBuffers = f.allocated.slice();
    const smallInput = request(64, 1), small = culler.encode(encoder.encoder, smallInput, view());
    expect(small).toMatchObject({ mode: "gpu", capacity: 64 });
    expect(firstBuffers.every(value => value.destroy.mock.calls.length === 1)).toBe(true);
    const secondBuffers = f.allocated.slice(firstBuffers.length);
    culler.encode(encoder.encoder, { ...smallInput, count: 63, revision: 2 }, view());
    expect(secondBuffers.every(value => value.destroy.mock.calls.length === 1)).toBe(true);
    expect(largeInput.descriptors.destroy).not.toHaveBeenCalled(); expect(smallInput.bounds.destroy).not.toHaveBeenCalled();
    expect(f.owned.size).toBe(1);
  });

  it("rolls back allocation and invalidates reused output after a write failure", () => {
    const f = fixture(), encoder = encoderFixture(), culler = new MeshletCuller(f.session), input = request();
    f.device.createBuffer.mockImplementationOnce(({ label, size, usage }: GPUBufferDescriptor) => {
      const value = buffer(label ?? "", size, usage); f.allocated.push(value); return value;
    }).mockImplementationOnce(() => { throw new Error("allocation failed"); });
    expect(() => culler.encode(encoder.encoder, input, view())).toThrow("allocation failed");
    expect(f.allocated[0]!.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(1);

    f.device.createBuffer.mockImplementation(({ label, size, usage }: GPUBufferDescriptor) => {
      const value = buffer(label ?? "", size, usage); f.allocated.push(value); return value;
    });
    culler.encode(encoder.encoder, input, view()); const active = f.allocated.slice(-7);
    f.queue.writeBuffer.mockImplementation(() => { throw new Error("write failed"); });
    expect(() => culler.encode(encoder.encoder, { ...input, revision: 1 }, view())).toThrow("write failed");
    expect(active.every(value => value.destroy.mock.calls.length === 1)).toBe(true); expect(f.owned.size).toBe(1);
  });

  it("fails closed for invalid ABI/device/view inputs, then releases all ownership on lost/dispose", () => {
    const f = fixture(), encoder = encoderFixture(), culler = new MeshletCuller(f.session), input = request();
    expect(() => culler.encode(encoder.encoder, { ...input, descriptors: buffer("tiny", 4) }, view())).toThrow("descriptor buffer");
    expect(() => culler.encode(encoder.encoder, input, { ...view(), viewProjection: [...identity.slice(0, 15), NaN] })).toThrow("viewProjection");
    expect(() => culler.encode(encoder.encoder, input, { ...view(), frustum: { planes: [] } })).toThrow("six planes");
    f.device.limits.maxComputeInvocationsPerWorkgroup = 128;
    expect(() => culler.encode(encoder.encoder, input, view())).toThrow("Device limits");
    f.device.limits.maxComputeInvocationsPerWorkgroup = 256;
    culler.encode(encoder.encoder, input, view()); const outputs = f.allocated.slice(), fallback = f.textures[0]!;
    f.rawSession.state = "lost";
    expect(() => culler.encode(encoder.encoder, { ...input, revision: 1 }, view())).toThrow("not ready");
    expect(outputs.every(value => value.destroy.mock.calls.length === 1)).toBe(true);
    expect(fallback.destroy).toHaveBeenCalledOnce(); expect(input.descriptors.destroy).not.toHaveBeenCalled();
    culler.dispose(); culler.dispose(); expect(() => culler.encode(encoder.encoder, input, view())).toThrow("disposed");
  });
});
