import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import type { RenderView } from "../webgpu/pbrRendererTypes.js";
import { chunkGeometry, chunkGpuFixture, chunkTexture } from "../webgpu/sceneChunkResidency.testUtils.js";
import { PacketBuffers } from "../webgpu/packetBuffers.js";
import type { ResidentPacketProjection } from "../webgpu/residentPacketProjection.js";
import { HLOD_PROXY_MATERIAL_ID, type HlodClusterFramePlan,
  type HlodClusterStreamBinding } from "./hlodClusterStream.js";
import { buildTestHlodPackage } from "./hlodClusterStream.testUtils.js";
import { AuthorChunkCatalog } from "./authorChunkCatalog.js";
import { AuthorChunkStream } from "./authorChunkStream.js";
import { DeepWebGpuBackend } from "./DeepWebGpuBackend.js";
import { bridge, mesh } from "./testFixture.js";

const view: RenderView = { width: 100, height: 100, pixelRatio: 1, eye: [0, 0, 5], target: [0, 0, 0],
  extent: 2, background: [0, 0, 0], floor: [0, 0, 0], exposure: 1, roughness: 0.5 };
function packet(x = 0, revision = 3): RenderPacket {
  return { geometries: [{ ...chunkGeometry("mesh"), revision }], textures: [chunkTexture("texture")],
    materials: [{ id: "mat", baseColor: [1, 1, 1], metallic: 0, roughness: 1, baseColorTexture: { texture: "texture" } }],
    instances: [{ id: "one", geometry: "mesh", material: "mat", castShadow: false,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1] }] };
}
function fixture(meshlets = false, clusterResources?: ConstructorParameters<typeof AuthorChunkStream>[2]) {
  const f = chunkGpuFixture(); Object.assign(f.session.device, { createBindGroup: vi.fn(() => ({})) });
  const buffers = new PacketBuffers(f.session, { material: {} as GPUBindGroupLayout });
  const target = { session: f.session,
    stageResidentPacketValidated: vi.fn(async (projection: ResidentPacketProjection, signal?: AbortSignal) => {
      await buffers.stageResidentProjectionValidated(projection, signal);
    }), cancelResidentPacketStage: vi.fn(() => buffers.cancelPendingPacketStage()) };
  const stream = new AuthorChunkStream(target, meshlets, clusterResources);
  return { ...f, buffers, target, stream, clean() { stream.dispose(); buffers.dispose(); expect(f.owned.size).toBe(0); } };
}
beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8, STORAGE: 128, UNIFORM: 64 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
});
afterEach(() => vi.unstubAllGlobals());
describe("author chunk formal staging", () => {
  it.each([false, true])("forwards meshlets=%s through the resident geometry uploader", async enabled => {
    const f = fixture(enabled); await f.stream.sync(packet(), true, view);
    const mesh = f.target.stageResidentPacketValidated.mock.calls[0]![0].geometry("mesh")!.mesh;
    expect(mesh.meshletFallback).toBe(enabled ? "small-geometry" : undefined); f.clean();
  });
  it("accepts an entirely empty author packet without Infinity bounds or static allocations", async () => {
    const f = fixture(); await f.stream.sync({ geometries: [], materials: [], instances: [] }, true, view);
    expect(f.stream.diagnostics).toMatchObject({ chunkCount: 0, visibleChunks: 0, residentGpuBytes: 0 });
    f.buffers.publishResidentProjection();
    expect(f.target.stageResidentPacketValidated.mock.calls[0]![0].batches).toEqual([]);
    expect(f.target.stageResidentPacketValidated.mock.calls[0]![0].released).toBe(false);
    expect(f.device.createTexture).not.toHaveBeenCalled(); f.clean();
  });
  it("updates transforms with existing geometry and texture handles and no static uploads", async () => {
    const f = fixture(); await f.stream.sync(packet(), true, view); f.buffers.publishResidentProjection();
    const first = f.target.stageResidentPacketValidated.mock.calls[0]![0];
    const geometry = first.geometry("mesh"), texture = first.texture("texture");
    const textureUploads = f.device.queue.writeTexture.mock.calls.length;
    const staticBuffers = [geometry!.mesh.vertices, geometry!.mesh.indices, geometry!.mesh.tangents];
    const staticWrites = f.device.queue.writeBuffer.mock.calls.filter(call => staticBuffers.includes(call[0])).length;
    expect(staticWrites).toBeGreaterThan(0);
    await f.stream.sync(packet(1), false, view);
    const next = f.target.stageResidentPacketValidated.mock.calls[1]![0];
    expect(next.geometry("mesh")).toBe(geometry); expect(next.texture("texture")).toBe(texture);
    expect(next.batches[0]!.source.data[3]).toBe(1);
    expect(f.device.queue.writeTexture).toHaveBeenCalledTimes(textureUploads);
    expect(f.device.queue.writeBuffer.mock.calls.filter(call => staticBuffers.includes(call[0]))).toHaveLength(staticWrites);
    f.buffers.publishResidentProjection(); expect(first.released).toBe(true); f.clean();
  });
  it("retains every real author LOD level while selection revisions update only frame metadata", async () => {
    const f = fixture();
    const source = (revision: number, selectedLevels: readonly number[]): RenderPacket => {
      const base = packet(); return { ...base, geometries: [...base.geometries, chunkGeometry("low")],
        instances: base.instances.map(instance => ({ ...instance, lod: { strategy: "author-selected", revision,
          levels: [{ geometry: "mesh", distance: 0, hysteresis: 0 }, { geometry: "low", distance: 10, hysteresis: 0 }], selectedLevels } })) };
    };
    await f.stream.sync(source(1, [0]), true, view); f.buffers.publishResidentProjection();
    const first = f.target.stageResidentPacketValidated.mock.calls[0]![0];
    for (const selected of [[], [1], [0, 1]]) {
      await f.stream.sync(source(selected.length + 2, selected), false, view);
      const next = f.target.stageResidentPacketValidated.mock.calls.at(-1)![0];
      expect(next.geometry("mesh")).toBe(first.geometry("mesh")); expect(next.geometry("low")).toBe(first.geometry("low"));
      expect(next.batches[0]!.source.lod).toMatchObject({ strategy: "author-selected", selectedLevels: selected });
      f.buffers.publishResidentProjection();
    }
    f.clean();
  });
  it("keeps active catalog and projection after candidate upload failure, then retries", async () => {
    const f = fixture(); await f.stream.sync(packet(), true, view); f.buffers.publishResidentProjection();
    const active = f.target.stageResidentPacketValidated.mock.calls[0]![0], before = f.stream.diagnostics;
    f.failTexture(true); await expect(f.stream.sync(packet(1, 4), true, view)).rejects.toThrow();
    expect(active.released).toBe(false); expect(f.stream.diagnostics).toBe(before);
    expect(f.buffers.publishResidentProjection()).toBe(false);
    f.failTexture(false); await f.stream.sync(packet(1, 4), true, view); f.buffers.publishResidentProjection();
    expect(active.released).toBe(true); f.clean();
  });
  it("releases a staged candidate cancelled immediately after validation", async () => {
    const f = fixture(), controller = new AbortController();
    const original = f.target.stageResidentPacketValidated.getMockImplementation()!;
    f.target.stageResidentPacketValidated.mockImplementationOnce(async (...args) => { await original(...args); controller.abort(); });
    await expect(f.stream.sync(packet(), true, view, controller.signal)).rejects.toThrow();
    expect(f.buffers.publishResidentProjection()).toBe(false); expect(f.stream.hasCatalog).toBe(false); f.clean();
  });
  it("does not build a static catalog for deformation and preserves active leases until full publication", async () => {
    const f = fixture(); await f.stream.sync(packet(), true, view); f.buffers.publishResidentProjection();
    expect(await f.stream.sync({ ...packet(), deformation: {} as never }, true, view)).toBe(false);
    expect(f.stream.hasCatalog).toBe(true); f.stream.fullPacketPublished("deformation");
    expect(f.stream.diagnostics.path).toBe("full-packet"); f.clean();
  });
  it("rejects pre-aborted work without allocations and permits a subsequent frame", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(f.stream.sync(packet(), true, view, controller.signal)).rejects.toThrow();
    expect(f.owned.size).toBe(0); await f.stream.sync(packet(), true, view); f.clean();
  });
  it("cancels queued work on dispose and never touches borrowed author arrays", async () => {
    const f = fixture(), source = packet(), before = source.geometries[0]!.vertices.slice();
    const pending = f.stream.sync(source, true, view); f.stream.dispose();
    await expect(pending).rejects.toThrow(); expect(source.geometries[0]!.vertices).toEqual(before); f.clean();
  });
  it("streams an empty required set and restores visibility on camera return", async () => {
    const f = fixture(); await f.stream.sync(packet(), true, view); f.buffers.publishResidentProjection();
    await f.stream.sync(packet(100), false, view); f.buffers.publishResidentProjection();
    expect(f.stream.diagnostics.visibleChunks).toBe(0);
    await f.stream.sync(packet(), false, view); f.buffers.publishResidentProjection();
    expect(f.stream.diagnostics.visibleChunks).toBe(1); f.clean();
  });
  it("streams an independent RenderPacket and updates camera closure without changing author identity", async () => {
    const f = fixture();
    const source = { ...packet(), objectBindings: [{ nodeId: "author-one", instanceIds: ["one"] }] };
    const runtime = { ...f.target, id: "deep-webgpu", setPacketValidated: vi.fn(async () => {}),
      updateInstances: vi.fn(), render: vi.fn(() => ({ frame: 1 } as never)),
      validateFrame: vi.fn(async () => ({ frame: 1, shadowTier: "high", shadowDepthBytes: 64 * 1024 * 1024 } as never)), dispose: vi.fn(() => f.buffers.dispose()) };
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      renderPacket: source, view, authorChunks: true }, { create: vi.fn(async () => runtime) });
    expect(runtime.setPacketValidated).not.toHaveBeenCalled();
    expect(backend.chunkStreaming).toMatchObject({ path: "scene-chunks", visibleChunks: 1 });
    expect(backend.modelIdForInstanceId("one")).toBe("author-one");
    f.buffers.publishResidentProjection();
    const first = f.target.stageResidentPacketValidated.mock.calls[0]![0];
    const distant = { ...view, eye: [100, 0, 5], target: [100, 0, 0] };
    backend.render(distant);
    await vi.waitFor(() => expect(backend.chunkStreaming?.visibleChunks).toBe(0));
    expect(backend.modelIdForInstanceId("one")).toBe("author-one");
    expect(source.instances[0]!.id).toBe("one");
    f.buffers.publishResidentProjection();
    backend.render(view);
    await vi.waitFor(() => expect(backend.chunkStreaming?.visibleChunks).toBe(1));
    expect(f.target.stageResidentPacketValidated).toHaveBeenCalledTimes(3);
    expect(first.released).toBe(true);
    backend.dispose(); expect(f.owned.size).toBe(0);
  });
  it("retains the old independent frame after camera-stage failure and recovers on a new view", async () => {
    const f = fixture();
    const runtime = { ...f.target, id: "deep-webgpu", setPacketValidated: vi.fn(async () => {}),
      updateInstances: vi.fn(), render: vi.fn(() => ({ frame: 1 } as never)),
      validateFrame: vi.fn(async () => ({ frame: 1, shadowTier: "high", shadowDepthBytes: 64 * 1024 * 1024 } as never)), dispose: vi.fn(() => f.buffers.dispose()) };
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      renderPacket: packet(), view, authorChunks: true }, { create: vi.fn(async () => runtime) });
    f.buffers.publishResidentProjection();
    const active = f.target.stageResidentPacketValidated.mock.calls[0]![0];
    f.device.popErrorScope.mockResolvedValueOnce({ message: "validation failed" } as GPUError);
    backend.render({ ...view, eye: [100, 0, 5], target: [100, 0, 0] });
    await vi.waitFor(() => expect(backend.packetViewStreamFailure).toBeDefined());
    expect(active.released).toBe(false);
    expect(f.buffers.publishResidentProjection()).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 1_005));
    backend.render({ ...view, eye: [101, 0, 5], target: [101, 0, 0] });
    await vi.waitFor(() => expect(backend.packetViewStreamFailure).toBeUndefined());
    expect(backend.chunkStreaming?.visibleChunks).toBe(0);
    f.buffers.publishResidentProjection(); backend.dispose(); expect(f.owned.size).toBe(0);
  });
  it("connects the real Three backend sync to a single resident stage and preserves ordinary legacy default", async () => {
    const f = fixture(), author = mesh(); author.updateMatrixWorld(true);
    const runtime = { ...f.target, id: "deep-webgpu", setPacketValidated: vi.fn(async () => {}),
      updateInstances: vi.fn(), render: vi.fn(), validateFrame: vi.fn(), dispose: vi.fn(() => f.buffers.dispose()) };
    const backend = new DeepWebGpuBackend(runtime, bridge(), { authorChunks: true });
    await backend.sync(author, 1, undefined, view); f.buffers.publishResidentProjection();
    expect(runtime.setPacketValidated).not.toHaveBeenCalled(); expect(backend.chunkStreaming?.chunkCount).toBe(1);
    author.position.x = 1; author.updateMatrixWorld(true); await backend.sync(author, 1, undefined, view);
    expect(f.target.stageResidentPacketValidated).toHaveBeenCalledTimes(2); expect(runtime.updateInstances).not.toHaveBeenCalled();
    backend.dispose(); expect(f.owned.size).toBe(0);
    const legacy = new DeepWebGpuBackend({ ...runtime, dispose: vi.fn() }, bridge());
    await legacy.sync(author, 1, undefined, view); expect(runtime.setPacketValidated).toHaveBeenCalledOnce(); legacy.dispose();
  });
  it("restores demand metadata after validation failure and supersedes concurrent queued updates", async () => {
    const f = fixture(); await f.stream.sync(packet(), true, view); f.buffers.publishResidentProjection();
    f.device.popErrorScope.mockResolvedValueOnce({ message: "validation" } as GPUError);
    await expect(f.stream.sync(packet(100), false, view)).rejects.toThrow();
    expect(f.stream.diagnostics.visibleChunks).toBe(1);
    const superseded = f.stream.sync(packet(2), false, view);
    const newest = f.stream.sync(packet(1), false, view);
    await expect(superseded).rejects.toThrow(); await newest;
    expect(f.target.stageResidentPacketValidated.mock.calls.at(-1)![0].batches[0]!.source.data[3]).toBe(1); f.clean();
  });
});
describe("author chunk spatial demand", () => {
  it("omits remote non-casters but keeps remote shadow casters required", () => {
    expect(new AuthorChunkCatalog(packet(100)).demand(view)).toEqual([]);
    const source = packet(100);
    const catalog = new AuthorChunkCatalog({ ...source, instances: source.instances.map(value => ({ ...value, castShadow: true })) });
    expect(catalog.demand(view)).toMatchObject([{ mode: "visible" }]);
  });
  it("updates the sparse demand closure when a remote batch changes shadow casting", () => {
    const source = packet(100);
    const catalog = new AuthorChunkCatalog(source);
    expect(catalog.demand(view)).toEqual([]);
    const caster = { ...source, instances: source.instances.map(value => ({ ...value, castShadow: true })) };
    expect(catalog.update(caster)).toBe(true);
    expect(catalog.demand(view)).toMatchObject([{ mode: "visible" }]);
    expect(catalog.update(source)).toBe(true);
    expect(catalog.demand(view)).toEqual([]);
  });
  it("keeps author data unchanged and stable chunk identity across transforms", () => {
    const source = packet(), snapshot = source.geometries[0]!.vertices.slice(), catalog = new AuthorChunkCatalog(source);
    expect(catalog.update(packet(2))).toBe(true); expect(catalog.chunks[0]!.key).toBe("author-chunk-0");
    expect(source.geometries[0]!.vertices).toEqual(snapshot); expect(source.instances[0]!.transform[12]).toBe(0);
  });
});

