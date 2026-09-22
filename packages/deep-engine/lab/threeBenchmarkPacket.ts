import * as THREE from "three/webgpu";
import type { RenderPacket, GeometryResource, PbrMaterial, TextureSlot } from "../src/renderPacketTypes.js";
import type { DecodedTexture, PixelLevel } from "../src/textures/decodedTexture.js";

/** Render the complete frozen packet; never replace a source material or discard later primitives. */
export function createThreeBenchmarkPacket(packet: RenderPacket) {
  if (packet.deformation || packet.instances.some(instance => instance.pose || instance.lod)) {
    throw new Error("Benchmark adapter requires a frozen pose and resolved LOD packet.");
  }
  const root = new THREE.Group(), resources: { dispose(): void }[] = [];
  try {
    const geometries = new Map(packet.geometries.map(source => {
      const geometry = createGeometry(source); resources.push(geometry); return [source.id, geometry];
    }));
    const textures = new Map((packet.textures ?? []).map(texture => [texture.id, texture]));
    const materials = new Map(packet.materials.map(source => {
      const material = createMaterial(source, textures, resources); return [source.id, material];
    }));
    const batches = new Map<string, typeof packet.instances[number][]>();
    for (const instance of packet.instances) {
      const key = JSON.stringify([instance.geometry, instance.material, instance.castShadow !== false, instance.receiveShadow !== false]);
      const group = batches.get(key) ?? []; group.push(instance); batches.set(key, group);
    }
    for (const instances of batches.values()) {
      const first = instances[0]!, geometry = geometries.get(first.geometry);
      let material = materials.get(first.material);
      if (!geometry || !material) throw new Error(`Benchmark instance ${first.id} has missing geometry or material.`);
      if (geometry.hasAttribute("color")) { material = material.clone(); material.vertexColors = true; resources.push(material); }
      const regular = instances.filter(instance => new THREE.Matrix4().fromArray(Array.from(instance.transform)).determinant() >= 0);
      if (regular.length) {
        const mesh = new THREE.InstancedMesh(geometry, material, regular.length);
        regular.forEach((instance, index) => mesh.setMatrixAt(index, new THREE.Matrix4().fromArray(Array.from(instance.transform))));
        mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
        mesh.castShadow = first.castShadow !== false; mesh.receiveShadow = first.receiveShadow !== false;
        root.add(mesh); resources.push(mesh);
      }
      // Three InstancedMesh does not support negative instance determinants; ordinary Mesh does.
      for (const instance of instances) {
        const matrix = new THREE.Matrix4().fromArray(Array.from(instance.transform));
        if (matrix.determinant() >= 0) continue;
        const mesh = new THREE.Mesh(geometry, material); mesh.matrixAutoUpdate = false; mesh.matrix.copy(matrix);
        mesh.castShadow = instance.castShadow !== false; mesh.receiveShadow = instance.receiveShadow !== false; root.add(mesh);
      }
    }
    return { root, resources };
  } catch (error) { resources.reverse().forEach(resource => resource.dispose()); throw error; }
}

function createGeometry(source: GeometryResource): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry(), positions = new Float32Array(source.vertices.length / 2);
  const normals = new Float32Array(positions.length);
  for (let offset = 0, target = 0; offset < source.vertices.length; offset += 6, target += 3) {
    positions.set(source.vertices.subarray(offset, offset + 3), target);
    normals.set(source.vertices.subarray(offset + 3, offset + 6), target);
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  if (source.uv0) geometry.setAttribute("uv", new THREE.BufferAttribute(source.uv0, 2));
  if (source.uv1) geometry.setAttribute("uv1", new THREE.BufferAttribute(source.uv1, 2));
  if (source.tangents) geometry.setAttribute("tangent", new THREE.BufferAttribute(source.tangents, 4));
  if (source.colors) geometry.setAttribute("color", new THREE.BufferAttribute(source.colors, 4));
  geometry.setIndex(new THREE.BufferAttribute(source.indices, 1)); geometry.computeBoundingSphere();
  return geometry;
}

