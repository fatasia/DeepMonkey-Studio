import { type Document, type Mesh, type Primitive } from "@gltf-transform/core";
import { KHRMaterialsEmissiveStrength } from "@gltf-transform/extensions";
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { BakeLightState } from "./modelOptimizer";
import { denoiseTexture, dilateTexture, encodeLightmapPng } from "./lightmapTexture";
import { createBounceScratch, diffuseBounce, type BounceSurface } from "./lightmapIndirect";
import { createLightmapMaterialSamplers, type SurfaceSample } from "./lightmapMaterial";
import { packLightmapRadiance } from "./lightmapRadiance";
import { separateLightmapInstances } from "./lightmapInstances";

export interface WebLightmapOptions {
  resolution: 256 | 512 | 1024;
  strength: number;
  ambient: number;
  ambientColor: string;
  lights: BakeLightState[];
  ambientOcclusion: boolean;
  aoSamples: 4 | 8;
  shadows: boolean;
  shadowSamples: 1 | 4 | 8;
  indirectSamples: 0 | 2 | 4 | 64;
  denoise: boolean;
}

export interface WebLightmapResult {
  resolution: number;
  primitives: number;
  generatedUvs: number;
  coveredTexels: number;
  textureBytes: number;
  uvAtlas: "watlas" | "projected-fallback";
  shadowSamples: number;
  indirectSamples: number;
  denoised: boolean;
  emissiveStrength: number;
}

export interface PrimitiveBakeTarget {
  primitive: Primitive;
  mesh: Mesh;
  matrix: THREE.Matrix4;
  normalMatrix: THREE.Matrix3;
  position: NonNullable<ReturnType<Primitive["getAttribute"]>>;
  normal: NonNullable<ReturnType<Primitive["getAttribute"]>>;
  lightmapUv?: NonNullable<ReturnType<Primitive["getAttribute"]>> | undefined;
  indices?: NonNullable<ReturnType<Primitive["getIndices"]>> | undefined;
}

export interface SceneAcceleration {
  bvh?: MeshBVH;
  geometry?: THREE.BufferGeometry;
  radius: number;
  epsilon: number;
  surfaces?: BounceSurface[];
}

interface LightingScratch {
  direction: THREE.Vector3;
  sampleDirection: THREE.Vector3;
  origin: THREE.Vector3;
  tangent: THREE.Vector3;
  bitangent: THREE.Vector3;
  local: THREE.Vector3;
  ray: THREE.Ray;
  bounce: ReturnType<typeof createBounceScratch>;
  indirect: THREE.Vector3;
  colors: Map<string, THREE.Color>;
  ambientColor: THREE.Color;
  lighting: THREE.Vector3;
}

/**
 * Browser-only, single-atlas static lightmap baker.
 *
 * The generated texture is attached as the standard glTF occlusion texture on
 * TEXCOORD_1, so it survives GLB export and remains usable outside Deep Monkey Studio.
 * It preserves existing base-color textures and intentionally avoids offline
 * path tracing, UV chart optimization, and multi-bounce GI.
 */