const TRANSLATE = (x: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];

/** 双块 + 簇代理夹具:meshA 批 = [a1,a2](chunk-0),meshB 批 = [b1](chunk-1),代理 12 三角盒。 */
function clusterPacket(castShadow = false): RenderPacket {
  return { geometries: [chunkGeometry("meshA"), chunkGeometry("meshB"),
      { id: "hlod-proxy-box", revision: 1,
        vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]) }],
    materials: [{ id: "mat", baseColor: [1, 1, 1], metallic: 0, roughness: 1 },
      { id: HLOD_PROXY_MATERIAL_ID, baseColor: [0.5, 0.5, 0.5], metallic: 0, roughness: 1 }],
    instances: [
      { id: "a1", geometry: "meshA", material: "mat", ...(castShadow ? {} : { castShadow: false }), transform: TRANSLATE(0) },
      { id: "a2", geometry: "meshA", material: "mat", ...(castShadow ? {} : { castShadow: false }), transform: TRANSLATE(1) },
      { id: "b1", geometry: "meshB", material: "mat", ...(castShadow ? {} : { castShadow: false }), transform: TRANSLATE(2) }] };
}
function clusterResources(packetValue: RenderPacket): ConstructorParameters<typeof AuthorChunkStream>[2] {
  return { geometries: new Map(packetValue.geometries.map(geometry => [geometry.id, geometry])),
    materials: packetValue.materials };
}
function clusterPlan(hidden: readonly string[], proxyIds: readonly string[] = [],
  suppressed = false): HlodClusterFramePlan {
  return { origin: [0, 0, 0], hiddenInstanceIds: new Set(hidden),
    activeProxyDraws: new Map(proxyIds.map(id => [id, { instanceId: id, geometryId: "hlod-proxy-box",
      transform: TRANSLATE(1) }])), collapsedNodeCount: proxyIds.length, suppressed };
}
describe("author chunk cluster culling", () => {
  it("omits fully hidden non-caster chunks, registers the active proxy and stages both draw sets", async () => {
    const packetValue = clusterPacket(), f = fixture(false, clusterResources(packetValue));
    await f.stream.sync(packetValue, true, view, undefined, clusterPlan(["a1", "a2"], ["px-0"]));
    f.buffers.publishResidentProjection();
    const staged = f.target.stageResidentPacketValidated.mock.calls.at(-1)![0];
    expect(staged.batches.map((batch: { source: { geometry: string } }) => batch.source.geometry).sort())
      .toEqual(["hlod-proxy-box", "meshB"]);
    expect(f.stream.diagnostics).toMatchObject({ hlodHiddenInstances: 2, hlodActiveProxies: 1,
      hlodCollapsedNodes: 1, visibleChunks: 2, prefetchChunks: 0 });
    f.clean();
  });
  it("zeroes only hidden instance rows in partially hidden chunks and keeps batch identity", async () => {
    const packetValue = clusterPacket(), f = fixture(false, clusterResources(packetValue));
    await f.stream.sync(packetValue, true, view, undefined, clusterPlan(["a1"]));
    f.buffers.publishResidentProjection();
    const staged = f.target.stageResidentPacketValidated.mock.calls.at(-1)![0];
    const meshA = staged.batches.find((batch: { source: { geometry: string } }) => batch.source.geometry === "meshA");
    expect(meshA!.source.instanceIds).toEqual(["a1", "a2"]);
    expect(meshA!.source.data.slice(0, 24).every((value: number) => value === 0)).toBe(true);
    expect(meshA!.source.data[36 + 3]).toBe(1); // a2 行保持(tx=1)。
    expect(meshA!.source.data.slice(24, 36).some((value: number) => value !== 0)).toBe(true); // a1 材质记录保留。
    expect(f.stream.diagnostics).toMatchObject({ hlodHiddenInstances: 1, hlodActiveProxies: 0, visibleChunks: 2 });
    // 补偿不破坏编目身份:后续普通变换更新仍走增量路径(无计划帧不携带 hlod 字段)。
    await f.stream.sync({ ...packetValue, instances: packetValue.instances.map(instance =>
      ({ ...instance, transform: TRANSLATE(9) })) }, false, view);
    expect(f.stream.diagnostics.hlodHiddenInstances).toBeUndefined();
    f.clean();
  });
  it("omits fully hidden shadow casters too — the active cluster proxy takes over shadow casting", async () => {
    const packetValue = clusterPacket(true), f = fixture(false, clusterResources(packetValue));
    await f.stream.sync(packetValue, true, view, undefined, clusterPlan(["a1", "a2"]));
    f.buffers.publishResidentProjection();
    const staged = f.target.stageResidentPacketValidated.mock.calls.at(-1)![0];
    expect(staged.batches.some((batch: { source: { geometry: string } }) => batch.source.geometry === "meshA")).toBe(false);
    expect(f.stream.diagnostics).toMatchObject({ visibleChunks: 1, prefetchChunks: 0, hlodHiddenInstances: 2 });
    f.clean();
  });
  it("restores original chunks when the next plan is suppressed or empty", async () => {
    const packetValue = clusterPacket(), f = fixture(false, clusterResources(packetValue));
    await f.stream.sync(packetValue, true, view, undefined, clusterPlan(["a1", "a2"], ["px-0"]));
    f.buffers.publishResidentProjection();
    await f.stream.syncView(view, undefined, clusterPlan([], [], true));
    f.buffers.publishResidentProjection();
    const staged = f.target.stageResidentPacketValidated.mock.calls.at(-1)![0];
    expect(staged.batches.map((batch: { source: { geometry: string } }) => batch.source.geometry).sort())
      .toEqual(["meshA", "meshB"]);
    expect(f.stream.diagnostics).toMatchObject({ hlodHiddenInstances: 0, hlodActiveProxies: 0,
      hlodCollapsedNodes: 0, visibleChunks: 2 });
    f.clean();
  });
  it("fails closed when an active proxy geometry is not distributed in the packet", async () => {
    const packetValue = clusterPacket(), f = fixture(false, clusterResources(packetValue));
    await expect(f.stream.sync(packetValue, true, view, undefined,
      { ...clusterPlan(["a1"], []), activeProxyDraws: new Map([["px-x", { instanceId: "px-x",
        geometryId: "hlod-proxy-missing", transform: TRANSLATE(0) }]]) })).rejects.toThrow(/not distributed/);
    f.clean();
  });
});

