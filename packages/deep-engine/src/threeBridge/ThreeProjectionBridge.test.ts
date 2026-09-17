import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { prepareRenderPacket } from "../renderPacket.js";
import { accepted, bridge, mesh, project } from "./testFixture.js";

function dataTexture(pixels: readonly number[], colorSpace: THREE.ColorSpace = THREE.NoColorSpace): THREE.DataTexture {
  const texture = new THREE.DataTexture(Uint8Array.from(pixels), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = colorSpace; texture.needsUpdate = true;
  return texture;
}

describe("Three author projection", () => {
  it("reads a real Three hierarchy without replacing identities, invoking hooks, or disposing resources", () => {
    const root = new THREE.Scene(), group = new THREE.Group(), a = mesh(); root.add(group); group.add(a);
    group.position.set(3, 4, 5); group.rotation.y = 0.4; a.position.y = 2; a.scale.set(-2, 3, 0.5);
    root.updateWorldMatrix(true, true);
    const author = { geometry: a.geometry, material: a.material, parent: a.parent, position: a.position, matrix: a.matrixWorld, children: root.children };
    const update = vi.spyOn(root, "updateWorldMatrix"), dispose = vi.spyOn(a.geometry, "dispose"), materialDispose = vi.spyOn(a.material, "dispose");
    const target = bridge(), result = accepted(target.project(root, { cameraLayerMask: 1 }));
    expect(result.packet.instances[0]!.transform).toEqual(Float64Array.from(a.matrixWorld.elements));
    expect(result.packet.materials[0]!.baseColor).toEqual([a.material.color.r, a.material.color.g, a.material.color.b]);
    expect(result.packet.materials[0]!.baseColor[1]).toBeCloseTo(0.21586, 4);
    expect(prepareRenderPacket(result.packet).batches[0]!.mirrored).toBe(true);
    target.clear();
    expect(a.geometry).toBe(author.geometry); expect(a.material).toBe(author.material); expect(a.parent).toBe(author.parent);
    expect(a.position).toBe(author.position); expect(a.matrixWorld).toBe(author.matrix); expect(root.children).toBe(author.children);
    expect(update).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled(); expect(materialDispose).not.toHaveBeenCalled();
  });
  it("keeps IDs stable while scripts change the same object transform and material factors", () => {
    const target = bridge(), a = mesh(), first = project(target, a); expect(first.update).toBe("full"); first.acknowledge();
    const moveFromClosure = () => { a.position.x += 4; a.material.roughness = 0.3; }; moveFromClosure();
    const second = project(target, a); expect(second.update).toBe("instances");
    expect(second.packet.instances[0]!.id).toBe(first.packet.instances[0]!.id);
    expect(second.packet.geometries[0]).toBe(first.packet.geometries[0]);
    expect(second.packet.instances[0]!.transform[12]).toBe(4); expect(first.packet.instances[0]!.transform[12]).toBe(0);
    expect(second.packet.materials[0]!.roughness).toBe(0.3); expect(first.packet.materials[0]!.roughness).toBe(0.7);
  });
  it("treats world matrices as host authority, including matrixAutoUpdate false", () => {
    const a = mesh(), target = bridge(); a.matrixAutoUpdate = false;
    // Three r185 的手工 local matrix 修改必须显式标 dirty；桥接层随后只读取宿主已发布的 matrixWorld。
    a.matrix.makeTranslation(12, 13, 14); a.matrixWorldNeedsUpdate = true; a.updateWorldMatrix(true, true); a.position.x = 999;
    const result = accepted(target.project(a, { cameraLayerMask: 1 }));
    expect(Array.from(result.packet.instances[0]!.transform).slice(12, 15)).toEqual([12, 13, 14]);
    expect(a.position.x).toBe(999);
  });
  it("prunes invisible subtrees but still traverses children of parents on another layer", () => {
    const target = bridge(), root = new THREE.Group(), a = mesh(), b = mesh(), hidden = new THREE.Group();
    root.layers.set(5); root.add(a, hidden); hidden.add(b); hidden.visible = false; a.layers.set(2);
    expect(project(target, root, 1).packet.instances).toHaveLength(0);
    expect(project(target, root, 4).packet.instances).toHaveLength(1);
    hidden.visible = true; expect(project(target, root, 1).packet.instances).toHaveLength(1);
  });
  it("projects InstancedMesh using world × instance matrix and respects its active count", () => {
    const source = mesh(), a = new THREE.InstancedMesh(source.geometry, source.material, 3), root = new THREE.Group();
    root.position.set(10, 20, 30); root.rotation.y = 0.25; a.position.x = 4; root.add(a); a.count = 2;
    const local = new THREE.Matrix4().compose(new THREE.Vector3(1, 2, 3), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5), new THREE.Vector3(2, 3, 4));
    a.setMatrixAt(1, local); const target = bridge(), first = project(target, root);
    const rounded = new THREE.Matrix4(); a.getMatrixAt(1, rounded);
    expect(first.packet.instances).toHaveLength(2); expect(first.packet.geometries).toHaveLength(1);
    expect(Array.from(first.packet.instances[1]!.transform)).toEqual(new THREE.Matrix4().multiplyMatrices(a.matrixWorld, rounded).elements);
    expect(prepareRenderPacket(first.packet).batches[0]!.count).toBe(2); first.acknowledge();
    a.count = 1; expect(project(target, root).update).toBe("instances");
  });
  it("deduplicates shared geometry and material by object identity, even when UUIDs collide", () => {
    const target = bridge(), a = mesh(), b = new THREE.Mesh(a.geometry, a.material), c = mesh(), root = new THREE.Group();
    c.geometry.uuid = a.geometry.uuid; c.material.uuid = a.material.uuid; c.uuid = a.uuid; root.add(a, b, c);
    const result = project(target, root).packet;
    expect(result.instances).toHaveLength(3); expect(result.geometries).toHaveLength(2); expect(result.materials).toHaveLength(2);
    expect(new Set(result.instances.map(i => i.id)).size).toBe(3);
  });
  it("preserves query plugins such as custom raycast without running them", () => {
    const a = mesh(), plugin = vi.fn(); a.raycast = plugin;
    expect(project(bridge(), a).packet.instances).toHaveLength(1); expect(a.raycast).toBe(plugin); expect(plugin).not.toHaveBeenCalled();
  });
  it("projects owned RGBA8 DataTexture snapshots, UV0, samplers, and needsUpdate revisions", () => {
    const a = mesh(), colorPixels = new Uint8Array([200, 100, 50, 255, 25, 75, 125, 255]);
    const ormPixels = new Uint8Array([9, 180, 60, 255, 8, 90, 220, 255]);
    const color = new THREE.DataTexture(colorPixels, 2, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    color.colorSpace = THREE.SRGBColorSpace; color.wrapS = THREE.RepeatWrapping; color.wrapT = THREE.MirroredRepeatWrapping;
    color.magFilter = THREE.LinearFilter; color.minFilter = THREE.LinearFilter; color.offset.set(0.25, 0.5); color.repeat.set(2, 3);
    const orm = new THREE.DataTexture(ormPixels, 2, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    color.needsUpdate = true; orm.needsUpdate = true;
    const authorVersions = [color.version, color.source.version, orm.version, orm.source.version];
    a.material.map = color; a.material.metalnessMap = orm; a.material.roughnessMap = orm;
    const dispose = vi.spyOn(color, "dispose"), target = bridge(), first = project(target, a);
    const base = first.packet.textures!.find(texture => texture.semantic === "baseColor")!;
    const mr = first.packet.textures!.find(texture => texture.semantic === "metallicRoughness")!;
    expect(first.packet.geometries[0]!.uv0).toEqual(Float32Array.from(a.geometry.getAttribute("uv").array));
    expect(first.packet.geometries[0]!.uv0).not.toBe(a.geometry.getAttribute("uv").array);
    expect(base.data).toEqual(colorPixels); expect(base.data).not.toBe(colorPixels);
    expect(mr.data).toEqual(Uint8Array.from([255, 180, 60, 255, 255, 90, 220, 255]));
    expect(base.sampler).toEqual({ addressModeU: "repeat", addressModeV: "mirror-repeat", magFilter: "linear",
      minFilter: "linear", mipmapFilter: "nearest", maxAnisotropy: 1 });
    expect(first.packet.materials[0]!.baseColorTexture).toMatchObject({ texture: base.id, offset: [0.25, 0.5], scale: [2, 3], rotation: 0 });
    expect(first.packet.materials[0]!.metallicRoughnessTexture!.texture).toBe(mr.id);
    expect(prepareRenderPacket(first.packet).textures).toHaveLength(2);
    expect([color.version, color.source.version, orm.version, orm.source.version]).toEqual(authorVersions);
    expect(first.acknowledge()).toBe(true);

    colorPixels[0] = 1;
    const withoutNeedsUpdate = project(target, a);
    expect(withoutNeedsUpdate.update).toBe("instances");
    expect(withoutNeedsUpdate.packet.textures![0]).toBe(first.packet.textures![0]);
    expect(withoutNeedsUpdate.packet.textures!.find(texture => texture.semantic === "baseColor")!.data[0]).toBe(200);
    color.needsUpdate = true;
    const updated = project(target, a), updatedBase = updated.packet.textures!.find(texture => texture.semantic === "baseColor")!;
    expect(updated.update).toBe("full"); expect(updatedBase.id).toBe(base.id); expect(updatedBase.revision).toBeGreaterThan(base.revision);
    expect(updatedBase.data[0]).toBe(1); expect(base.data[0]).toBe(200); expect(dispose).not.toHaveBeenCalled();
  });
  it("maps real r185 geometry uv1 and channel-1 normal/AO while each slot retains its coordinate set", () => {
    const a = mesh(), sourceUv = a.geometry.getAttribute("uv") as THREE.BufferAttribute;
    const uv1Values = Float32Array.from(sourceUv.array as ArrayLike<number>, (value, index) => index % 2 === 0 ? 1 - value : value);
    const authoredUv1 = new THREE.Float32BufferAttribute(uv1Values, 2);
    a.geometry.setAttribute("uv1", authoredUv1);
    const color = dataTexture([200, 100, 50, 255], THREE.SRGBColorSpace), normal = dataTexture([128, 128, 255, 255]);
    const ao = dataTexture([64, 255, 255, 255]);
    color.channel = 0; normal.channel = 1; ao.channel = 1;
    a.material.map = color; a.material.normalMap = normal; a.material.aoMap = ao;
    const result = project(bridge(), a), geometry = result.packet.geometries[0]!, material = result.packet.materials[0]!;
    expect(geometry.uv0).toHaveLength(geometry.vertices.length / 3);
    expect(geometry.uv1).toHaveLength(geometry.uv0!.length); expect(geometry.uv1).not.toBe(authoredUv1.array);
    for (let index = 0; index < geometry.uv0!.length; index += 2) {
      expect(geometry.uv1![index]).toBeCloseTo(1 - geometry.uv0![index]!, 6);
      expect(geometry.uv1![index + 1]).toBeCloseTo(geometry.uv0![index + 1]!, 6);
    }
    expect(geometry.tangents).toHaveLength(geometry.vertices.length / 6 * 4);
    expect(material.baseColorTexture?.texCoord).toBe(0);
    expect(material.normalTexture?.texCoord).toBe(1);
    expect(material.occlusionTexture?.texCoord).toBe(1);
    const prepared = prepareRenderPacket(result.packet);
    expect(prepared.batches[0]!.textures?.baseColor?.texCoord).toBe(0);
    expect(prepared.batches[0]!.textures?.normal?.texCoord).toBe(1);
    expect(prepared.batches[0]!.textures?.occlusion?.texCoord).toBe(1);
    expect(a.geometry.getAttribute("uv1")).toBe(authoredUv1);
    expect(authoredUv1.array).toEqual(uv1Values);
  });
  it("combines separate metalness and roughness maps with neutral missing channels", () => {
    const a = mesh(), metal = new THREE.DataTexture(new Uint8Array([1, 2, 63, 4]), 1, 1), rough = new THREE.DataTexture(new Uint8Array([5, 191, 7, 8]), 1, 1);
    metal.needsUpdate = true; rough.needsUpdate = true; a.material.metalnessMap = metal; a.material.roughnessMap = rough;
    const combined = project(bridge(), a).packet.textures![0]!;
    expect(combined.semantic).toBe("metallicRoughness"); expect(combined.data).toEqual(Uint8Array.from([255, 191, 63, 255]));
    a.material.roughnessMap = null;
    expect(project(bridge(), a).packet.textures![0]!.data).toEqual(Uint8Array.from([255, 255, 63, 255]));
  });
  it("reports non-readable image textures and missing UV0 as structured incompatibilities", () => {
    const imageMesh = mesh(), image = new THREE.Texture({ width: 1, height: 1 }); image.needsUpdate = true; imageMesh.material.map = image;
    const imageResult = bridge().project(imageMesh, { cameraLayerMask: 1 });
    expect(imageResult.ok).toBe(false);
    if (imageResult.ok) throw new Error("Expected unsupported image source.");
    expect(imageResult.issues[0]).toMatchObject({ code: "unsupported", feature: "material.map image source", path: "root" });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    const pixels = new Uint8Array([255, 255, 255, 255]), data = new THREE.DataTexture(pixels, 1, 1); data.colorSpace = THREE.SRGBColorSpace; data.needsUpdate = true;
    const noUv = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: data })); noUv.updateWorldMatrix(true, true);
    const uvResult = bridge().project(noUv, { cameraLayerMask: 1 });
    expect(uvResult.ok).toBe(false);
    if (uvResult.ok) throw new Error("Expected missing UV0 failure.");
    expect(uvResult.issues).toEqual([expect.objectContaining({ code: "invalid", feature: "packet", path: "packet" })]);
  });
  it("rejects separate metallic/roughness maps that cannot share one packet slot", () => {
    const a = mesh(), metal = new THREE.DataTexture(new Uint8Array([0, 0, 255, 255]), 1, 1), rough = new THREE.DataTexture(new Uint8Array([0, 255, 0, 255]), 1, 1);
    metal.needsUpdate = true; rough.needsUpdate = true; rough.offset.x = 0.5;
    a.material.metalnessMap = metal; a.material.roughnessMap = rough; a.updateWorldMatrix(true, true);
    const result = bridge().project(a, { cameraLayerMask: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected incompatible map transforms.");
    expect(result.issues[0]).toMatchObject({ code: "unsupported", feature: "material.metalnessMap/roughnessMap combination" });

    const channels = mesh(), channel0 = dataTexture([0, 0, 255, 255]), channel1 = dataTexture([0, 255, 0, 255]);
    channel0.channel = 0; channel1.channel = 1;
    channels.material.metalnessMap = channel0; channels.material.roughnessMap = channel1;
    const channelResult = bridge().project(channels, { cameraLayerMask: 1 });
    expect(channelResult.ok).toBe(false);
    if (channelResult.ok) throw new Error("Expected incompatible map coordinate sets.");
    expect(channelResult.issues[0]).toMatchObject({ code: "unsupported", feature: "material.metalnessMap/roughnessMap combination" });
  });
  it("maps r185 emissive, tangent-space normal, UV0 AO, MASK and DoubleSide without mutating Three authors", () => {
    const a = mesh(), emissive = dataTexture([200, 100, 50, 255], THREE.SRGBColorSpace);
    const normal = dataTexture([128, 128, 255, 255]), ao = dataTexture([64, 9, 7, 255]);
    a.material.emissive.setRGB(0.1, 0.2, 0.3); a.material.emissiveIntensity = 2;
    a.material.emissiveMap = emissive; a.material.normalMap = normal; a.material.normalScale.set(0.4, 0.4);
    a.material.aoMap = ao; a.material.aoMapIntensity = 0.35;
    a.material.alphaTest = 0.25; a.material.opacity = 0.7; a.material.side = THREE.DoubleSide;
    const author = { material: a.material, geometry: a.geometry, normalScale: a.material.normalScale,
      pixels: [emissive.image.data, normal.image.data, ao.image.data],
      pixelValues: [emissive.image.data.slice(), normal.image.data.slice(), ao.image.data.slice()],
      versions: [emissive.version, normal.version, ao.version] };
    const packet = project(bridge(), a).packet, material = packet.materials[0]!, prepared = prepareRenderPacket(packet);
    expect(material).toMatchObject({ emissiveFactor: [0.2, 0.4, 0.6], normalTexture: { normalScale: 0.4 },
      occlusionTexture: { strength: 0.35 }, alphaMode: "MASK", alphaCutoff: 0.25, baseColorAlpha: 0.7, doubleSided: true });
    expect(packet.textures!.map(texture => texture.semantic)).toEqual(["normal", "occlusion", "emissive"]);
    expect(prepared.textures.map(texture => [texture.semantic, texture.format])).toEqual([
      ["normal", "rgba8unorm"], ["occlusion", "rgba8unorm"], ["emissive", "rgba8unorm-srgb"],
    ]);
    expect(packet.geometries[0]!.tangents).toHaveLength(packet.geometries[0]!.vertices.length / 6 * 4);
    expect(prepared.batches[0]).toMatchObject({ alphaMode: "MASK", doubleSided: true,
      textures: { emissive: {} } });
    expect(prepared.batches[0]!.textures!.normal!.normalScale).toBeCloseTo(0.4);
    expect(prepared.batches[0]!.textures!.occlusion!.strength).toBeCloseTo(0.35);
    expect(a.material).toBe(author.material); expect(a.geometry).toBe(author.geometry);
    expect(a.material.normalScale).toBe(author.normalScale);
    [emissive.image.data, normal.image.data, ao.image.data].forEach((pixels, index) => {
      expect(pixels).toBe(author.pixels[index]); expect(pixels).toEqual(author.pixelValues[index]);
    });
    expect([emissive.version, normal.version, ao.version]).toEqual(author.versions);
  });
  it("maps transparent opacity to the engine's straight-alpha BLEND contract and accepts neutral PhysicalMaterial", () => {
    const transparent = mesh(); transparent.material.transparent = true; transparent.material.opacity = 0.42; transparent.material.depthWrite = false;
    const projected = project(bridge(), transparent), prepared = prepareRenderPacket(projected.packet);
    expect(projected.packet.materials[0]).toMatchObject({ alphaMode: "BLEND", baseColorAlpha: 0.42 });
    expect(prepared.batches[0]).toMatchObject({ alphaMode: "BLEND", count: 1 });
    expect(prepared.batches[0]!.sortCenter).toBeUndefined();
    expect(transparent.material.transparent).toBe(true); expect(transparent.material.opacity).toBe(0.42);

    const physical = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhysicalMaterial({
      color: 0x808080, emissive: 0x201008, emissiveIntensity: 0.5,
    }));
    const physicalPacket = project(bridge(), physical).packet;
    expect(physicalPacket.materials[0]).toMatchObject({ metallic: 0, roughness: 1 });
    expect(physicalPacket.materials[0]!.emissiveFactor).toEqual([
      physical.material.emissive.r * 0.5, physical.material.emissive.g * 0.5, physical.material.emissive.b * 0.5,
    ]);
  });
  it("fails closed on material features the current packet cannot express", () => {
    const reject = (configure: (material: THREE.MeshStandardMaterial) => void, feature: string) => {
      const a = mesh(); configure(a.material); a.updateWorldMatrix(true, true);
      const result = bridge().project(a, { cameraLayerMask: 1 });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected unsupported material.");
      expect(result.issues[0]).toMatchObject({ code: "unsupported", feature });
    };
    reject(material => { material.blending = THREE.AdditiveBlending; }, "material.blending");
    reject(material => { material.premultipliedAlpha = true; }, "material.premultipliedAlpha");
    reject(material => { material.onBeforeCompile = () => {}; }, "material render hooks");
    reject(material => { material.normalMap = dataTexture([128, 128, 255, 255]); material.normalMapType = THREE.ObjectSpaceNormalMap; }, "material.normalMapType");
    reject(material => { material.normalMap = dataTexture([128, 128, 255, 255]); material.normalScale.set(1, 0.5); }, "material non-uniform normalScale");
    reject(material => { material.aoMap = dataTexture([128, 0, 0, 255]); material.aoMap.channel = 2; }, "material.aoMap UV channel or mapping");
    const cutoutBlend = mesh(); cutoutBlend.material.transparent = true; cutoutBlend.material.alphaTest = 0.5; cutoutBlend.material.depthWrite = false;
    cutoutBlend.updateWorldMatrix(true, true);
    const cutoutResult = bridge().project(cutoutBlend, { cameraLayerMask: 1 });
    expect(cutoutResult.ok).toBe(true);
    if (cutoutResult.ok) expect(cutoutResult.packet.materials[0]).toMatchObject({ alphaMode: "BLEND", alphaCutoff: 0.5 });
    reject(material => { material.transparent = true; }, "material transparent depthWrite");
    reject(material => { material.side = THREE.BackSide; }, "material.BackSide");
    // DE26/C03:BLEND+DoubleSide 解除 two-pass 拒绝(OIT 次序无关,单 pass 数学等价);
    // 接受路径与组合矩阵由 ThreeProjectionBridge.transparency.test.ts 覆盖。

    const physical = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhysicalMaterial({ clearcoat: 0.1 }));
    physical.updateWorldMatrix(true, true);
    const physicalResult = bridge().project(physical, { cameraLayerMask: 1 });
    expect(physicalResult.ok).toBe(false);
    if (physicalResult.ok) throw new Error("Expected non-neutral PhysicalMaterial rejection.");
    expect(physicalResult.issues[0]).toMatchObject({ code: "unsupported", feature: "MeshPhysicalMaterial non-neutral extensions" });
  });
  it("rejects channel 1 when the geometry has no uv1 instead of silently sampling uv0", () => {
    const a = mesh(); a.material.aoMap = dataTexture([128, 0, 0, 255]); a.material.aoMap.channel = 1;
    const result = bridge().project(a, { cameraLayerMask: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected missing UV1 rejection.");
    expect(result.issues).toEqual([expect.objectContaining({ code: "invalid", feature: "packet", path: "packet",
      message: expect.stringContaining("requires UV1") })]);
  });
});