export async function bakeWebLightmap(
  document: Document,
  options: WebLightmapOptions,
  onProgress?: (message: string) => void,
  encodeTexture: (pixels: Uint8ClampedArray, resolution: number) => Promise<Uint8Array> = encodeLightmapPng,
): Promise<WebLightmapResult> {
  const separatedInstances = separateLightmapInstances(document);
  const targets = collectTargets(document);
  if (targets.length === 0) throw new Error("模型没有可用于光照贴图的三角面和法线");
  const samplers = await createLightmapMaterialSamplers(targets.map(target => target.primitive), undefined, options.indirectSamples > 0);
  const resolution = options.resolution;
  const occlusionPixels = new Uint8ClampedArray(resolution * resolution * 4);
  const linearLighting = new Float32Array(resolution * resolution * 4);
  const covered = new Uint8Array(resolution * resolution);
  occlusionPixels.fill(255);

  onProgress?.("正在构建场景遮挡加速结构");
  const acceleration = options.shadows || options.ambientOcclusion || options.indirectSamples > 0 ? buildSceneAcceleration(targets, samplers) : { radius: 1, epsilon: 0.0001 };
  try {
  const hasUnwrappedAtlas = !separatedInstances && targets.every((target) => target.lightmapUv?.getCount() === target.position.getCount());
  const gridSize = Math.ceil(Math.sqrt(targets.length));
  const cellSize = resolution / gridSize;
  let generatedUvs = 0;
  let coveredTexels = 0;

  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const target = targets[targetIndex]!;
    const localUvs = hasUnwrappedAtlas ? readUvs(target.lightmapUv!) : generateProjectedUvs(target);
    if (!hasUnwrappedAtlas) generatedUvs += 1;
    const atlasUvs = hasUnwrappedAtlas ? localUvs : placeUvsInAtlas(localUvs, targetIndex, gridSize, cellSize, resolution);
    target.primitive.setAttribute(
      "TEXCOORD_1",
      document
        .createAccessor("Deep Monkey Studio lightmap UV")
        .setType("VEC2")
        .setArray(atlasUvs)
        .setBuffer(document.getRoot().listBuffers()[0] ?? document.createBuffer("Deep Monkey Studio lightmap")),
    );
    coveredTexels += await rasterizePrimitive(target, atlasUvs, occlusionPixels, linearLighting, covered, resolution, options, acceleration, samplers.get(target.primitive)!);
    if (targetIndex % 12 === 0) {
      onProgress?.(`正在烘焙光照贴图 ${targetIndex + 1}/${targets.length}`);
      await yieldToBrowser();
    }
  }

  const { pixels: lightingPixels, strength: emissiveStrength } = packLightmapRadiance(linearLighting);
  if (options.denoise) {
    onProgress?.("正在对光照贴图降噪");
    denoiseTexture(occlusionPixels, covered, resolution, options.indirectSamples >= 4 ? 2 : 1);
    denoiseTexture(lightingPixels, covered, resolution, options.indirectSamples >= 4 ? 2 : 1);
  }
  onProgress?.("正在填充光照贴图边缘");
  dilateTexture(occlusionPixels, covered.slice(), resolution, 3);
  dilateTexture(lightingPixels, covered.slice(), resolution, 3);
  const [occlusionPng, lightingPng] = await Promise.all([encodeTexture(occlusionPixels, resolution), encodeTexture(lightingPixels, resolution)]);
  const occlusionTexture = document.createTexture("Deep Monkey Studio Occlusion Lightmap").setMimeType("image/png").setImage(occlusionPng);
  const lightingTexture = document.createTexture("Deep Monkey Studio Colored Lightmap").setMimeType("image/png").setImage(lightingPng);
  const materials = new Set(targets.map((target) => target.primitive.getMaterial()).filter((material) => material !== null));
  const emissionExtension = document.createExtension(KHRMaterialsEmissiveStrength);
  for (const material of materials) {
    material!.setOcclusionTexture(occlusionTexture).setOcclusionStrength(1);
    material!.getOcclusionTextureInfo()!.setTexCoord(1);
    material!.setEmissiveTexture(lightingTexture).setEmissiveFactor([1, 1, 1]);
    material!.setExtension("KHR_materials_emissive_strength", emissionExtension.createEmissiveStrength().setEmissiveStrength(emissiveStrength));
    material!.getEmissiveTextureInfo()!.setTexCoord(1);
    material!.setExtras({
      ...material!.getExtras(),
      bimStudioLightmap: {
        mode: "occlusion+chroma-emissive",
        texCoord: 1,
        resolution,
        shadows: options.shadows,
        softShadowSamples: options.shadowSamples,
        indirectSamples: options.indirectSamples,
        indirectMethod: "single-bounce-diffuse",
        ambientOcclusion: options.ambientOcclusion,
        denoise: options.denoise,
        colored: true,
        preservesBaseColor: true,
        uvAtlas: hasUnwrappedAtlas ? "watlas" : "projected-fallback",
      },
    });
  }
  return {
    resolution,
    primitives: targets.length,
    generatedUvs,
    coveredTexels,
    textureBytes: occlusionPng.byteLength + lightingPng.byteLength,
    uvAtlas: hasUnwrappedAtlas ? "watlas" : "projected-fallback",
    shadowSamples: options.shadowSamples,
    indirectSamples: options.indirectSamples,
    denoised: options.denoise,
    emissiveStrength,
  };
  } finally { acceleration.geometry?.dispose(); }
}

