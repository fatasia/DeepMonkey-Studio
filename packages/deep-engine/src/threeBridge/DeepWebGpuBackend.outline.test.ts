import { describe, expect, it, vi } from "vitest";
import { view, runtime } from "./DeepWebGpuBackend.testUtils.js";
import { DeepWebGpuBackend } from "./DeepWebGpuBackend.js";

const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
const packet = (outlineB = false) => ({
  geometries: [], materials: [],
  instances: [
    { id: "a", geometry: "g", material: "m", transform: [...transform] },
    { id: "b-1", geometry: "g", material: "m", transform: [...transform], ...(outlineB ? { outline: true } : {}) },
    { id: "b-2", geometry: "g", material: "m", transform: [...transform], ...(outlineB ? { outline: true } : {}) },
  ],
  objectBindings: [{ nodeId: "model-a", instanceIds: ["a"] }, { nodeId: "model-b", instanceIds: ["b-1", "b-2"] }],
});
const create = async (renderPacket: ReturnType<typeof packet>) => {
  const target = runtime();
  const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined, view,
    renderPacket: renderPacket as never }, { create: vi.fn(async () => target) });
  return { backend, target };
};

describe("DeepWebGpuBackend host-driven object outline", () => {
  it("flips outline bits per author model through updateInstances only, without republishing the packet", async () => {
    const { backend, target } = await create(packet());
    const publishCalls = vi.mocked(target.setPacketValidated).mock.calls.length;
    expect(backend.setOutlinedModels(new Set())).toBe("unchanged");
    expect(target.updateInstances).not.toHaveBeenCalled();
    expect(backend.setOutlinedModels(new Set(["model-b"]))).toBe("updated");
    expect(target.updateInstances).toHaveBeenCalledTimes(1);
    const update = vi.mocked(target.updateInstances).mock.calls[0]![0];
    expect(update.instances.map(instance => instance.outline === true)).toEqual([false, true, true]);
    expect(backend.setOutlinedModels(new Set(["model-b"]))).toBe("unchanged");
    expect(backend.setOutlinedModels(new Set(["model-a"]))).toBe("updated");
    const flipped = vi.mocked(target.updateInstances).mock.calls[1]![0];
    expect(flipped.instances.map(instance => instance.outline === true)).toEqual([true, false, false]);
    expect(flipped.instances[1]).not.toHaveProperty("outline");
    expect(vi.mocked(target.setPacketValidated).mock.calls.length).toBe(publishCalls);
    backend.dispose();
  });

  it("diffs against the compiled outline bits", async () => {
    const { backend, target } = await create(packet(true));
    expect(backend.setOutlinedModels(new Set(["model-b"]))).toBe("unchanged");
    expect(target.updateInstances).not.toHaveBeenCalled();
    expect(backend.setOutlinedModels(new Set(["model-a"]))).toBe("updated");
    const update = vi.mocked(target.updateInstances).mock.calls[0]![0];
    expect(update.instances.map(instance => instance.outline === true)).toEqual([true, false, false]);
    backend.dispose();
  });

  it("falls back to the instance id when the packet carries no object bindings", async () => {
    const { objectBindings: _bindings, ...unbound } = packet();
    const { backend, target } = await create(unbound as never);
    expect(backend.setOutlinedModels(new Set(["b-2"]))).toBe("updated");
    expect(vi.mocked(target.updateInstances).mock.calls[0]![0].instances.map(instance => instance.outline === true)).toEqual([false, false, true]);
    backend.dispose();
  });

  it("reports unsupported for a deformation packet and resets the override when a new packet is published", async () => {
    const deformed = { ...packet(), deformation: { sources: [], poses: [] } };
    const unsupported = await create(deformed as never);
    expect(unsupported.backend.setOutlinedModels(new Set(["model-b"]))).toBe("unsupported");
    expect(unsupported.target.updateInstances).not.toHaveBeenCalled();
    unsupported.backend.dispose();
    const { backend, target } = await create(packet());
    expect(backend.setOutlinedModels(new Set(["model-b"]))).toBe("updated");
    await backend.prepareRenderPacket(packet(), view);
    vi.mocked(target.updateInstances).mockClear();
    expect(backend.setOutlinedModels(new Set(["model-b"]))).toBe("updated");
    expect(vi.mocked(target.updateInstances).mock.calls[0]![0].instances.map(instance => instance.outline === true)).toEqual([false, true, true]);
    backend.dispose();
    expect(() => backend.setOutlinedModels(new Set())).toThrow();
  });
});

