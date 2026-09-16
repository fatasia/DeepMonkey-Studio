import { describe, expect, it, vi } from "vitest";
import { createRuntimeIblFixture } from "../../scripts/runtimePackageIblFixture.mjs";
import type { RuntimePrefilteredIbl } from "../runtimePackage/environmentTypes.js";
import { bridge, mesh } from "./testFixture.js";
import type { InstanceUpdate, RenderPacket } from "../renderPacket.js";
import type { FrameMetrics, RenderView } from "../webgpu/pbrRenderer.js";
import type { PbrEnvironmentSource } from "../webgpu/pbrEnvironmentSource.js";
import { DeepWebGpuBackend, type DeepWebGpuRenderRuntime } from "./DeepWebGpuBackend.js";

const view: RenderView = { width: 100, height: 50, pixelRatio: 1, eye: [0, 0, 4], target: [0, 0, 0],
  extent: 2, background: [0, 0, 0], floor: [0, 0, 0], exposure: 1, roughness: 0.5 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function runtime(shadowTier = "high", shadowDepthBytes = 64 * 1024 * 1024):
DeepWebGpuRenderRuntime & { packets: RenderPacket[]; updates: InstanceUpdate[] } {
  const packets: RenderPacket[] = [], updates: InstanceUpdate[] = [];
  return {
    id: "deep-webgpu",
    packets,
    updates,
    setPacketValidated: vi.fn(async (packet: RenderPacket) => { packets.push(packet); }),
    updateInstances: vi.fn((update: InstanceUpdate) => { updates.push(update); }),
    render: vi.fn((_view: RenderView): FrameMetrics | undefined => undefined),
    validateFrame: vi.fn(async (_view: RenderView): Promise<FrameMetrics> =>
      ({ frame: 1, shadowTier, shadowDepthBytes } as FrameMetrics)),
    dispose: vi.fn(),
  };
}

describe("DeepWebGpuBackend environment preparation", () => {
  it("forwards an owned prefiltered payload through the formal backend", async () => {
    const target = runtime(), stage = vi.fn(async (_source: PbrEnvironmentSource) => "staged" as const);
    target.stageEnvironment = stage;
    const source = createRuntimeIblFixture() as RuntimePrefilteredIbl;
    const expected = source.specular.mips[0]!.dataBase64;
    await new DeepWebGpuBackend(target, bridge()).stageEnvironment({ kind: "prefiltered-ibl", environment: source });
    (source.specular.mips[0] as { dataBase64: string }).dataBase64 = "caller changed";
    const supplied = stage.mock.calls[0]![0];
    expect(supplied.kind).toBe("prefiltered-ibl");
    if (supplied.kind !== "prefiltered-ibl") throw Error("Wrong environment kind");
    expect(supplied.environment.specular.mips[0]!.dataBase64).toBe(expected);
    expect(supplied.environment).not.toBe(source);
  });
  it("rejects malformed prefiltered payloads before creating or staging a runtime", async () => {
    const target = runtime(), stage = vi.fn(async () => "staged" as const), create = vi.fn(async () => target);
    target.stageEnvironment = stage;
    const source = createRuntimeIblFixture() as RuntimePrefilteredIbl;
    const environment = { kind: "prefiltered-ibl" as const, environment: { ...source, format: "invalid" as never } };
    await expect(new DeepWebGpuBackend(target, bridge()).stageEnvironment(environment)).rejects.toThrow("profile");
    await expect(DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view, renderer: { environment } }, { create })).rejects.toThrow("profile");
    expect(stage).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
  it.each(["staged", "superseded"] as const)("forwards environment signal and %s result with frozen policy", async result => {
    const gate = deferred<"staged" | "superseded">(), target = runtime();
    const stage = vi.fn((_source: PbrEnvironmentSource, _signal?: AbortSignal) => gate.promise);
    target.stageEnvironment = stage;
    const backend = new DeepWebGpuBackend(target, bridge()), controller = new AbortController();
    const image = { width: 1, height: 1, data: new Float32Array([1, 2, 3]) };
    const backgroundImage = { width: 1, height: 1, data: new Float32Array([3, 2, 1]) };
    const options = { maxUploadBytes: 1024 };
    const source = { kind: "radiance-hdr" as const, image, backgroundImage, options };
    const pending = backend.stageEnvironment(source, controller.signal);
    source.backgroundImage = image; options.maxUploadBytes = 2048;
    const supplied = stage.mock.calls[0]![0];
    expect(stage.mock.calls[0]![1]).toBe(controller.signal);
    expect(supplied).toEqual({ kind: "radiance-hdr", image, backgroundImage, options: { maxUploadBytes: 1024 } });
    expect(Object.isFrozen(supplied)).toBe(true);
    if (supplied.kind !== "radiance-hdr") throw new Error("expected HDR source");
    expect(Object.isFrozen(supplied.options)).toBe(true);
    expect(supplied.image.data).toBe(image.data);
    expect(supplied.backgroundImage?.data).toBe(backgroundImage.data);
    gate.resolve(result); await expect(pending).resolves.toBe(result);
  });

  it("rejects environment changes after disposal and without runtime support", async () => {
    const target = runtime(), backend = new DeepWebGpuBackend(target, bridge());
    await expect(backend.stageEnvironment({ kind: "studio" })).rejects.toThrow("cannot stage");
    const stage = vi.fn(async () => "staged" as const); target.stageEnvironment = stage;
    backend.dispose();
    await expect(backend.stageEnvironment({ kind: "studio" })).rejects.toThrow("disposed");
    expect(stage).not.toHaveBeenCalled();
  });

  it("propagates runtime failure instead of reporting a staged environment", async () => {
    const target = runtime(), failure = new Error("GPU upload rejected");
    target.stageEnvironment = vi.fn(async () => { throw failure; });
    await expect(new DeepWebGpuBackend(target, bridge()).stageEnvironment({ kind: "studio" })).rejects.toBe(failure);
  });

  it.each([null, { width: 0, height: 1, data: new Float32Array(0) },
    { width: 1.5, height: 1, data: new Float32Array(3) },
    { width: 1, height: 1, data: [1, 2, 3] },
    { width: 1, height: 1, data: new Float32Array(4) }].map(image => ({ image })))
  ("rejects malformed HDR image and independent background $image before runtime calls", async ({ image }) => {
    const target = runtime(), stage = vi.fn(async () => "staged" as const); target.stageEnvironment = stage;
    const backend = new DeepWebGpuBackend(target, bridge());
    const valid = { width: 1, height: 1, data: new Float32Array([1, 2, 3]) };
    await expect(backend.stageEnvironment({ kind: "radiance-hdr", image: image as never })).rejects.toThrow("owned RGB32F");
    await expect(backend.stageEnvironment({ kind: "radiance-hdr", image: valid, backgroundImage: image as never })).rejects.toThrow("owned RGB32F");
    expect(stage).not.toHaveBeenCalled();
  });

  it("preserves independent background and frozen options during initial runtime creation", async () => {
    const target = runtime(), create = vi.fn(async () => target);
    const image = { width: 1, height: 1, data: new Float32Array([1, 2, 3]) };
    const backgroundImage = { width: 1, height: 1, data: new Float32Array([3, 2, 1]) };
    const options = { maxUploadBytes: 1024 };
    const pending = DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view, renderer: { environment: {
        kind: "radiance-hdr", image, backgroundImage, options,
      } } }, { create });
    options.maxUploadBytes = 2048;
    const backend = await pending;
    const supplied = create.mock.calls[0]![3]!.environment;
    expect(supplied).toEqual({ kind: "radiance-hdr", image, backgroundImage, options: { maxUploadBytes: 1024 } });
    expect(Object.isFrozen(supplied)).toBe(true); expect(Object.isFrozen(supplied!.options)).toBe(true);
    backend.dispose();
  });

});