export function collectTargets(document: Document): PrimitiveBakeTarget[] {
  const firstMatrixByMesh = new Map<Mesh, THREE.Matrix4>();
  let fallbackMaterial = document
    .getRoot()
    .listMaterials()
    .find((material) => material.getName() === "Deep Monkey Studio lightmap default");
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
        fallbackMaterial ??= document.createMaterial("Deep Monkey Studio lightmap default");
        primitive.setMaterial(fallbackMaterial);
      }
      targets.push({
        primitive,
        mesh,
        matrix,
        normalMatrix,
        position,
        normal,
        lightmapUv: primitive.getAttribute("TEXCOORD_1") ?? undefined,
        indices: primitive.getIndices() ?? undefined,
      });
    }
  }
  return targets;
}

export function buildSceneAcceleration(targets: PrimitiveBakeTarget[], samplers: Map<Primitive, SurfaceSample>): SceneAcceleration {
  const positions: number[] = [];
  const surfaces: BounceSurface[] = [];
  const point = new THREE.Vector3();
  const bounds = new THREE.Box3();
  for (const target of targets) {
    const indices = triangleIndices(target);
    const material = target.primitive.getMaterial()!;
    const base = material.getBaseColorFactor();
    const surface = { diffuse: new THREE.Vector3(base[0], base[1], base[2]).multiplyScalar(1 - material.getMetallicFactor()),
      emission: new THREE.Vector3().fromArray(material.getEmissiveFactor()), doubleSided: material.getDoubleSided() };
    for (let offset = 0; offset + 2 < indices.length; offset += 3) {
      const corners = indices.slice(offset, offset + 3), pointValues: number[] = [];
      const vertices = corners.map(index => { target.position.getElement(index, pointValues);return new THREE.Vector3().fromArray(pointValues).applyMatrix4(target.matrix); });
      const barycentric = new THREE.Vector3(), weights = [0, 0, 0];
      surfaces.push({ ...surface, sample: (point, diffuse, emission) => {
        THREE.Triangle.getBarycoord(point, vertices[0]!, vertices[1]!, vertices[2]!, barycentric);
        barycentric.toArray(weights);return samplers.get(target.primitive)!(corners, weights, diffuse, emission);
      } });
    }
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
  return { bvh, geometry, surfaces, radius, epsilon: Math.max(radius * 0.00002, 0.00001) };
}

function readUvs(accessor: NonNullable<PrimitiveBakeTarget["lightmapUv"]>): Float32Array<ArrayBuffer> {
  const uvs = new Float32Array(accessor.getCount() * 2);
  const value: number[] = [];
  for (let index = 0; index < accessor.getCount(); index += 1) {
    accessor.getElement(index, value);
    uvs[index * 2] = value[0] ?? 0;
    uvs[index * 2 + 1] = value[1] ?? 0;
  }
  return uvs;
}

function generateProjectedUvs(target: PrimitiveBakeTarget): Float32Array<ArrayBuffer> {
  const count = target.position.getCount();
  const uvs = new Float32Array(count * 2);
  const value: number[] = [];
  const normal: number[] = [];
  const bounds = localBounds(target);
  const size = bounds.getSize(new THREE.Vector3());
  const minimum = bounds.min;
  for (let index = 0; index < count; index += 1) {
    target.position.getElement(index, value);
    target.normal.getElement(index, normal);
    const ax = Math.abs(normal[0] ?? 0),
      ay = Math.abs(normal[1] ?? 0),
      az = Math.abs(normal[2] ?? 0);
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

async function rasterizePrimitive(
  target: PrimitiveBakeTarget,
  uvs: Float32Array,
  occlusionPixels: Uint8ClampedArray,
  lightingPixels: Float32Array,
  covered: Uint8Array,
  resolution: number,
  options: WebLightmapOptions,
  acceleration: SceneAcceleration,
  sampleMaterial: SurfaceSample,
): Promise<number> {
  const indices = triangleIndices(target);
  const positions = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const normals = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const worldPosition = new THREE.Vector3();
  const worldNormal = new THREE.Vector3();
  const scratch: LightingScratch = {
    direction: new THREE.Vector3(),
    sampleDirection: new THREE.Vector3(),
    origin: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    bitangent: new THREE.Vector3(),
    local: new THREE.Vector3(),
    ray: new THREE.Ray(),
    bounce: createBounceScratch(),
    indirect: new THREE.Vector3(),
    lighting: new THREE.Vector3(),
    ambientColor: new THREE.Color(options.ambientColor),
    colors: new Map(options.lights.map((light) => [light.id, new THREE.Color(light.color)])),
  };
  const value: number[] = [];
  const receiverDiffuse = new THREE.Vector3(), receiverEmission = new THREE.Vector3(), weights = [0, 0, 0];
  let added = 0;
  let lastYield = nowMilliseconds();
  for (let offset = 0; offset + 2 < indices.length; offset += 3) {
    const vertexIndices = [indices[offset]!, indices[offset + 1]!, indices[offset + 2]!];
    const uv = vertexIndices.map((index) => new THREE.Vector2(uvs[index * 2]! * (resolution - 1), (1 - uvs[index * 2 + 1]!) * (resolution - 1)));
    for (let corner = 0; corner < 3; corner += 1) {
      target.position.getElement(vertexIndices[corner]!, value);
      positions[corner]!.set(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0).applyMatrix4(target.matrix);
      target.normal.getElement(vertexIndices[corner]!, value);
      normals[corner]!.set(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0)
        .applyNormalMatrix(target.normalMatrix)
        .normalize();
    }
    const minX = clampInt(Math.floor(Math.min(uv[0]!.x, uv[1]!.x, uv[2]!.x)), 0, resolution - 1);
    const maxX = clampInt(Math.ceil(Math.max(uv[0]!.x, uv[1]!.x, uv[2]!.x)), 0, resolution - 1);
    const minY = clampInt(Math.floor(Math.min(uv[0]!.y, uv[1]!.y, uv[2]!.y)), 0, resolution - 1);
    const maxY = clampInt(Math.ceil(Math.max(uv[0]!.y, uv[1]!.y, uv[2]!.y)), 0, resolution - 1);
    const denominator = edge(uv[0]!, uv[1]!, uv[2]!);
    if (Math.abs(denominator) < 0.000001) continue;
    for (let y = minY; y <= maxY; y += 1)
      for (let x = minX; x <= maxX; x += 1) {
        const sample = new THREE.Vector2(x + 0.5, y + 0.5);
        const w0 = edge(uv[1]!, uv[2]!, sample) / denominator;
        const w1 = edge(uv[2]!, uv[0]!, sample) / denominator;
        const w2 = 1 - w0 - w1;
        if (w0 < -0.0001 || w1 < -0.0001 || w2 < -0.0001) continue;
        worldPosition.copy(positions[0]!).multiplyScalar(w0).addScaledVector(positions[1]!, w1).addScaledVector(positions[2]!, w2);
        worldNormal.copy(normals[0]!).multiplyScalar(w0).addScaledVector(normals[1]!, w1).addScaledVector(normals[2]!, w2).normalize();
        evaluateLighting(worldPosition, worldNormal, options, acceleration, scratch);
        weights[0] = w0;weights[1] = w1;weights[2] = w2;
        sampleMaterial(vertexIndices, weights, receiverDiffuse, receiverEmission);
        const lightLevel = THREE.MathUtils.clamp(scratch.lighting.x * 0.2126 + scratch.lighting.y * 0.7152 + scratch.lighting.z * 0.0722, 0, 1);
        const finalOcclusion = THREE.MathUtils.clamp(1 - options.strength * (1 - lightLevel), 0, 1);
        const occlusionByte = Math.round(finalOcclusion * 255);
        const pixelIndex = y * resolution + x;
        const channel = pixelIndex * 4;
        occlusionPixels[channel] = occlusionPixels[channel + 1] = occlusionPixels[channel + 2] = occlusionByte;
        occlusionPixels[channel + 3] = 255;
        const neutralLight = Math.min(scratch.lighting.x, scratch.lighting.y, scratch.lighting.z);
        lightingPixels[channel] = lightmapRadiance(scratch.lighting.x, neutralLight, options.strength, scratch.indirect.x * receiverDiffuse.x, receiverEmission.x);
        lightingPixels[channel + 1] = lightmapRadiance(scratch.lighting.y, neutralLight, options.strength, scratch.indirect.y * receiverDiffuse.y, receiverEmission.y);
        lightingPixels[channel + 2] = lightmapRadiance(scratch.lighting.z, neutralLight, options.strength, scratch.indirect.z * receiverDiffuse.z, receiverEmission.z);
        lightingPixels[channel + 3] = 255;
        if (!covered[pixelIndex]) {
          covered[pixelIndex] = 1;
          added += 1;
        }
      }
    if (nowMilliseconds() - lastYield >= 12) {
      await yieldToBrowser();
      lastYield = nowMilliseconds();
    }
  }
  return added;
}

function evaluateLighting(position: THREE.Vector3, normal: THREE.Vector3, options: WebLightmapOptions, acceleration: SceneAcceleration, scratch: LightingScratch): number {
  let occlusion = 1;
  if (options.ambientOcclusion && acceleration.bvh) {
    let blocked = 0;
    for (let index = 0; index < options.aoSamples; index += 1) {
      const direction = hemisphereDirection(normal, index, options.aoSamples, scratch);
      if (isOccluded(position, normal, direction, acceleration.radius * 0.18, acceleration, scratch)) blocked += 1;
    }
    occlusion = 1 - (blocked / options.aoSamples) * 0.65;
  }
  scratch.lighting.set(scratch.ambientColor.r, scratch.ambientColor.g, scratch.ambientColor.b).multiplyScalar(THREE.MathUtils.clamp(options.ambient, 0, 1) * occlusion);
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
    let visibility = 1;
    if (options.shadows) {
      let visibleSamples = 0;
      for (let sampleIndex = 0; sampleIndex < options.shadowSamples; sampleIndex += 1) {
        const sampleDirection =
          options.shadowSamples === 1
            ? scratch.sampleDirection.copy(direction)
            : jitterDirection(
                direction,
                sampleIndex,
                options.shadowSamples,
                light.type === "directional" ? 0.035 : Math.min(0.12, (light.range / Math.max(distance, 0.001)) * 0.018),
                scratch,
              );
        if (!isOccluded(position, normal, sampleDirection, light.type === "point" ? distance : Infinity, acceleration, scratch)) visibleSamples += 1;
      }
      visibility = visibleSamples / options.shadowSamples;
    }
    const color = scratch.colors.get(light.id);
    if (visibility > 0 && color) {
      const contribution = diffuse * light.intensity * attenuation * visibility;
      scratch.lighting.x += color.r * contribution;
      scratch.lighting.y += color.g * contribution;
      scratch.lighting.z += color.b * contribution;
    }
  }
  diffuseBounce(position, normal, options.indirectSamples, acceleration, options.lights, scratch.indirect, scratch.bounce);
  return THREE.MathUtils.clamp(occlusion, 0, 1);
}

export function isOccluded(position: THREE.Vector3, normal: THREE.Vector3, direction: THREE.Vector3, far: number, acceleration: SceneAcceleration, scratch: Pick<LightingScratch, "origin" | "ray">): boolean {
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

function jitterDirection(direction: THREE.Vector3, index: number, count: number, spread: number, scratch: LightingScratch): THREE.Vector3 {
  const angle = index * 2.399963229728653;
  const radius = Math.sqrt((index + 0.5) / count) * spread;
  const tangent = Math.abs(direction.z) < 0.999 ? scratch.tangent.set(0, 0, 1).cross(direction).normalize() : scratch.tangent.set(1, 0, 0);
  const bitangent = scratch.bitangent.copy(direction).cross(tangent);
  return scratch.sampleDirection
    .copy(direction)
    .addScaledVector(tangent, Math.cos(angle) * radius)
    .addScaledVector(bitangent, Math.sin(angle) * radius)
    .normalize();
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

function edge(a: THREE.Vector2, b: THREE.Vector2, point: THREE.Vector2): number {
  return (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
}

function lightmapRadiance(channel: number, neutralLight: number, strength: number, indirect = 0, emission = 0): number {
  return Math.max(0, ((channel - neutralLight) * 0.65 + indirect) * strength + emission);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
function nowMilliseconds(): number {
  return globalThis.performance?.now() ?? Date.now();
}