function createMaterial(source: PbrMaterial, textures: ReadonlyMap<string, DecodedTexture>, resources: { dispose(): void }[]) {
  if (source.premultipliedAlpha) throw new Error(`Benchmark material ${source.id}: premultiplied source needs explicit straight-alpha conversion.`);
  const material = source.shadingModel === "unlit" ? new THREE.MeshBasicMaterial() : new THREE.MeshStandardMaterial();
  resources.push(material);
  material.name = source.id; material.color.setRGB(...source.baseColor);
  material.side = source.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  material.transparent = source.alphaMode === "BLEND";
  material.opacity = source.alphaMode === "OPAQUE" || source.alphaMode === undefined ? 1 : source.baseColorAlpha ?? 1;
  material.alphaTest = source.alphaMode === "MASK" ? source.alphaCutoff ?? 0.5 : 0;
  material.depthWrite = !material.transparent; material.fog = source.fog !== false;
  const texture = (slot: TextureSlot | undefined): THREE.DataTexture | null => {
    if (!slot) return null;
    const decoded = textures.get(slot.texture);
    if (!decoded) throw new Error(`Missing benchmark texture ${slot.texture}.`);
    const value = createTexture(decoded, slot); resources.push(value); return value;
  };
  material.map = texture(source.baseColorTexture);
  if (material instanceof THREE.MeshStandardMaterial) {
    material.metalness = source.metallic; material.roughness = source.roughness;
    material.metalnessMap = texture(source.metallicRoughnessTexture); material.roughnessMap = material.metalnessMap;
    material.normalMap = texture(source.normalTexture);
    material.normalScale.setScalar(source.normalTexture?.normalScale ?? 1);
    material.aoMap = texture(source.occlusionTexture); material.aoMapIntensity = source.occlusionTexture?.strength ?? 1;
    material.emissive.setRGB(...(source.emissiveFactor ?? [0, 0, 0])); material.emissiveIntensity = source.emissiveStrength ?? 1;
    material.emissiveMap = texture(source.emissiveTexture);
  }
  return material;
}

function tightPixels(level: PixelLevel): Uint8Array {
  const pitch = level.bytesPerRow ?? level.width * 4;
  const bytes = new Uint8Array(level.width * level.height * 4);
  for (let row = 0; row < level.height; row++) bytes.set(level.data.subarray(row * pitch, row * pitch + level.width * 4), row * level.width * 4);
  return bytes;
}
function createTexture(source: DecodedTexture, slot: TextureSlot): THREE.DataTexture {
  if (source.compression) throw new Error(`Benchmark texture ${source.id}: compressed adapter not available.`);
  const texture = new THREE.DataTexture(tightPixels(source), source.width, source.height, THREE.RGBAFormat);
  texture.colorSpace = source.semantic === "baseColor" || source.semantic === "emissive" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.flipY = false; texture.generateMipmaps = false;
  if (source.mipmaps?.length) texture.mipmaps = [source, ...source.mipmaps].map(level => ({ data: tightPixels(level), width: level.width, height: level.height }));
  const wrap = (value: string | undefined) => value === "clamp-to-edge" ? THREE.ClampToEdgeWrapping : value === "mirror-repeat" ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
  texture.wrapS = wrap(source.sampler?.addressModeU); texture.wrapT = wrap(source.sampler?.addressModeV);
  texture.magFilter = source.sampler?.magFilter === "nearest" ? THREE.NearestFilter : THREE.LinearFilter;
  const nearest = source.sampler?.minFilter === "nearest", mipNearest = source.sampler?.mipmapFilter === "nearest";
  texture.minFilter = source.mipmaps?.length
    ? nearest ? mipNearest ? THREE.NearestMipmapNearestFilter : THREE.NearestMipmapLinearFilter
      : mipNearest ? THREE.LinearMipmapNearestFilter : THREE.LinearMipmapLinearFilter
    : nearest ? THREE.NearestFilter : THREE.LinearFilter;
  texture.anisotropy = source.sampler?.maxAnisotropy ?? 1; texture.channel = slot.texCoord ?? 0;
  texture.offset.fromArray(slot.offset ?? [0, 0]); texture.repeat.fromArray(slot.scale ?? [1, 1]);
  texture.rotation = -(slot.rotation ?? 0); texture.needsUpdate = true;
  return texture;
}
