import type { PbrMaterial, RenderPacket } from "../src/renderPacketTypes.js";
import type { RenderView } from "../src/webgpu/pbrRendererTypes.js";
import type { DecodedTexture } from "../src/textures/decodedTexture.js";
import type { PbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { decodeHalfFloat } from "../src/rayTracing/probeGridBakeMath.js";
import { serializeBrowserRenderPacket, materializeRuntimeRenderPacket } from "../src/runtimePackage/renderPacket.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
type Capture = (m: PbrMaterial, name: string, v?: RenderView, textures?: readonly DecodedTexture[], packet?: RenderPacket) => Promise<PbrFrameReadbackSnapshot>;
const color = [.8, .4, .1] as const, rough = .6;
const locations = [800, 960, 1120].flatMap(x => [420, 540, 660].map(y => [x, y] as const));
function rgb(image: PbrFrameReadbackSnapshot, x: number, y: number) {
  const data = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
  return [0, 1, 2].map(i => decodeHalfFloat(data.getUint16(y * image.bytesPerRow + x * 8 + i * 2, true)));
}
function delta(a: PbrFrameReadbackSnapshot, b: PbrFrameReadbackSnapshot) {
  return Math.max(...locations.flatMap(([x, y]) => rgb(a, x, y).map((v, i) => Math.abs(v - rgb(b, x, y)[i]!))));
}
/** Separate local Lambda/NDF formula; does not call the production CPU/WGSL response. */
function expected(x: number, y: number, strength: number, tangent: readonly number[]) {
  const px = (2 * (x + .5) / 1920 - 1) * 1920 / 1080 * Math.tan(.4);
  const py = (1 - 2 * (y + .5) / 1080) * Math.tan(.4);
  const v = [-px, -py, 1].map(a => a / Math.hypot(px, py, 1));
  const h = [v[0]!, v[1]!, v[2]! + 1].map(a => a / Math.hypot(v[0]!, v[1]!, v[2]! + 1));
  const length = Math.hypot(tangent[0]!, tangent[1]!);
  const t = length > 1e-4 ? [tangent[0]! / length, tangent[1]! / length] : [0, -1];
  const c = Math.cos(Math.fround(.4)), s = Math.sin(Math.fround(.4));
  const tr = [t[0]! * c - t[1]! * s, t[1]! * c + t[0]! * s];
  const br = [-tr[1]!, tr[0]!], local = (w: number[]) => [tr[0]! * w[0]! + tr[1]! * w[1]!, br[0]! * w[0]! + br[1]! * w[1]!];
  const ax = Math.fround(rough) ** 2 * (1 + Math.fround(strength)), ay = Math.fround(rough) ** 2;
  const hh = local(h), vv = local(v), D = 1 / (Math.PI * ax * ay * ((hh[0]! / ax) ** 2 + (hh[1]! / ay) ** 2 + h[2]! ** 2) ** 2);
  const lambda = (Math.sqrt(1 + ((ax * vv[0]!) ** 2 + (ay * vv[1]!) ** 2) / v[2]! ** 2) - 1) / 2;
  const vh = v.reduce((sum, value, i) => sum + value * h[i]!, 0);
  return color.map(f0 => (Math.fround(f0) + (1 - Math.fround(f0)) * (1 - vh) ** 5) * D / (4 * v[2]! * (1 + lambda)));
}
function transformPacket(source: RenderPacket, matrix: readonly number[], tag: string) {
  const a = matrix[0]!, b = matrix[1]!, c = matrix[4]!, d = matrix[5]!, det = a * d - b * c;
  const geometry = source.geometries[0]!, vertices = geometry.vertices.slice();
  for (let i = 0; i < vertices.length; i += 6) {
    const x = vertices[i]!, y = vertices[i + 1]!;
    vertices[i] = (d * x - c * y) / det; vertices[i + 1] = (-b * x + a * y) / det;
    vertices[i + 5] = Math.sign(det);
  }
  const id = `${geometry.id}:metal-${tag}`;
  return { ...source, geometries: [{ ...geometry, id, vertices }], instances: source.instances.map(instance => ({ ...instance, geometry: id, transform: matrix })) };
}
export async function runMetalReflectionFrames(frame: Capture, base: PbrMaterial, view: RenderView, packet: (m: PbrMaterial, textures?: readonly DecodedTexture[]) => RenderPacket) {
  const lit: RenderView = { ...view, environmentIntensity: 0, lights: { directional: [{ directionWorld: [0, 0, -1], color: [1, 1, 1], intensity: 1, castShadow: false }] } };
  const material = (strength: number, coverage = 1): PbrMaterial => ({ ...base, layered: { layers: [{
    responseModel: "microfacet-metal-reflection", coverage, params: { anisotropy: { strength, rotation: .4 } },
    surface: { baseColor: color, metallic: 1, roughness: rough },
  }] } });
  const transforms = [
    { name: "identity", a: 1, b: 0, c: 0, d: 1 },
    { name: "nonuniform-rotated", a: .8 * Math.cos(.5), b: .8 * Math.sin(.5), c: -1.3 * Math.sin(.5), d: 1.3 * Math.cos(.5) },
    { name: "mirror", a: -1, b: 0, c: 0, d: 1 },
    { name: "degenerate-tangent", a: 1e-5, b: 0, c: 0, d: 1 },
  ];
  const cases = []; let maxClosedError = 0; const hashes: Record<string, string> = {};
  for (const transform of transforms) for (const strength of [0, 1e-7, .01, 1]) {
    const m = material(strength), matrix = [transform.a, transform.b, 0, 0, transform.c, transform.d, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const actualPacket = transformPacket(packet(m, []), matrix, transform.name);
    const image = await frame(m, `metal-${transform.name}-${strength}`, lit, [], actualPacket);
    const error = Math.max(...locations.flatMap(([x, y]) => rgb(image, x, y).map((value, i) => Math.abs(value - expected(x, y, strength, [transform.a, transform.b])[i]!))));
    maxClosedError = Math.max(maxClosedError, error); cases.push({ transform: transform.name, strength, error });
    hashes[`${transform.name}/${strength}`] = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", image.bytes.slice()))).map(value => value.toString(16).padStart(2, "0")).join("");
  }
  const active = material(.8), activeImage = await frame(active, "metal-save-source", lit, []);
  const json = serializeBrowserRenderPacket(packet(active, [])), restored = materializeRuntimeRenderPacket(JSON.parse(json), "$.browserPacket");
  const restoredImage = await frame(restored.materials[0]!, "metal-restored", lit, [], restored);
  const stock = await frame(base, "metal-legacy-stock", lit, []);
  const defaultLayer = await frame({ ...base, layered: { layers: [{ coverage: 1 }] } }, "metal-legacy-layer", lit, []);
  const pruned = await frame(material(.8, 0), "metal-pruned", lit, []);
  const noSun = { ...lit, environmentIntensity: 1, lights: { directional: [] } };
  const plainMetal = { ...base, baseColor: color, metallic: 1, roughness: rough, emissiveFactor: [.13, .07, .02] as const };
  const auxStock = await frame(plainMetal, "metal-aux-stock", noSun, []);
  const auxActive = await frame({ ...plainMetal, layered: active.layered! }, "metal-aux-active", noSun, []);
  const textureImage = async (alpha: number) => {
    const texture: DecodedTexture = { id: `metal-color-alpha-${alpha}`, revision: 0, semantic: "baseColor", width: 2, height: 2,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
      data: new Uint8Array([255,64,128,alpha,64,255,128,alpha,128,64,255,alpha,128,255,64,alpha]) };
    const textured = { ...active, layered: { layers: [{ ...active.layered!.layers![0]!, surface: {
      baseColor: color, metallic: 1, roughness: rough, baseColorTexture: { texture: texture.id, texCoord: 1 as const, offset: [.13, .04] as const, scale: [.75, .8] as const },
    } }] } };
    return frame(textured, `metal-texture-alpha-${alpha}`, lit, [texture]);
  };
  const colorParent = await textureImage(255), colorHalf = await textureImage(128), colorZero = await textureImage(0);
  const alphaBlendError = Math.max(...locations.flatMap(([x, y]) => rgb(colorHalf, x, y).map((value, i) => {
    const weight = 128 / 255; return Math.abs(value - (rgb(stock, x, y)[i]! * (1 - weight) + rgb(colorParent, x, y)[i]! * weight));
  })));
  const samples = { maxClosedError, cases, maxRestoredDelta: delta(activeImage, restoredImage),
    legacyDelta: delta(stock, defaultLayer), zeroDelta: delta(stock, pruned), auxiliaryDelta: delta(auxStock, auxActive),
    alphaBlendError, alphaZeroDelta: delta(stock, colorZero), textureDelta: delta(activeImage, colorParent), hashes };
  return { mode: "metal-reflection", ...samples, passedMath: maxClosedError <= .002 && samples.maxRestoredDelta === 0
    && samples.legacyDelta === 0 && samples.zeroDelta === 0 && samples.auxiliaryDelta === 0
    && samples.alphaBlendError <= .002 && samples.alphaZeroDelta === 0 && samples.textureDelta > .01 };
}
