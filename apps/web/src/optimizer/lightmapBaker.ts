import { type Document, type Mesh, type Primitive } from "@gltf-transform/core";
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { BakeLightState } from "./modelOptimizer";

export interface WebLightmapOptions {
  resolution: 256 | 512 | 1024;
  strength: number;
  ambient: number;
  lights: BakeLightState[];
  ambientOcclusion: boolean;
  aoSamples: 4 | 8;
  shadows: boolean;
}

export interface WebLightmapResult {
  resolution: number;
  primitives: number;
  generatedUvs: number;
  coveredTexels: number;
  textureBytes: number;
}

interface PrimitiveBakeTarget {
  primitive: Primitive;
  mesh: Mesh;
  matrix: THREE.Matrix4;
  normalMatrix: THREE.Matrix3;
  position: NonNullable<ReturnType<Primitive["getAttribute"]>>;
  normal: NonNullable<ReturnType<Primitive["getAttribute"]>>;
  uv?: NonNullable<ReturnType<Primitive["getAttribute"]>> | undefined;
  indices?: NonNullable<ReturnType<Primitive["getIndices"]>> | undefined;
}

interface SceneAcceleration {
  bvh?: MeshBVH;
  geometry?: THREE.BufferGeometry;
  radius: number;
  epsilon: number;
}

interface LightingScratch {
  direction: THREE.Vector3;
  origin: THREE.Vector3;
  tangent: THREE.Vector3;
  bitangent: THREE.Vector3;
  local: THREE.Vector3;
  ray: THREE.Ray;
  luminance: Map<string, number>;
}

/**
 * Browser-only, single-atlas static lightmap baker.
 *
 * The generated texture is attached as the standard glTF occlusion texture on
 * TEXCOORD_1, so it survives GLB export and remains usable outside BIM Studio.
 * It preserves existing base-color textures and intentionally avoids offline
 * path tracing, UV chart optimization, and multi-bounce GI.
 */
export async function bakeWebLightmap(
  document: Document,
  options: WebLightmapOptions,
  onProgress?: (message: string) => void,
  encodeTexture: (pixels: Uint8ClampedArray, resolution: number) => Promise<Uint8Array> = encodePng
): Promise<WebLightmapResult> {
  const targets = collectTargets(document);
  if (targets.length === 0) throw new Error("模型没有可用于光照贴图的三角面和法线");
  const resolution = options.resolution;
  const pixels = new Uint8ClampedArray(resolution * resolution * 4);
  const covered = new Uint8Array(resolution * resolution);
  pixels.fill(255);

  onProgress?.("正在构建场景遮挡加速结构");
  const acceleration = options.shadows || options.ambientOcclusion ? buildSceneAcceleration(targets) : { radius: 1, epsilon: 0.0001 };
  const gridSize = Math.ceil(Math.sqrt(targets.length));
  const cellSize = resolution / gridSize;
  let generatedUvs = 0;
  let coveredTexels = 0;

  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const target = targets[targetIndex]!;
    const localUvs = readOrGenerateUvs(target);
    if (!target.uv) generatedUvs += 1;
    const atlasUvs = placeUvsInAtlas(localUvs, targetIndex, gridSize, cellSize, resolution);
    target.primitive.setAttribute("TEXCOORD_1", document.createAccessor("BIM Studio lightmap UV")
      .setType("VEC2")
      .setArray(atlasUvs)
      .setBuffer(document.getRoot().listBuffers()[0] ?? document.createBuffer("BIM Studio lightmap")));
    coveredTexels += rasterizePrimitive(target, atlasUvs, pixels, covered, resolution, options, acceleration);
    if (targetIndex % 12 === 0) {
      onProgress?.(`正在烘焙光照贴图 ${targetIndex + 1}/${targets.length}`);
      await yieldToBrowser();
    }
  }

  onProgress?.("正在填充光照贴图边缘");
  dilateTexture(pixels, covered, resolution, 3);
  const png = await encodeTexture(pixels, resolution);
  const texture = document.createTexture("BIM Studio Web Lightmap").setMimeType("image/png").setImage(png);
  const materials = new Set(targets.map((target) => target.primitive.getMaterial()).filter((material) => material !== null));
  for (const material of materials) {
    material!.setOcclusionTexture(texture).setOcclusionStrength(1);
    material!.getOcclusionTextureInfo()!.setTexCoord(1);
    material!.setExtras({
      ...material!.getExtras(),
      bimStudioLightmap: { mode: "occlusion", texCoord: 1, resolution, shadows: options.shadows, ambientOcclusion: options.ambientOcclusion }
    });
  }
  acceleration.geometry?.dispose();
  return { resolution, primitives: targets.length, generatedUvs, coveredTexels, textureBytes: png.byteLength };
}

