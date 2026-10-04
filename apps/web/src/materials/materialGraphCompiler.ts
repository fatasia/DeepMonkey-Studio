import type { SceneMaterialState } from "@bim-studio/contracts";
import type { MaterialGraphDefinition, MaterialGraphLayer } from "./materialGraphModel";
import { MATERIAL_GRAPH_TEXTURE_SIZE } from "./materialGraphModel";
import { maskGrid } from "./materialGraphNoise";

/**
 * 材质图预合成编译器(编辑器刀 7)。
 *
 * 技术路线:编辑器侧预合成(零引擎改动)。分层合成在纯字节网格上完成
 * (确定性核心,Node 单测逐字节断言),再经 Canvas 光栅化为 PNG dataURL,
 * 写入既有 SceneMaterialState 贴图槽(引擎 TextureLoader 原生支持 dataURL):
 * - 颜色层 → baseColorMapUrl(RGBA 合成图);
 * - 粗糙度/金属度层 → 一张 ORM 打包图(R=255,G=roughness,B=metalness)同时写入
 *   roughnessMapUrl + metalnessMapUrl,标量置 1(three:贴图 × 标量,绝对值已烘进通道);
 * - 凹凸层 → 高度场 Sobel 法线图 → normalMapUrl,normalScale=1。
 * 只有启用了对应通道的层才接管对应槽;未接管的槽保持对象原状。
 * 不做自定义 HLSL;不做运行时图求值。
 */

export interface CompiledGraphGrids {
  size: number;
  /** 合成基色 RGBA;仅当存在启用颜色层时有效(useColor=true)。 */
  rgba: Uint8ClampedArray;
  rough: Uint8ClampedArray;
  metal: Uint8ClampedArray;
  height: Float32Array;
  used: { color: boolean; roughness: boolean; metalness: boolean; bump: boolean };
}

export interface GraphTextureUrls {
  colorUrl?: string;
  ormUrl?: string;
  normalUrl?: string;
}

export interface CompiledMaterialGraph {
  grids: CompiledGraphGrids;
  urls: GraphTextureUrls;
  patch: SceneMaterialState;
  compileMs: number;
}

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function hexToScalar(hex: string): number {
  return parseInt(hex.slice(1, 3), 16) / 255;
}

function enabledLayers(graph: MaterialGraphDefinition): MaterialGraphLayer[] {
  return graph.layers.filter(layer => layer.enabled);
}

/**
 * 纯函数网格合成(确定性核心):同一定义两次调用逐字节相等。
 * 颜色从底材质出发逐层 lerp/multiply;粗糙度/金属度逐层 lerp;高度逐层累加。
 */
export function compileGraphGrids(
  graph: MaterialGraphDefinition,
  size: number = MATERIAL_GRAPH_TEXTURE_SIZE,
  sampleTextureMask?: (layer: MaterialGraphLayer, u: number, v: number) => number,
): CompiledGraphGrids {
  const px = size * size;
  const rgba = new Uint8ClampedArray(px * 4);
  const rough = new Uint8ClampedArray(px);
  const metal = new Uint8ClampedArray(px);
  const height = new Float32Array(px);
  const [br, bg, bb] = hexToRgb(graph.base.color);
  const baseRoughByte = Math.round(graph.base.roughness * 255);
  const baseMetalByte = Math.round(graph.base.metalness * 255);
  const layers = enabledLayers(graph);
  const used = {
    color: layers.some(layer => layer.useColor),
    roughness: layers.some(layer => layer.useRoughness),
    metalness: layers.some(layer => layer.useMetalness),
    bump: layers.some(layer => layer.bump > 0),
  };
  const maskCache = new Map<string, Uint8ClampedArray>();
  for (const layer of layers) {
    const key = layer.id;
    if (layer.useColor || layer.useRoughness || layer.useMetalness || layer.bump > 0) {
      maskCache.set(key, maskGrid(layer.mask, size, sampleTextureMask
        ? (u, v) => sampleTextureMask(layer, u, v)
        : undefined));
    }
  }
  for (let i = 0; i < px; i += 1) {
    const o = i * 4;
    let r = br, g = bg, b = bb;
    let roughByte = baseRoughByte;
    let metalByte = baseMetalByte;
    let heightValue = 0;
    for (const layer of layers) {
      const mask = maskCache.get(layer.id);
      if (!mask) continue;
      const alpha = (mask[i]! / 255) * layer.opacity;
      if (alpha <= 0) continue;
      if (layer.useColor) {
        const [lr, lg, lb] = hexToRgb(layer.color);
        if (layer.blend === "multiply") {
          // 正片叠底:result = mix(base, base×layer, alpha)
          r += (r * lr / 255 - r) * alpha;
          g += (g * lg / 255 - g) * alpha;
          b += (b * lb / 255 - b) * alpha;
        } else {
          r += (lr - r) * alpha;
          g += (lg - g) * alpha;
          b += (lb - b) * alpha;
        }
      }
      if (layer.useRoughness) roughByte += (Math.round(layer.roughness * 255) - roughByte) * alpha;
      if (layer.useMetalness) metalByte += (Math.round(layer.metalness * 255) - metalByte) * alpha;
      if (layer.bump > 0) heightValue += alpha * layer.bump;
    }
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    rough[i] = roughByte;
    metal[i] = metalByte;
    height[i] = heightValue;
  }
  return { size, rgba, rough, metal, height, used };
}