describe("DeepWebGpuBackend cluster decisions", () => {
  function clusterRuntime(f: ReturnType<typeof fixture>) {
    return { ...f.target, id: "deep-webgpu", setPacketValidated: vi.fn(async () => {}),
      updateInstances: vi.fn(), render: vi.fn(() => ({ frame: 1 } as never)),
      validateFrame: vi.fn(async () => ({ frame: 1, shadowTier: "high", shadowDepthBytes: 64 * 1024 * 1024 } as never)),
      dispose: vi.fn(() => f.buffers.dispose()) };
  }
  function backendBinding(packetValue: RenderPacket): HlodClusterStreamBinding[] {
    const instanceIds = packetValue.instances.map(instance => instance.id);
    const pkg = buildTestHlodPackage(instanceIds.map((id, index) => ({ id: `api:${id}`,
      position: [packetValue.instances[index]!.transform[12]!, 0, 0] as [number, number, number], radius: 0.5 })));
    const rootProxy = pkg.manifest.proxies[0]!;
    return [{ manifest: pkg.manifest,
      instanceIdsByNode: new Map(instanceIds.map(id => [`api:${id}`, [id]])),
      proxyDrawsByNode: new Map([[rootProxy.nodeId, [{ instanceId: "px-root", geometryId: "hlod-proxy-box",
        transform: TRANSLATE(0) }]]]),
      decisionFromWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }];
  }
  it("applies cluster decisions end-to-end through prepareView and the camera stream path", async () => {
    const f = fixture();
    const packetValue = { ...clusterPacket(),
      objectBindings: [{ nodeId: "author-a", instanceIds: ["a1"] }] };
    const runtime = clusterRuntime(f);
    const initial = { ...view, eye: [1, 0, 20], target: [1, 0, 0] };
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      renderPacket: packetValue, view: initial, authorChunks: true,
      hlodClusters: backendBinding(packetValue) }, { create: vi.fn(async () => runtime) });
    expect(backend.chunkStreaming).toMatchObject({ path: "scene-chunks", visibleChunks: 2 }); // meshA 批 + meshB 批。
    const distant = { ...view, eye: [1, 0, 30], target: [1, 0, 0] };
    backend.render(distant);
    await vi.waitFor(() => expect(backend.chunkStreaming?.hlodHiddenInstances).toBe(3));
    f.buffers.publishResidentProjection();
    // 强制原件驻留:编辑辅助 overlay 顶点非空 → 折叠关闭,原件恢复。
    backend.render({ ...view, editorOverlay: { revision: 1, vertices: new Float32Array(24) } });
    await vi.waitFor(() => expect(backend.chunkStreaming?.hlodHiddenInstances).toBe(0));
    f.buffers.publishResidentProjection();
    expect(backend.modelIdForInstanceId("a1")).toBe("author-a");
    backend.dispose(); expect(f.owned.size).toBe(0);
  });
  it("publishes cluster hiding through updateInstances on the non-streaming path", async () => {
    const f = fixture();
    const packetValue = clusterPacket();
    const runtime = clusterRuntime(f);
    delete (runtime as { session?: unknown }).session;
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      renderPacket: packetValue, view, hlodClusters: backendBinding(packetValue) },
      { create: vi.fn(async () => runtime) });
    const published = runtime.setPacketValidated.mock.calls[0]![0] as RenderPacket;
    expect(published.instances).toHaveLength(4); // 3 原件 + 全量代理(几何引用完整性)。
    const px = published.instances.find(instance => instance.id === "px-root")!;
    expect(px.transform[0]).toBeCloseTo(1e-6); // 近景无折叠:代理缩放待命。
    const distant = { ...view, eye: [1, 0, 30], target: [1, 0, 0] };
    await backend.prepareView(distant);
    const updated = runtime.updateInstances.mock.calls.at(-1)![0] as { instances: RenderPacket["instances"] };
    expect(updated.instances).toHaveLength(4);
    expect(updated.instances.filter(instance => instance.id.startsWith("a")
      || instance.id === "b1").every(instance => instance.transform[0]! < 1e-5)).toBe(true);
    expect(updated.instances.find(instance => instance.id === "px-root")!.transform[0]).toBe(1);
    backend.dispose(); expect(f.owned.size).toBe(0);
  });
});
