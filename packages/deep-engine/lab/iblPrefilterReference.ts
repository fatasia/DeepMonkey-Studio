/**
 * I-C19 CPU 参考预滤波（对拍期望生成器）：与 `src/webgpu/environmentShader.ts` 的
 * `environmentImageMain`/`brdfMain` 同数学单源移植——hammersley/ggx/basis/cubeDirection、
 * equirectangular 双线性（U repeat / V clamp-to-edge，与 hdrEnvironment 采样器一致）、
 * GGX 重要性采样（a=roughness²）、余弦半球 diffuse、共享 correlated-Smith 可见性的 DFG。
 * WGSL 特例保留：diffuse=0 且 roughness<0.001 时 mip0 直接取全景图（weight=1）。
 * 期望读回以 fp16 存储（rgba16float），GPU 对拍门取 0.002（J3 经验值）。
 */
import type { RadianceHdrImage } from "../src/textures/radianceHdr.js";

const TWO_PI = Math.PI * 2;

export interface IblPrefilterOptions {
  readonly specularSize?: 64 | 128 | 256;
  readonly diffuseSize?: 16 | 32 | 64;
  readonly sampleCount?: 64 | 128 | 256;
}

export interface IblPrefilterReference {
  readonly specularSize: number;
  readonly diffuseSize: number;
  readonly sampleCount: number;
  readonly mipCount: number;
  /** RGB 交错、面优先（px-nx-py-ny-pz-nz）、行主序；mip[level] 尺寸为 specularSize >> level。 */
  readonly specular: readonly Float32Array[];
  readonly diffuse: Float32Array;
}

export function reverseBits32(value: number): number {
  let x = value >>> 0;
  x = ((x & 0x55555555) << 1) | ((x >>> 1) & 0x55555555);
  x = ((x & 0x33333333) << 2) | ((x >>> 2) & 0x33333333);
  x = ((x & 0x0f0f0f0f) << 4) | ((x >>> 4) & 0x0f0f0f0f);
  x = ((x & 0x00ff00ff) << 8) | ((x >>> 8) & 0x00ff00ff);
  return ((x << 16) | (x >>> 16)) >>> 0;
}

export function hammersley(index: number, count: number): readonly [number, number] {
  return [index / count, reverseBits32(index) * 2.3283064365386963e-10];
}

export function ggxHalfVector(xi: readonly [number, number], roughness: number): readonly [number, number, number] {
  const a = roughness * roughness;
  const cosine = Math.sqrt((1 - xi[1]) / Math.max(1 + (a * a - 1) * xi[1], 0.00001));
  const sine = Math.sqrt(Math.max(1 - cosine * cosine, 0));
  return [Math.cos(TWO_PI * xi[0]) * sine, Math.sin(TWO_PI * xi[0]) * sine, cosine];
}

const normalize3 = (v: readonly [number, number, number]): readonly [number, number, number] => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
};