/** 网格 → 法线贴图 RGB 字节(Sobel 3×3,世界 Z 朝外);输出 length = px*4。 */
export function heightToNormalRgba(height: Float32Array, size: number, strength = 2): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)]!;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)
        - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) * strength;
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)
        - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      out[o] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((dy * inv * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  }
  return out;
}

/** 确定性 hex 解析用于网格断言;非法输入返回黑。 */
export function graphBaseRgb(graph: MaterialGraphDefinition): [number, number, number] {
  return hexToRgb(graph.base.color);
}

/** 底材质粗糙度字节(网格基线断言用)。 */
export function graphBaseRoughByte(graph: MaterialGraphDefinition): number {
  return Math.round(graph.base.roughness * 255);
}

/** 底材质金属度字节。 */
export function graphBaseMetalByte(graph: MaterialGraphDefinition): number {
  return Math.round(graph.base.metalness * 255);
}

/** 颜色标量十六进制(ORM 通道断言用)。 */
export function grayHexToByte(hex: string): number {
  return Math.round(hexToScalar(hex) * 255);
}

/** 网格 → PNG dataURL(DOM Canvas;浏览器环境运行)。 */
function gridToDataUrl(rgba: Uint8ClampedArray, size: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D 画布上下文不可用");
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), 0, 0);
  return canvas.toDataURL("image/png");
}

/** ORM 打包图:R=255(留空)、G=粗糙度、B=金属度(glTF ORM 对齐 three 通道语义)。 */
function packOrmRgba(rough: Uint8ClampedArray, metal: Uint8ClampedArray, size: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    const o = i * 4;
    out[o] = 255;
    out[o + 1] = rough[i]!;
    out[o + 2] = metal[i]!;
    out[o + 3] = 255;
  }
  return out;
}

/**
 * 光栅化 + 材质 patch:网格字节 → dataURL → SceneMaterialState。
 * 标量置 1 仅在贴图接管该通道时发生(three 有效值 = 贴图 × 标量)。
 */
export function graphMaterialPatch(
  urls: GraphTextureUrls,
): SceneMaterialState {
  const patch: SceneMaterialState = {};
  if (urls.colorUrl) {
    patch.baseColorMapUrl = urls.colorUrl;
    patch.baseColorMapName = "材质图合成色";
  }
  if (urls.ormUrl) {
    patch.roughnessMapUrl = urls.ormUrl;
    patch.metalnessMapUrl = urls.ormUrl;
    patch.roughnessMapName = "材质图粗糙度";
    patch.metalnessMapName = "材质图金属度";
    patch.roughness = 1;
    patch.metalness = 1;
  }
  if (urls.normalUrl) {
    patch.normalMapUrl = urls.normalUrl;
    patch.normalMapName = "材质图凹凸";
    patch.normalScale = 1;
  }
  return patch;
}

/** 端到端编译(浏览器):网格 → 光栅 → patch;同步返回,耗时如实报告。 */
export function compileMaterialGraph(
  graph: MaterialGraphDefinition,
  options: { size?: number; sampleTextureMask?: (layer: MaterialGraphLayer, u: number, v: number) => number } = {},
): CompiledMaterialGraph {
  const started = performance.now();
  const grids = compileGraphGrids(graph, options.size, options.sampleTextureMask);
  const urls: GraphTextureUrls = {};
  if (grids.used.color) urls.colorUrl = gridToDataUrl(grids.rgba, grids.size);
  if (grids.used.roughness || grids.used.metalness) urls.ormUrl = gridToDataUrl(packOrmRgba(grids.rough, grids.metal, grids.size), grids.size);
  if (grids.used.bump) urls.normalUrl = gridToDataUrl(heightToNormalRgba(grids.height, grids.size), grids.size);
  return { grids, urls, patch: graphMaterialPatch(urls), compileMs: performance.now() - started };
}