function collectTargets(document: Document): PrimitiveBakeTarget[] {
  const firstMatrixByMesh = new Map<Mesh, THREE.Matrix4>();
  let fallbackMaterial = document.getRoot().listMaterials().find((material) => material.getName() === "BIM Studio lightmap default");
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (mesh && !firstMatrixByMesh.has(mesh)) firstMatrixByMesh.set(mesh, new THREE.Matrix4().fromArray(node.getWorldMatrix()));
  }
  const targets: PrimitiveBakeTarget[] = [];
  for (const mesh of document.getRoot().listMeshes()) {
    const matrix = firstMatrixByMesh.get(mesh) ?? new THREE.Matrix4();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION");
      const normal = primitive.getAttribute("NORMAL");
      if (primitive.getMode() !== 4 || !position || !normal || position.getCount() !== normal.getCount()) continue;
      if (!primitive.getMaterial()) {
        fallbackMaterial ??= document.createMaterial("BIM Studio lightmap default");
        primitive.setMaterial(fallbackMaterial);
      }
      targets.push({ primitive, mesh, matrix, normalMatrix, position, normal, uv: primitive.getAttribute("TEXCOORD_0") ?? undefined, indices: primitive.getIndices() ?? undefined });
    }
  }
  return targets;
}

function buildSceneAcceleration(targets: PrimitiveBakeTarget[]): SceneAcceleration {
  const positions: number[] = [];
  const point = new THREE.Vector3();
  const bounds = new THREE.Box3();
  for (const target of targets) {
    const indices = triangleIndices(target);
    const value: number[] = [];
    for (const index of indices) {
      target.position.getElement(index, value);
      point.set(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0).applyMatrix4(target.matrix);
      positions.push(point.x, point.y, point.z);
      bounds.expandByPoint(point);
    }
  }
  if (positions.length === 0) return { radius: 1, epsilon: 0.0001 };
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const bvh = new MeshBVH(geometry, { targetLeafSize: 20 });
  const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.5, 0.001);
  return { bvh, geometry, radius, epsilon: Math.max(radius * 0.00002, 0.00001) };
}

function readOrGenerateUvs(target: PrimitiveBakeTarget): Float32Array<ArrayBuffer> {
  const count = target.position.getCount();
  const uvs = new Float32Array(count * 2);
  const value: number[] = [];
  if (target.uv && target.uv.getCount() === count) {
    for (let index = 0; index < count; index += 1) {
      target.uv.getElement(index, value);
      uvs[index * 2] = value[0] ?? 0;
      uvs[index * 2 + 1] = value[1] ?? 0;
    }
    normalizeUvs(uvs);
    return uvs;
  }
  const normal: number[] = [];
  const bounds = localBounds(target);
  const size = bounds.getSize(new THREE.Vector3());
  const minimum = bounds.min;
  for (let index = 0; index < count; index += 1) {
    target.position.getElement(index, value);
    target.normal.getElement(index, normal);
    const ax = Math.abs(normal[0] ?? 0), ay = Math.abs(normal[1] ?? 0), az = Math.abs(normal[2] ?? 0);
    if (ax >= ay && ax >= az) {
      uvs[index * 2] = ((value[2] ?? 0) - minimum.z) / (size.z || 1);
      uvs[index * 2 + 1] = ((value[1] ?? 0) - minimum.y) / (size.y || 1);
    } else if (ay >= az) {
      uvs[index * 2] = ((value[0] ?? 0) - minimum.x) / (size.x || 1);
      uvs[index * 2 + 1] = ((value[2] ?? 0) - minimum.z) / (size.z || 1);
    } else {
      uvs[index * 2] = ((value[0] ?? 0) - minimum.x) / (size.x || 1);
      uvs[index * 2 + 1] = ((value[1] ?? 0) - minimum.y) / (size.y || 1);
    }
  }
  return uvs;
}

function normalizeUvs(uvs: Float32Array) {
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (let index = 0; index < uvs.length; index += 2) {
    minU = Math.min(minU, uvs[index]!); maxU = Math.max(maxU, uvs[index]!);
    minV = Math.min(minV, uvs[index + 1]!); maxV = Math.max(maxV, uvs[index + 1]!);
  }
  const width = maxU - minU || 1, height = maxV - minV || 1;
  for (let index = 0; index < uvs.length; index += 2) {
    uvs[index] = (uvs[index]! - minU) / width;
    uvs[index + 1] = (uvs[index + 1]! - minV) / height;
  }
}

