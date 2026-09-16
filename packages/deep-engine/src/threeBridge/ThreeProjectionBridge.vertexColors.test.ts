import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { prepareRenderPacket } from "../renderPacket.js";
import { materializeRuntimeRenderPacket } from "../runtimePackage/renderPacket.js";
import { bridge, project } from "./testFixture.js";

function coloredMesh(itemSize: number, vertexColors = true): THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial> {
  const geometry = new THREE.BoxGeometry();
  const colors = new Float32Array(geometry.attributes.position.count * itemSize);
  for (let index = 0; index < colors.length; index++) colors[index] = ((index * 37) % 11) / 11;
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, itemSize));
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors }));
}

describe("DE26/C02 vertex colors and flat shading through the projection bridge", () => {
  it.each([3, 4])("packs itemSize=%s color streams as linear RGBA and declares the feature", itemSize => {
    const packet = project(bridge(), coloredMesh(itemSize)).packet;
    const geometry = packet.geometries[0]!;
    expect(geometry.id).toContain("/color");
    expect(geometry.colors).toHaveLength(geometry.vertices.length / 6 * 4);
    const expected = geometry.colors!;
    for (let vertex = 0; vertex < expected.length / 4; vertex++) {
      // 打包值是 f32；三维源的 alpha 必须补 1，四维源逐分量保留（按 f32 舍入比较）。
      const alpha = itemSize === 3 ? 1 : Math.fround(((vertex * 4 + 3) * 37 % 11) / 11);
      expect(expected[vertex * 4 + 3]).toBe(alpha);
    }
    const prepared = prepareRenderPacket(packet);
    expect(prepared.geometries.get(geometry.id)!.colors).toBeDefined();
  });

  it("keeps the legacy path byte-identical when neither vertexColors nor flatShading is requested", () => {
    const legacy = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    const packet = project(bridge(), legacy).packet;
    const geometry = packet.geometries[0]!;
    expect(geometry.colors).toBeUndefined();
    expect(geometry.id).not.toContain("/color");
    expect(geometry.id).not.toContain("/flat");
    // BoxGeometry 顶点形状与颜色无关：无颜色请求时不得产生任何颜色负载。
    expect(JSON.stringify(packet)).not.toContain('"colors"');
  });

  it("rejects vertexColors without a geometry color stream (fail-closed)", () => {
    const author = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true }));
    const result = bridge().project(author, { cameraLayerMask: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.issues)).toContain("vertex colors");
  });

  it("rejects non-finite color components and unsupported color itemSize", () => {
    const nan = coloredMesh(3);
    (nan.geometry.attributes.color.array as Float32Array)[5] = Number.NaN;
    const nanResult = bridge().project(nan, { cameraLayerMask: 1 });
    expect(nanResult.ok).toBe(false);
    if (!nanResult.ok) expect(JSON.stringify(nanResult.issues)).toContain("color components");

    const narrow = coloredMesh(2);
    const narrowResult = bridge().project(narrow, { cameraLayerMask: 1 });
    expect(narrowResult.ok).toBe(false);
    if (!narrowResult.ok) expect(JSON.stringify(narrowResult.issues)).toContain("color itemSize");
  });

  it("derives flat geometry as non-indexed face normals without changing the material contract", () => {
    const author = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ flatShading: true }));
    const packet = project(bridge(), author).packet;
    const geometry = packet.geometries[0]!;
    expect(geometry.id).toContain("/flat");
    // BoxGeometry：36 索引共享 24 顶点；flat 派生后每角一顶点。
    expect(geometry.vertices.length / 6).toBe(36);
    expect(Array.from(geometry.indices)).toEqual(Array.from({ length: 36 }, (_, index) => index));
    for (let triangle = 0; triangle < 12; triangle++) {
      const [a, b, c] = [0, 1, 2].map(corner => {
        const vertex = triangle * 3 + corner;
        return [geometry.vertices[vertex * 6 + 3]!, geometry.vertices[vertex * 6 + 4]!, geometry.vertices[vertex * 6 + 5]!] as const;
      });
      expect(a).toEqual(b);
      expect(b).toEqual(c);
      expect(Math.hypot(...a)).toBeCloseTo(1, 5);
    }
    // 面法线与源平滑法线方向一致（BoxGeometry 面朝外），正背面语义不变。
    const smooth = project(bridge(), new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())).packet.geometries[0]!;
    expect(normalAt(geometry, 0)).toEqual(normalAt(smooth, Number(smooth.indices[0])));
  });

  it("rejects flatShading combined with a normal map for now", () => {
    const author = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ flatShading: true }));
    author.material.normalMap = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    author.material.normalMap.needsUpdate = true;
    const result = bridge().project(author, { cameraLayerMask: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.issues)).toContain("flat shading");
  });

  it("isolates one shared geometry between a colored and an uncolored material", () => {
    const shared = new THREE.BoxGeometry();
    const colors = new Float32Array(shared.attributes.position.count * 3).fill(0.5);
    shared.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const group = new THREE.Group();
    group.add(new THREE.Mesh(shared, new THREE.MeshStandardMaterial({ vertexColors: true })));
    group.add(new THREE.Mesh(shared, new THREE.MeshStandardMaterial()));
    const packet = project(bridge(), group).packet;
    expect(packet.geometries).toHaveLength(2);
    const colored = packet.geometries.find(geometry => geometry.id.endsWith("/color"))!;
    const plain = packet.geometries.find(geometry => !geometry.id.endsWith("/color"))!;
    expect(colored.colors).toBeDefined();
    expect(plain.colors).toBeUndefined();
  });

  it("treats the flat switch as part of the resource identity (changing it replaces the resource)", () => {
    const author = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ flatShading: true }));
    const target = bridge();
    const flat = project(target, author).packet.geometries[0]!;
    author.material.flatShading = false;
    const smooth = project(target, author).packet.geometries[0]!;
    expect(flat.id).toContain("/flat");
    expect(smooth.id).not.toContain("/flat");
    expect(smooth.id).not.toBe(flat.id);
    expect(smooth.vertices.length / 6).toBe(24);
  });

  it("keeps mirrored instances orthogonal to colored streams", () => {
    const author = coloredMesh(3);
    author.scale.x = -1;
    const prepared = prepareRenderPacket(project(bridge(), author).packet);
    expect(prepared.batches[0]!.mirrored).toBe(true);
    expect([...prepared.geometries.values()][0]!.colors).toBeDefined();
  });

  it("round-trips colored packets through the runtime JSON contract", () => {
    const packet = project(bridge(), coloredMesh(4)).packet;
    const restored = materializeRuntimeRenderPacket(JSON.parse(JSON.stringify(packet)), "$.packet");
    const before = packet.geometries[0]!.colors!, after = restored.geometries[0]!.colors!;
    expect(after).toEqual(before);
    expect(() => prepareRenderPacket(restored)).not.toThrow();
  });
});

function normalAt(geometry: { vertices: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> }, index: number) {
  const offset = Number(index) * 6 + 3;
  return [geometry.vertices[offset]!, geometry.vertices[offset + 1]!, geometry.vertices[offset + 2]!] as const;
}
