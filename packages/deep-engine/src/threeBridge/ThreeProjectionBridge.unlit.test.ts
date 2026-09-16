import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { prepareRenderPacket } from "../renderPacket.js";
import { materializeRuntimeRenderPacket } from "../runtimePackage/renderPacket.js";
import { bridge, project } from "./testFixture.js";

function basic() { return new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ color: "#808040" })); }
function texture() {
  const map = new THREE.DataTexture(new Uint8Array([128, 64, 32, 128]), 1, 1);
  map.colorSpace = THREE.SRGBColorSpace; map.needsUpdate = true;
  return map;
}

describe("Three MeshBasicMaterial through the shared renderer", () => {
  it.each([false, true])("projects unlit with texture=%s and preserves owned sRGB pixels/UV", textured => {
    const author = basic();
    if (textured) { author.material.map = texture(); author.material.map.offset.set(0.2, 0.3); }
    const packet = project(bridge(), author).packet, material = packet.materials[0]!;
    expect(material).toMatchObject({ shadingModel: "unlit", metallic: 0, roughness: 1 });
    expect(material.baseColor).toEqual(author.material.color.toArray());
    const prepared = prepareRenderPacket(packet);
    expect(prepared.batches[0]!.data[31]! & 64).toBe(64);
    if (textured) {
      expect(material.baseColorTexture?.offset).toEqual([Math.fround(0.2), Math.fround(0.3)]);
      expect(prepared.textures[0]!.format).toBe("rgba8unorm-srgb");
      expect(Array.from(prepared.textures[0]!.levels[0]!.data)).toEqual([128, 64, 32, 128]);
      expect(prepared.textures[0]!.levels[0]!.data).not.toBe(author.material.map!.image.data);
    } else expect(packet.textures).toHaveLength(0);
  });

  it.each(["OPAQUE", "MASK", "BLEND"] as const)("packs %s independently of unlit, fog, receive and double side", mode => {
    const author = basic(); author.material.fog = false; author.material.side = THREE.DoubleSide;
    author.material.map = texture();
    if (mode === "MASK") { author.material.alphaTest = 0.2; author.material.opacity = 0.7; }
    if (mode === "BLEND") Object.assign(author.material, { transparent: true, opacity: 0.4, depthWrite: false, forceSinglePass: true });
    const packet = project(bridge(), author).packet, batch = prepareRenderPacket(packet).batches[0]!;
    expect(batch.data[31]).toBe(64 + 32 + 16 + 1 + (mode === "MASK" ? 2 : mode === "BLEND" ? 4 : 0));
    expect(batch.data[35]).toBeCloseTo(author.material.opacity);
    const restored = materializeRuntimeRenderPacket(JSON.parse(JSON.stringify(packet)), "$.packet");
    expect(restored.materials[0]!.shadingModel).toBe("unlit");
    expect(prepareRenderPacket(restored).batches[0]!.data[31]).toBe(batch.data[31]);
  });

  it("switches Standard to Basic without replacing geometry or batch keys", () => {
    const material = new THREE.MeshStandardMaterial();
    const author = new THREE.Mesh<THREE.BoxGeometry, THREE.Material>(new THREE.BoxGeometry(), material), target = bridge();
    const first = project(target, author); first.acknowledge();
    author.material = new THREE.MeshBasicMaterial();
    const second = project(target, author);
    expect(second.update).toBe("instances");
    expect(prepareRenderPacket(second.packet).batches[0]!.key).toBe(prepareRenderPacket(first.packet).batches[0]!.key);
  });

  it("keeps lit and unlit flags independent inside a shared geometry draw", () => {
    const unlit = basic(), lit = new THREE.Mesh(unlit.geometry, new THREE.MeshStandardMaterial());
    unlit.receiveShadow = true; lit.receiveShadow = true;
    const group = new THREE.Group(); group.add(lit, unlit);
    const batches = prepareRenderPacket(project(bridge(), group).packet).batches;
    expect(batches).toHaveLength(1);
    expect([batches[0]!.data[31], batches[0]!.data[67]]).toEqual([0, 64]);
  });

  it.each(["lightMap", "aoMap", "specularMap", "alphaMap", "envMap"] as const)("rejects unsupported Basic %s explicitly", field => {
    const author = basic(); author.material[field] = texture();
    const result = bridge().project(author, { cameraLayerMask: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.issues)).toContain(`material.${field}`);
  });

  it.each([null, "pbr", "phong", 64])("rejects unknown shadingModel=%s", shadingModel => {
    const packet = project(bridge(), basic()).packet;
    expect(() => prepareRenderPacket({ ...packet, materials: [{ ...packet.materials[0]!, shadingModel: shadingModel as "unlit" }] }))
      .toThrow("shadingModel");
  });
});
