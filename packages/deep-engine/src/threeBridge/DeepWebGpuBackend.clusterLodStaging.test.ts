import { describe, expect, it, vi } from "vitest";
import { view, runtime } from "./DeepWebGpuBackend.testUtils.js";
import { DeepWebGpuBackend, type DeepWebGpuRenderRuntime } from "./DeepWebGpuBackend.js";
import { bakeClusterLodDag } from "../rayTracing/clusterLodBake.js";
import type { RenderPacket } from "../renderPacket.js";
import type { ClusterLodSceneStaging } from "../webgpu/clusterLodRenderSlot.js";
import type { RenderView } from "../webgpu/pbrRenderer.js";

/** 真 bake（CPU 参考合同层）产出的最小 staging：单三角形、单层。 */
function bakedStaging(geometryId = "g1-author-test"): ClusterLodSceneStaging {
  const baked = bakeClusterLodDag({ geometryId,
    vertices: Float32Array.from([0, 0, 0, 4, 0, 0, 0, 4, 0]),
    indices: Uint32Array.from([0, 1, 2]), level0ClusterSize: 128, levelCount: 1 });
  return { dag: baked.dag, levelGeometry: baked.levelGeometry };
}

function packet(overrides: Partial<RenderPacket> = {}): RenderPacket {
  return { geometries: [{ id: "tri", revision: 1,
      vertices: Float32Array.from([0, 0, 0, 0, 0, 1, 4, 0, 0, 0, 0, 1, 0, 4, 0, 0, 0, 1]),
      indices: Uint32Array.from([0, 1, 2]) }],
    materials: [{ id: "m", baseColor: [1, 1, 1], metallic: 0, roughness: 1 }],
    instances: [{ id: "i1", geometry: "tri", material: "m",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
    ...overrides };
}

function clusterLodRuntime(): DeepWebGpuRenderRuntime & {
  stagings: ClusterLodSceneStaging[]; stageClusterLodScene: ReturnType<typeof vi.fn>;
} {
  const target = runtime();
  const stagings: ClusterLodSceneStaging[] = [];
  const stageClusterLodScene = vi.fn((staging: ClusterLodSceneStaging) => { stagings.push(staging); });
  return { ...target, stageClusterLodScene, stagings };
}

const farView: RenderView = { ...view, eye: [2000, 0, 4] };

describe("DeepWebGpuBackend cluster LOD staging", () => {
  it("stages the author cluster LOD exactly once after the static packet publishes", async () => {
    const target = clusterLodRuntime();
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      view, renderPacket: packet(), renderer: { clusterLod: true },
      clusterLodStaging: bakedStaging() }, { create: vi.fn(async () => target) });
    expect(target.stageClusterLodScene).toHaveBeenCalledTimes(1);
    await backend.prepareRenderPacket(packet(), view);
    expect(target.stageClusterLodScene).toHaveBeenCalledTimes(1);
    expect(backend.clusterLodStagingFailure).toBeUndefined();
    backend.dispose();
  });

  it("localizes staged geometry into the camera-relative render frame", async () => {
    const target = clusterLodRuntime();
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      view: farView, renderPacket: packet(), renderer: { clusterLod: true },
      clusterLodStaging: bakedStaging() }, { create: vi.fn(async () => target) });
    // candidate(eye=[2000,0,4]) → origin=[2000,0,0]（originGrid=1000）。
    expect(target.stagings[0]!.levelGeometry[0]!.vertices)
      .toEqual(Float32Array.from([-2000, 0, 0, -1996, 0, 0, -2000, 4, 0]));
    expect(target.stagings[0]!.levelGeometry[0]!.indices).toEqual(Uint32Array.from([0, 1, 2]));
    backend.dispose();
  });

  it("records stage failures without breaking the render chain", async () => {
    const target = clusterLodRuntime();
    target.stageClusterLodScene = vi.fn(() => { throw new Error("cluster LOD slot is not enabled"); });
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      view, renderPacket: packet(), renderer: { clusterLod: false },
      clusterLodStaging: bakedStaging() }, { create: vi.fn(async () => target) });
    expect(target.stageClusterLodScene).toHaveBeenCalledTimes(1);
    expect((backend.clusterLodStagingFailure as Error).message).toBe("cluster LOD slot is not enabled");
    await expect(backend.prepareView(view)).resolves.toBeTypeOf("object");
    backend.dispose();
  });

  it("records a diagnostic when the runtime cannot stage", async () => {
    const target = runtime();
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      view, renderPacket: packet(), renderer: { clusterLod: true },
      clusterLodStaging: bakedStaging() }, { create: vi.fn(async () => target) });
    expect((backend.clusterLodStagingFailure as Error).message)
      .toBe("Deep runtime does not expose stageClusterLodScene.");
    backend.dispose();
  });

  it("refuses deformation packets for staging with a diagnostic", async () => {
    const target = clusterLodRuntime();
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      view, renderPacket: packet({ deformation: {} as never }), renderer: { clusterLod: true },
      clusterLodStaging: bakedStaging() }, { create: vi.fn(async () => target) });
    expect(target.stageClusterLodScene).not.toHaveBeenCalled();
    expect((backend.clusterLodStagingFailure as Error).message).toContain("deformation");
    backend.dispose();
  });

  it("keeps the renderer untouched when no staging is supplied", async () => {
    const target = clusterLodRuntime(), createRuntime = vi.fn(async () => target);
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      view, renderPacket: packet(), renderer: {} }, { create: createRuntime });
    expect(target.stageClusterLodScene).not.toHaveBeenCalled();
    expect(createRuntime.mock.calls[0]![3]).not.toHaveProperty("clusterLod");
    backend.dispose();
  });

  it.each([null, [], {}, { levelGeometry: [] },
    { dag: { geometryId: "x", leafTriangleTotal: 1, nodes: [] }, levelGeometry: [{ vertices: [1], indices: [1] }] },
    { dag: { geometryId: "x", leafTriangleTotal: 1, nodes: [] },
      levelGeometry: [{ vertices: new Float32Array(3), indices: new Uint32Array(3) }], pixelThreshold: 0 },
  ])("rejects malformed clusterLodStaging %# before creating a runtime", async staging => {
    const createRuntime = vi.fn(async () => runtime());
    await expect(DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      view, renderPacket: packet(), clusterLodStaging: staging as never }, { create: createRuntime }))
      .rejects.toThrow(/clusterLodStaging/);
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("exposes the author bake entry point as the ray-tracing contract passthrough", () => {
    const input = { geometryId: "passthrough", vertices: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2]), level0ClusterSize: 128, levelCount: 1 };
    expect(DeepWebGpuBackend.bakeClusterLodAuthorGeometry(input))
      .toEqual(bakeClusterLodDag(input));
  });
});
