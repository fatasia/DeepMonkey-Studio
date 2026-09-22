import { describe, expect, it } from "vitest";
import type { GeometryResource, PbrMaterial, RenderPacket, RenderInstance } from "../renderPacketTypes.js";
import { traceTlasClosest } from "./tlas.js";
import { buildRenderPacketRayScene } from "./renderPacketRayScene.js";

const geometry: GeometryResource = { id: "triangle", revision: 1,
  vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]) };
const opaque: PbrMaterial = { id: "opaque", baseColor: [0.4, 0.5, 0.6], metallic: 0, roughness: 1 };
const blend: PbrMaterial = { id: "blend", baseColor: [1, 1, 1], metallic: 0, roughness: 1,
  alphaMode: "BLEND", baseColorAlpha: 0.5 };
const transform = (x = 0): Float32Array => new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1,
]);
const instance = (id: string, material: string, x = 0): RenderInstance =>
  ({ id, geometry: geometry.id, material, transform: transform(x) });

describe("RenderPacket RayBackend adapter", () => {
  it("reuses geometry, preserves hit-to-material alignment and converts column-major transforms", () => {
    const packet: RenderPacket = { geometries: [geometry], materials: [opaque],
      instances: [instance("left", "opaque"), instance("right", "opaque", 2)] };
    const scene = buildRenderPacketRayScene(packet);

    expect(scene.tlas.instances[0]!.blas).toBe(scene.tlas.instances[1]!.blas);
    expect(scene.materials.map(value => value.instanceId)).toEqual(["left", "right"]);
    expect(traceTlasClosest(scene.tlas, { ox: 2.2, oy: 0.2, oz: 1, dx: 0, dy: 0, dz: -1, tMax: 4 }))
      .toMatchObject({ instanceId: "right", t: 1 });
  });

  it("omits blended occluders and reports conservative alpha-mask coverage", () => {
    const mask = { ...opaque, id: "mask", alphaMode: "MASK" as const };
    const packet: RenderPacket = { geometries: [geometry], materials: [opaque, blend, mask],
      instances: [instance("solid", "opaque"), instance("glass", "blend", 2), instance("cutout", "mask", 4)] };
    const scene = buildRenderPacketRayScene(packet);

    expect(scene.tlas.instances.map(value => value.id)).toEqual(["solid", "cutout"]);
    expect(scene.excludedTransparentInstances).toBe(1);
    expect(scene.conservativeAlphaMaskInstances).toBe(1);
  });

  it("fails closed for deformation until a baked geometry snapshot is available", () => {
    const packet = { geometries: [geometry], materials: [opaque], instances: [instance("moving", "opaque")],
      deformation: {} } as unknown as RenderPacket;
    expect(() => buildRenderPacketRayScene(packet)).toThrow("baked or undeformed");
  });
});