export function basisDirection(n: readonly [number, number, number],
  direction: readonly [number, number, number]): readonly [number, number, number] {
  const up: readonly [number, number, number] = Math.abs(n[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
  const tangent = normalize3([up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]]);
  const bitangent: readonly [number, number, number] = [
    n[1] * tangent[2] - n[2] * tangent[1], n[2] * tangent[0] - n[0] * tangent[2], n[0] * tangent[1] - n[1] * tangent[0]];
  return normalize3([
    tangent[0] * direction[0] + bitangent[0] * direction[1] + n[0] * direction[2],
    tangent[1] * direction[0] + bitangent[1] * direction[1] + n[1] * direction[2],
    tangent[2] * direction[0] + bitangent[2] * direction[1] + n[2] * direction[2]]);
}

/** uv 已在 [-1,1]；面序与 WGSL cubeDirection 逐一相同。 */
export function cubeDirection(u: number, v: number, face: number): readonly [number, number, number] {
  switch (face) {
    case 0: return normalize3([1, -v, -u]);
    case 1: return normalize3([-1, -v, u]);
    case 2: return normalize3([u, 1, v]);
    case 3: return normalize3([u, -1, -v]);
    case 4: return normalize3([u, -v, 1]);
    default: return normalize3([-u, -v, -1]);
  }
}

/** WGSL textureSampleLevel 双线性：U repeat（按 tap 独立回绕）、V clamp-to-edge。 */
export function sampleEquirectangular(image: RadianceHdrImage,
  direction: readonly [number, number, number]): readonly [number, number, number] {
  const u = Math.atan2(direction[2], direction[0]) / TWO_PI + 0.5;
  const v = Math.acos(Math.min(Math.max(direction[1], -1), 1)) / Math.PI;
  const x = u * image.width - 0.5, y = v * image.height - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const column = (index: number): number => ((index % image.width) + image.width) % image.width;
  const row = (index: number): number => Math.min(Math.max(index, 0), image.height - 1);
  const texel = (col: number, row0: number): readonly [number, number, number] => {
    const base = (row0 * image.width + col) * 3;
    return [image.data[base]!, image.data[base + 1]!, image.data[base + 2]!];
  };
  const c00 = texel(column(x0), row(y0)), c10 = texel(column(x0 + 1), row(y0));
  const c01 = texel(column(x0), row(y0 + 1)), c11 = texel(column(x0 + 1), row(y0 + 1));
  const mix = (a: number, b: number): number => (a * (1 - fx) + b * fx) * (1 - fy);
  return [mix(c00[0], c10[0]) + (c01[0]! * (1 - fx) + c11[0]! * fx) * fy,
    mix(c00[1], c10[1]) + (c01[1]! * (1 - fx) + c11[1]! * fx) * fy,
    mix(c00[2], c10[2]) + (c01[2]! * (1 - fx) + c11[2]! * fx) * fy];
}

const accumulate = (color: [number, number, number], radiance: readonly [number, number, number], weight: number): void => {
  color[0] += radiance[0] * weight; color[1] += radiance[1] * weight; color[2] += radiance[2] * weight;
};

export function prefilterPanoramaReference(image: RadianceHdrImage,
  options: IblPrefilterOptions = {}): IblPrefilterReference {
  const specularSize = options.specularSize ?? 128, diffuseSize = options.diffuseSize ?? 32;
  const sampleCount = options.sampleCount ?? 128;
  if (![64, 128, 256].includes(specularSize) || ![16, 32, 64].includes(diffuseSize)
    || ![64, 128, 256].includes(sampleCount)) throw new Error("Invalid HDR environment quality setting.");
  const mipCount = Math.log2(specularSize) + 1;
  const specular: Float32Array[] = [];
  for (let level = 0; level < mipCount; level++) {
    const size = specularSize >> level, plane = new Float32Array(size * size * 6 * 3);
    const roughness = level / Math.max(mipCount - 1, 1);
    for (let face = 0; face < 6; face++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const n = cubeDirection(((x + 0.5) / size) * 2 - 1, ((y + 0.5) / size) * 2 - 1, face);
      const color: [number, number, number] = [0, 0, 0]; let weight = 0;
      if (roughness < 0.001) { accumulate(color, sampleEquirectangular(image, n), 1); weight = 1; }
      else for (let i = 0; i < sampleCount; i++) {
        const half = basisDirection(n, ggxHalfVector(hammersley(i, sampleCount), roughness));
        const nh = n[0] * half[0] + n[1] * half[1] + n[2] * half[2];
        const light: readonly [number, number, number] = // reflect(-n, half) = 2(n·h)h - n
          [2 * nh * half[0] - n[0], 2 * nh * half[1] - n[1], 2 * nh * half[2] - n[2]];
        const cosine = Math.max(n[0] * light[0] + n[1] * light[1] + n[2] * light[2], 0);
        accumulate(color, sampleEquirectangular(image, light), cosine); weight += cosine;
      }
      const base = ((face * size + y) * size + x) * 3, scale = 1 / Math.max(weight, 0.0001);
      plane[base] = color[0] * scale; plane[base + 1] = color[1] * scale; plane[base + 2] = color[2] * scale;
    }
    specular.push(plane);
  }
  const diffuse = new Float32Array(diffuseSize * diffuseSize * 6 * 3);
  for (let face = 0; face < 6; face++) for (let y = 0; y < diffuseSize; y++) for (let x = 0; x < diffuseSize; x++) {
    const n = cubeDirection(((x + 0.5) / diffuseSize) * 2 - 1, ((y + 0.5) / diffuseSize) * 2 - 1, face);
    const color: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < sampleCount; i++) {
      const xi = hammersley(i, sampleCount), radius = Math.sqrt(xi[1]);
      const light = basisDirection(n, [Math.cos(TWO_PI * xi[0]) * radius, Math.sin(TWO_PI * xi[0]) * radius,
        Math.sqrt(1 - xi[1])]);
      accumulate(color, sampleEquirectangular(image, light), 1);
    }
    const base = ((face * diffuseSize + y) * diffuseSize + x) * 3, scale = 1 / Math.max(sampleCount, 0.0001);
    diffuse[base] = color[0] * scale; diffuse[base + 1] = color[1] * scale; diffuse[base + 2] = color[2] * scale;
  }
  return { specularSize, diffuseSize, sampleCount, mipCount, specular, diffuse };
}