function placeUvsInAtlas(local: Float32Array, targetIndex: number, gridSize: number, cellSize: number, resolution: number): Float32Array<ArrayBuffer> {
  const output = new Float32Array(local.length);
  const column = targetIndex % gridSize;
  const row = Math.floor(targetIndex / gridSize);
  const padding = Math.min(3, Math.max(1, Math.floor(cellSize * 0.04)));
  const drawable = Math.max(1, cellSize - padding * 2 - 1);
  for (let index = 0; index < local.length; index += 2) {
    output[index] = (column * cellSize + padding + local[index]! * drawable) / (resolution - 1);
    output[index + 1] = (row * cellSize + padding + local[index + 1]! * drawable) / (resolution - 1);
  }
  return output;
}

function rasterizePrimitive(
  target: PrimitiveBakeTarget,
  uvs: Float32Array,
  pixels: Uint8ClampedArray,
  covered: Uint8Array,
  resolution: number,
  options: WebLightmapOptions,
  acceleration: SceneAcceleration
): number {
  const indices = triangleIndices(target);
  const positions = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const normals = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const worldPosition = new THREE.Vector3();
  const worldNormal = new THREE.Vector3();
  const scratch: LightingScratch = {
    direction: new THREE.Vector3(), origin: new THREE.Vector3(), tangent: new THREE.Vector3(),
    bitangent: new THREE.Vector3(), local: new THREE.Vector3(), ray: new THREE.Ray(),
    luminance: new Map(options.lights.map((light) => [light.id, colorLuminance(light.color)]))
  };
  const value: number[] = [];
  let added = 0;
  for (let offset = 0; offset + 2 < indices.length; offset += 3) {
    const vertexIndices = [indices[offset]!, indices[offset + 1]!, indices[offset + 2]!];
    const uv = vertexIndices.map((index) => new THREE.Vector2(uvs[index * 2]! * (resolution - 1), (1 - uvs[index * 2 + 1]!) * (resolution - 1)));
    for (let corner = 0; corner < 3; corner += 1) {
      target.position.getElement(vertexIndices[corner]!, value);
      positions[corner]!.set(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0).applyMatrix4(target.matrix);
      target.normal.getElement(vertexIndices[corner]!, value);
      normals[corner]!.set(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0).applyNormalMatrix(target.normalMatrix).normalize();
    }
    const minX = clampInt(Math.floor(Math.min(uv[0]!.x, uv[1]!.x, uv[2]!.x)), 0, resolution - 1);
    const maxX = clampInt(Math.ceil(Math.max(uv[0]!.x, uv[1]!.x, uv[2]!.x)), 0, resolution - 1);
    const minY = clampInt(Math.floor(Math.min(uv[0]!.y, uv[1]!.y, uv[2]!.y)), 0, resolution - 1);
    const maxY = clampInt(Math.ceil(Math.max(uv[0]!.y, uv[1]!.y, uv[2]!.y)), 0, resolution - 1);
    const denominator = edge(uv[0]!, uv[1]!, uv[2]!);
    if (Math.abs(denominator) < 0.000001) continue;
    for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
      const sample = new THREE.Vector2(x + 0.5, y + 0.5);
      const w0 = edge(uv[1]!, uv[2]!, sample) / denominator;
      const w1 = edge(uv[2]!, uv[0]!, sample) / denominator;
      const w2 = 1 - w0 - w1;
      if (w0 < -0.0001 || w1 < -0.0001 || w2 < -0.0001) continue;
      worldPosition.copy(positions[0]!).multiplyScalar(w0).addScaledVector(positions[1]!, w1).addScaledVector(positions[2]!, w2);
      worldNormal.copy(normals[0]!).multiplyScalar(w0).addScaledVector(normals[1]!, w1).addScaledVector(normals[2]!, w2).normalize();
      const shade = evaluateLighting(worldPosition, worldNormal, options, acceleration, scratch);
      const finalValue = THREE.MathUtils.clamp(1 - options.strength + options.strength * shade, 0, 1);
      const byte = Math.round(linearToSrgb(finalValue) * 255);
      const pixelIndex = y * resolution + x;
      const channel = pixelIndex * 4;
      pixels[channel] = pixels[channel + 1] = pixels[channel + 2] = byte;
      pixels[channel + 3] = 255;
      if (!covered[pixelIndex]) { covered[pixelIndex] = 1; added += 1; }
    }
  }
  return added;
}

