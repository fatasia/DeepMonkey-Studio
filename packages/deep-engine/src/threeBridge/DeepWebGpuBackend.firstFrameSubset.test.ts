import { describe, expect, it, vi } from "vitest";
import { bridge, mesh } from "./testFixture.js";
import { view, runtime } from "./DeepWebGpuBackend.testUtils.js";
import { DeepWebGpuBackend } from "./DeepWebGpuBackend.js";

/** 首帧最小集引导(T11 语义 + 2026-10-07 投影路径推广):create 只决定
 * "发布前等待哪些 main 变体",不改变管线集合内容;时序语义见
 * pbrRendererTypes.PbrPipelineBootstrapOptions。 */
describe("DeepWebGpuBackend first-frame pipeline subset", () => {
  it("derives first-frame main pipeline keys from an independent render packet", async () => {
    const target = runtime(), createRuntime = vi.fn(async () => target);
    const packet = {
      geometries: [], materials: [
        { id: "m-texture", baseColor: [1, 1, 1] as const, metallic: 0, roughness: 1,
          baseColorTexture: { texture: "t", texCoord: 0 as const, uvTransform: [0, 0, 0, 0, 0, 0] as const } },
        { id: "m-plain", baseColor: [1, 1, 1] as const, metallic: 0, roughness: 1, alphaMode: "BLEND" as const, doubleSided: true },
      ],
      instances: [
        { id: "i-1", geometry: "g", material: "m-texture", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
        { id: "i-2", geometry: "g", material: "m-plain", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      ],
    };
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      view, renderPacket: packet,
      renderer: { pipelines: { firstFrameSubset: true, deferDeformation: true } } }, { create: createRuntime });
    const supplied = createRuntime.mock.calls[0]![3]!;
    expect(supplied.pipelines!.deferDeformation).toBe(true);
    expect(supplied.pipelines!.firstFrameMainKeys).toEqual(["material/depth/ccw", "plain/blend/double"]);
    expect(Object.isFrozen(supplied.pipelines!.firstFrameMainKeys)).toBe(true);
    backend.dispose();
  });

  it("derives first-frame main keys by default on the projection path (CPU preview projection)", async () => {
    const target = runtime(), createRuntime = vi.fn(async () => target);
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view }, { create: createRuntime });
    const supplied = createRuntime.mock.calls[0]![3]!;
    // 首帧攻坚 2026-10-07:投影路径缺省即首帧最小集(mesh fixture 无纹理不透明
    // 双面关闭 → plain/depth/ccw);发布只等待首帧必需变体。
    expect(supplied.pipelines!.firstFrameSubset).toBe(true);
    expect(supplied.pipelines!.firstFrameMainKeys).toEqual(["plain/depth/ccw"]);
    expect(Object.isFrozen(supplied.pipelines!.firstFrameMainKeys)).toBe(true);
    backend.dispose();
  });

  it("keeps the full critical path when firstFrameSubset is explicitly disabled", async () => {
    const target = runtime(), createRuntime = vi.fn(async () => target);
    await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view,
      renderer: { pipelines: { firstFrameSubset: false } } }, { create: createRuntime });
    const supplied = createRuntime.mock.calls[0]![3]!;
    expect(supplied.pipelines!.firstFrameMainKeys).toBeUndefined();
    expect(supplied.pipelines!.firstFrameSubset).toBe(false);
  });

  it("keeps the full critical path when firstFrameSubset is set without a render packet or projection", async () => {
    const target = runtime(), createRuntime = vi.fn(async () => target);
    await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      view, renderPacket: { geometries: [], materials: [], instances: [] },
      renderer: { pipelines: { firstFrameSubset: false, deferDeformation: true } } }, { create: createRuntime });
    const supplied = createRuntime.mock.calls[0]![3]!;
    expect(supplied.pipelines!.firstFrameMainKeys).toBeUndefined();
    expect(supplied.pipelines!.deferDeformation).toBe(true);
  });
});
