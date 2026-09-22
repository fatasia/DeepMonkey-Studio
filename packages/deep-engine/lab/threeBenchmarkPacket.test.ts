import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { createBenchmarkScene, frozenFixtureDescription } from "./benchmarkScene.js";
import { createThreeBenchmarkPacket } from "./threeBenchmarkPacket.js";
import type { RenderPacket } from "../src/renderPacketTypes.js";

function fixture(): RenderPacket {
  const packet = createBenchmarkScene(1024).packet;
  return { geometries: [packet.geometries[0]!, { ...packet.geometries[0]!, id: "second" }],
    materials: [packet.materials[0]!, { id: "red", baseColor: [1, 0, 0], metallic: 0.2, roughness: 0.8, doubleSided: true }],
    instances: [packet.instances[0]!, { ...packet.instances[1]!, geometry: "second", material: "red", castShadow: false }] };
}
describe("complete Three benchmark packet", () => {
  it("preserves every geometry, material, transform, and shadow flag", () => {
    const result = createThreeBenchmarkPacket(fixture());
    const meshes = result.root.children as THREE.InstancedMesh[];
    expect(meshes).toHaveLength(2);
    expect(meshes.map(mesh => mesh.count)).toEqual([1, 1]);
    const red = meshes[1]!.material as THREE.MeshStandardMaterial;
    expect(red.color.toArray()).toEqual([1, 0, 0]); expect(red.metalness).toBe(0.2); expect(red.side).toBe(THREE.DoubleSide);
    expect(meshes[1]!.castShadow).toBe(false);
    const transform = new THREE.Matrix4(); meshes[1]!.getMatrixAt(0, transform);
    expect(transform.elements).toEqual(Array.from(new Float32Array(fixture().instances[1]!.transform)));
    result.resources.forEach(resource => resource.dispose());
  });
  it("uses a regular mesh for mirrored instances and retains vertex colors", () => {
    const packet = fixture(), source = packet.instances[0]!, transform = Array.from(source.transform); transform[0]! *= -1;
    transform[2]! *= -1;
    const geometry = packet.geometries[0]!;
    const result = createThreeBenchmarkPacket({ ...packet, geometries: [{ ...geometry,
      colors: new Float32Array(geometry.vertices.length / 6 * 4).fill(1) }, packet.geometries[1]!],
      instances: [{ ...source, transform }] });
    const mesh = result.root.children[0] as THREE.Mesh;
    expect(mesh).not.toBeInstanceOf(THREE.InstancedMesh);
    expect((mesh.material as THREE.Material).vertexColors).toBe(true);
    expect(mesh.matrix.determinant()).toBeLessThan(0);
  });
  it("preserves RGBA texture bytes, UV selection, alpha and emissive semantics", () => {
    const packet = fixture();
    const result = createThreeBenchmarkPacket({ ...packet,
      textures: [{ id: "texture", revision: 1, width: 1, height: 1, data: new Uint8Array([10, 20, 30, 40]), semantic: "baseColor" }],
      materials: [{ ...packet.materials[0]!, alphaMode: "MASK", alphaCutoff: 0.4, baseColorAlpha: 0.7,
        baseColorTexture: { texture: "texture", texCoord: 1, rotation: 0.3 }, emissiveFactor: [0.2, 0.3, 0.4], emissiveStrength: 2 }],
      instances: [packet.instances[0]!] });
    const material = (result.root.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(material.alphaTest).toBe(0.4); expect(material.opacity).toBe(0.7);
    expect(material.map?.channel).toBe(1); expect(material.map?.rotation).toBe(-0.3);
    expect(material.map?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(material.emissive.toArray()).toEqual([0.2, 0.3, 0.4]); expect(material.emissiveIntensity).toBe(2);
  });
  it("refuses unresolved LOD and missing geometry instead of dropping content", () => {
    const packet = fixture();
    expect(() => createThreeBenchmarkPacket({ ...packet, instances: [{ ...packet.instances[0]!, geometry: "missing" }] })).toThrow("missing geometry");
    expect(() => createThreeBenchmarkPacket({ ...packet, instances: [{ ...packet.instances[0]!, pose: "unresolved" }] })).toThrow("frozen pose");
  });
  it("fingerprints later geometry and material content", () => {
    const base = createBenchmarkScene(1024), packet = fixture();
    const before = JSON.stringify(frozenFixtureDescription({ ...base, packet }));
    const after = JSON.stringify(frozenFixtureDescription({ ...base, packet: { ...packet,
      materials: [packet.materials[0]!, { ...packet.materials[1]!, roughness: 0.1 }] } }));
    expect(after).not.toBe(before);
  });
});
