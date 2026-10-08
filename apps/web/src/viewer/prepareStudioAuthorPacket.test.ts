import { describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "@bim-studio/deep-engine";
import type { RenderView } from "@bim-studio/deep-engine/webgpu";
import { prepareStudioAuthorPacket, sameImmutableAuthorResources } from "./prepareStudioAuthorPacket";

const packet = (): RenderPacket => ({
  geometries: [{ id: "g", revision: 0, vertices: new Float32Array(18), indices: new Uint32Array([0, 1, 2]) }],
  materials: [{ id: "m", baseColor: [1, 1, 1], roughness: 1, metallic: 0 }],
  instances: [{ id: "i", geometry: "g", material: "m", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
  textures: [{ id: "t", revision: 0, semantic: "baseColor", width: 1, height: 1, data: new Uint8Array([1, 2, 3, 255]) }],
});

describe("resident author instance admission", () => {
  it("accepts generated resources with equal bytes and submits only changed transforms", async () => {
    const before = packet(), after = structuredClone(before);
    (after.instances[0]!.transform as number[])[12] = 7;
    const target = { prepareRenderPacket: vi.fn(), prepareInstanceTransforms: vi.fn().mockResolvedValue({ frame: 2 }) };
    const view = {} as RenderView, signal = new AbortController().signal;
    await prepareStudioAuthorPacket(target, before, after, view, signal);
    expect(target.prepareInstanceTransforms).toHaveBeenCalledWith(after.instances, undefined, view, signal);
    expect(target.prepareRenderPacket).not.toHaveBeenCalled();
  });
  it.each(["geometry", "texture", "material", "mirror", "instance"])("rejects changed %s even at the same resource revision", kind => {
    const before = packet(), after = structuredClone(before);
    if (kind === "geometry") after.geometries[0]!.vertices[0] = 2;
    if (kind === "texture") after.textures![0]!.data[0] = 9;
    if (kind === "material") Object.assign(after.materials[0]!, { roughness: 0.5 });
    if (kind === "mirror") (after.instances[0]!.transform as number[])[0] = -1;
    if (kind === "instance") Object.assign(after.instances[0]!, { id: "other" });
    expect(sameImmutableAuthorResources(before, after)).toBe(false);
  });
  it("uses full admission when the runtime cannot update resident instances", async () => {
    const before = packet(), after = structuredClone(before);
    const target = { prepareRenderPacket: vi.fn(), prepareInstanceTransforms: vi.fn().mockResolvedValue(undefined) };
    await prepareStudioAuthorPacket(target, before, after, {} as RenderView, new AbortController().signal);
    expect(target.prepareRenderPacket).toHaveBeenCalledOnce();
  });
});