function evaluateLighting(position: THREE.Vector3, normal: THREE.Vector3, options: WebLightmapOptions, acceleration: SceneAcceleration, scratch: LightingScratch): number {
  let result = THREE.MathUtils.clamp(options.ambient, 0, 1);
  for (const light of options.lights) {
    if (!light.enabled || light.intensity <= 0) continue;
    const direction = scratch.direction.fromArray(light.type === "point" ? light.position : light.direction);
    if (light.type === "point") direction.sub(position);
    const distance = direction.length();
    direction.normalize();
    let attenuation = 1;
    if (light.type === "point") attenuation = Math.pow(Math.max(0, 1 - distance / Math.max(light.range, 0.001)), 2);
    const diffuse = Math.max(0, normal.dot(direction));
    if (diffuse <= 0 || attenuation <= 0) continue;
    const visible = !options.shadows || !isOccluded(position, normal, direction, light.type === "point" ? distance : Infinity, acceleration, scratch);
    if (visible) result += diffuse * light.intensity * attenuation * (scratch.luminance.get(light.id) ?? 1);
  }
  if (options.ambientOcclusion && acceleration.bvh) {
    let blocked = 0;
    for (let index = 0; index < options.aoSamples; index += 1) {
      const direction = hemisphereDirection(normal, index, options.aoSamples, scratch);
      if (isOccluded(position, normal, direction, acceleration.radius * 0.18, acceleration, scratch)) blocked += 1;
    }
    result *= 1 - (blocked / options.aoSamples) * 0.65;
  }
  return THREE.MathUtils.clamp(result, 0, 1);
}

function isOccluded(position: THREE.Vector3, normal: THREE.Vector3, direction: THREE.Vector3, far: number, acceleration: SceneAcceleration, scratch: LightingScratch): boolean {
  if (!acceleration.bvh) return false;
  scratch.origin.copy(position).addScaledVector(normal, acceleration.epsilon).addScaledVector(direction, acceleration.epsilon);
  scratch.ray.set(scratch.origin, direction);
  return acceleration.bvh.raycastFirst(scratch.ray, THREE.DoubleSide, acceleration.epsilon, far) !== null;
}

function hemisphereDirection(normal: THREE.Vector3, index: number, count: number, scratch: LightingScratch): THREE.Vector3 {
  const phi = index * 2.399963229728653;
  const cosTheta = (index + 0.5) / count;
  const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
  const local = scratch.local.set(Math.cos(phi) * sinTheta, Math.sin(phi) * sinTheta, cosTheta);
  const tangent = Math.abs(normal.z) < 0.999 ? scratch.tangent.set(0, 0, 1).cross(normal).normalize() : scratch.tangent.set(1, 0, 0);
  const bitangent = scratch.bitangent.copy(normal).cross(tangent);
  return scratch.direction.copy(tangent).multiplyScalar(local.x).addScaledVector(bitangent, local.y).addScaledVector(normal, local.z).normalize();
}

function triangleIndices(target: PrimitiveBakeTarget): number[] {
  const count = target.indices?.getCount() ?? target.position.getCount();
  if (!target.indices) return Array.from({ length: count }, (_, index) => index);
  const output = new Array<number>(count);
  const value: number[] = [];
  for (let index = 0; index < count; index += 1) {
    target.indices.getElement(index, value);
    output[index] = value[0] ?? 0;
  }
  return output;
}

function localBounds(target: PrimitiveBakeTarget): THREE.Box3 {
  const bounds = new THREE.Box3();
  const value: number[] = [];
  for (let index = 0; index < target.position.getCount(); index += 1) {
    target.position.getElement(index, value);
    bounds.expandByPoint(new THREE.Vector3(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0));
  }
  return bounds;
}

function dilateTexture(pixels: Uint8ClampedArray, covered: Uint8Array, resolution: number, iterations: number) {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sourcePixels = pixels.slice();
    const sourceCovered = covered.slice();
    for (let y = 1; y < resolution - 1; y += 1) for (let x = 1; x < resolution - 1; x += 1) {
      const index = y * resolution + x;
      if (sourceCovered[index]) continue;
      const neighbor = [index - 1, index + 1, index - resolution, index + resolution].find((candidate) => sourceCovered[candidate]);
      if (neighbor === undefined) continue;
      pixels.set(sourcePixels.subarray(neighbor * 4, neighbor * 4 + 4), index * 4);
      covered[index] = 1;
    }
  }
}

async function encodePng(pixels: Uint8ClampedArray, resolution: number): Promise<Uint8Array> {
  const imagePixels = Uint8ClampedArray.from(pixels);
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(resolution, resolution);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持光照贴图 Canvas 编码");
    context.putImageData(new ImageData(imagePixels, resolution, resolution), 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = resolution;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持光照贴图 Canvas 编码");
    context.putImageData(new ImageData(imagePixels, resolution, resolution), 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("光照贴图 PNG 编码失败")), "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  }
  throw new Error("光照贴图烘焙仅支持浏览器环境");
}

function edge(a: THREE.Vector2, b: THREE.Vector2, point: THREE.Vector2): number {
  return (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
}

function colorLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  const value = match?.[1] ?? "ffffff";
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

function clampInt(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function yieldToBrowser(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 0)); }