/** DFG LUT 参考：与 brdfMain 同积分（256 采样，共享 correlated-Smith 可见性）；RGBA，RG 有效。 */
export function brdfLutReference(width = 128): Float32Array {
  if (!Number.isInteger(width) || width < 1 || (width & (width - 1)) !== 0) throw new Error("LUT width must be a power of two.");
  const plane = new Float32Array(width * width * 4);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const nv = Math.max((x + 0.5) / width, 0.001), rough = (y + 0.5) / width;
    const view: readonly [number, number, number] = [Math.sqrt(1 - nv * nv), 0, nv];
    let scaleX = 0, scaleY = 0;
    for (let i = 0; i < 256; i++) {
      const h = ggxHalfVector(hammersley(i, 256), rough);
      const vh = Math.max(view[0] * h[0] + view[2] * h[2], 0);
      const light: readonly [number, number, number] = [2 * vh * h[0] - view[0], 0, 2 * vh * h[2] - view[2]];
      const nl = Math.max(light[2], 0), nh = Math.max(h[2], 0);
      if (nl <= 0) continue;
      const alpha = rough * rough, a2 = alpha * alpha;
      const shared = 0.5 / Math.max(nl * Math.sqrt(a2 + (1 - a2) * nv * nv)
        + nv * Math.sqrt(a2 + (1 - a2) * nl * nl), 0.000001);
      const visibility = 4 * nl * shared * vh / Math.max(nh, 0.0001);
      const fresnel = Math.pow(1 - vh, 5);
      scaleX += (1 - fresnel) * visibility; scaleY += fresnel * visibility;
    }
    const base = (y * width + x) * 4;
    plane[base] = scaleX / 256; plane[base + 1] = scaleY / 256; plane[base + 2] = 0; plane[base + 3] = 1;
  }
  return plane;
}

/**
 * 预算降级重定基的期望视图：保留链尾 keptMips 个 mip，mip0 基尺寸取 mips[raw-kept].size。
 * GPU 采样端把 roughness→level 钳制到 keptMips-1（接线留给主线程）。
 */
export function rebasedReferenceMips(reference: IblPrefilterReference, keptMips: number):
  { readonly baseSize: number; readonly planes: readonly Float32Array[] } {
  const raw = reference.specular.length;
  if (!Number.isInteger(keptMips) || keptMips < 1 || keptMips > raw) throw new Error("Invalid kept mip count.");
  const planes = reference.specular.slice(raw - keptMips);
  return { baseSize: reference.specularSize >> (raw - keptMips), planes };
}

/** 确定性合成 equirect：天空梯度 + 三盏软箱，非负、峰值约 8，用于对拍与热替换序列。 */
export function referencePanorama(width: number, height: number): RadianceHdrImage {
  if (!Number.isInteger(width) || width < 2 || !Number.isInteger(height) || height < 1) {
    throw new Error("Invalid reference panorama dimensions.");
  }
  const data = new Float32Array(width * height * 3);
  const dot3 = (a: readonly [number, number, number], b: readonly [number, number, number]): number =>
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // 与 WGSL softbox 逐行同构：right = normalize(cross((0,1,0), normal))，edge smoothstep(0.88,1)。
  const softbox = (direction: readonly [number, number, number], center: readonly [number, number, number],
    width: number, height: number): number => {
    const length = Math.hypot(center[0], center[1], center[2]);
    const normal: readonly [number, number, number] = [center[0] / length, center[1] / length, center[2] / length];
    const rightLength = Math.hypot(normal[2], 0, normal[0]);
    const right: readonly [number, number, number] = [normal[2] / rightLength, 0, -normal[0] / rightLength];
    const up: readonly [number, number, number] = [
      normal[1] * right[2] - normal[2] * right[1], normal[2] * right[0] - normal[0] * right[2],
      normal[0] * right[1] - normal[1] * right[0]];
    const forward = dot3(direction, normal);
    const pointX = dot3(direction, right) / Math.max(forward, 0.001);
    const pointY = dot3(direction, up) / Math.max(forward, 0.001);
    const edge = Math.max(Math.abs(pointX) / width, Math.abs(pointY) / height);
    const t = Math.min(Math.max((edge - 0.88) / 0.12, 0), 1), smooth = t * t * (3 - 2 * t);
    return (1 - smooth) * (forward >= 0 ? 1 : 0);
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const theta = ((y + 0.5) / height) * Math.PI, phi = (((x + 0.5) / width) - 0.5) * TWO_PI;
    const direction: readonly [number, number, number] = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
    const sky = 0.02 + 0.18 * Math.min(Math.max((direction[1] + 0.3) / 1.2, 0), 1);
    const key = softbox(direction, [-1, 1.5, 1], 0.7, 0.35), rim = softbox(direction, [1, 0.65, -1], 0.2, 0.8);
    const base = (y * width + x) * 3;
    data[base] = sky + 5 * key; data[base + 1] = sky + 4.8 * key + 2.8 * rim; data[base + 2] = sky + 4.4 * key + 3.4 * rim;
  }
  return { width, height, data };
}
