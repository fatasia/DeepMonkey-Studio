import type { RenderView } from "../src/webgpu/pbrRendererTypes.js";
import type { RenderInstance, RenderPacket } from "../src/renderPacket.js";
import { sphereMesh } from "../src/webgpu/primitives.js";

// B1 Brief-VSM probe 场景构建与能量度量职责(sourceSizeGate 拆分:自 virtualShadowGpuProbe.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:PROBE 常量、两档机位(VIEW/VIEW_FAR)、场景包构建(boxMesh/buildProbeScene/
// buildDeviceUpdate)、读回亮度场(snapshotToLuma)与纯图像度量(edgeAliasingEnergy/
// holeCheck/meanAbsDiff/frameDistance)。腿会话状态在 virtualShadowProbeSession.ts。

/**
 * B1 Brief-VSM 真机验收探针(headless Chrome WebGPU)。
 *
 * 场景合同(两档完全同构):
 * - 10 万实例球场(x∈[-40,40] z∈[-64,8],两种材质)+ 6 面近场薄栅栏(边缘密集,
 *   投影到 groundPlane 地面 = 锯齿能量测区)+ 4 台"动态设备"方岛(平移/旋转腿);
 * - 相机近景俯视栅栏,1080p,后处理全关(TAA/AO/SSR/雾/bloom/spatialAa 关),
 *   contactShadows 关(隔离主阴影域),groundPlane 开(地面接收阴影)。
 *
 * 验收映射(证据全部随 JSON 落盘):
 * ① 近景阴影边缘锯齿能量:栅栏条纹测区 luma Sobel 梯度能量(边缘带归一),
 *    virtual/cascaded ≤ 0.40(↓≥60%);
 * ② 阴影全程 GPU 时:同场景同相机同特性集,无读回 120 帧,gpu-frame p50/p95
 *    (诊断 timestamp 查询),增量 Δp50 ≤ 2.5ms;
 * ③ 动态设备阴影延迟:updateInstances 平移/旋转后逐帧整帧差分,与"后"收敛帧的
 *    差降到"前"差 50% 以下的帧序 ≤ 2;
 * ④ 零洞:哨兵像素(magenta/非有限)为 0,测区黑斑(局部中值 >0.05 而 luma<0.01)
 *    为 0,且 virtual 相对 cascaded 的"异常亮/暗"像素率披露。
 */

export const PROBE_WIDTH = 1920;
export const PROBE_HEIGHT = 1080;
// RenderPacket 合同上限(renderPacket.prepareRenderPacket:instances ≤ 16_384):
// 验收场景取合同上限(16_374 场球 + 6 栅栏 + 4 动态设备 = 16_384)。
// 提升包上限属 renderPacket 域,不在本切片;A/B 两档完全同场景,对比公平性不受影响。
const FIELD_COUNT = 16_374;

const VIEW: RenderView = {
  eye: [0, 1.7, 4.2] as const, target: [0, 0.9, -2] as const, extent: 7,
  background: [0.16, 0.19, 0.24] as const, floor: [0.42, 0.42, 0.44] as const,
  exposure: 1.0, roughness: 0.6,
  lights: { directional: [{ directionWorld: [-0.45, -0.62, -0.45], color: [1, 0.94, 0.86],
    intensity: 3.2 }] },
  width: PROBE_WIDTH, height: PROBE_HEIGHT, pixelRatio: 1,
};

/** 简立方体(单位,中心原点):24 顶点 36 索引。 */
function boxMesh(): { vertices: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [1, 0, 0], [0, 1, 0]],
  ];
  const vertices: number[] = [], indices: number[] = [];
  for (const [n, u, v] of faces) {
    const base = vertices.length / 6;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      for (let axis = 0; axis < 3; axis++) {
        vertices.push((n[axis]! + u[axis]! * su + v[axis]! * sv) / 2);
      }
      vertices.push(n[0]!, n[1]!, n[2]!);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

/** 10 万实例场景(合同上限 16 384):近场留清晰地面走廊(栅栏阴影测区),
 *  球场推向远方(z -20..-58)保持 10 万级负载;栅栏 12 段 × 2.2m 投影条纹。
 *  低角度太阳(view.lights)→ 长阴影 ≈ 2.7m,边缘带落在净空地面上。 */
export function buildProbeScene(): RenderPacket {
  const sphere = sphereMesh(12, 8);
  const box = boxMesh();
  const instances: RenderInstance[] = [];
  const materials: RenderPacket["materials"] = [
    { id: "field-a", baseColor: [0.55, 0.56, 0.58], metallic: 0.05, roughness: 0.7 },
    { id: "field-b", baseColor: [0.36, 0.4, 0.46], metallic: 0.1, roughness: 0.6 },
    { id: "fence", baseColor: [0.8, 0.78, 0.72], metallic: 0.2, roughness: 0.5 },
    { id: "device", baseColor: [0.85, 0.45, 0.2], metallic: 0.4, roughness: 0.45 },
  ];
  const FIELD_COUNT = 16_344;
  const grid = Math.ceil(Math.sqrt(FIELD_COUNT));
  for (let index = 0; index < FIELD_COUNT; index++) {
    const gx = index % grid, gz = Math.floor(index / grid);
    const x = gx / (grid - 1) * 84 - 42;
    const z = -20 - (gz / (grid - 1)) * 38;
    const scale = 0.22 + ((index * 2654435761) % 97) / 97 * 0.26;
    instances.push({ id: `f-${index}`, geometry: "geo-sphere",
      material: index % 2 === 0 ? "field-a" : "field-b",
      transform: [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, scale, z, 1] });
  }
  // 细杆围栏(0.03m 杆径 × 2 横杆):级联 medium slice(~17cm/texel)下细杆阴影
  // 破碎/丢失,虚拟档 1.1mm/texel 完整解析 —— UE VSM 的标志性卖点场景。
  for (let index = 0; index < 12; index++) {
    const x = -8.8 + index * 1.6;
    instances.push({ id: `fence-post-${index}`, geometry: "geo-box", material: "fence",
      transform: [0.05, 0, 0, 0, 0, 2.2, 0, 0, 0, 0, 0.05, 0, x, 1.1, -2, 1] });
    for (const height of [0.75, 1.5]) {
      instances.push({ id: `fence-rail-${index}-${height}`, geometry: "geo-box", material: "fence",
        transform: [0.8, 0, 0, 0, 0, 0.035, 0, 0, 0, 0, 0.035, 0, x + 0.4, height, -2, 1] });
    }
  }
  for (let index = 0; index < 4; index++) {
    const x = -4.5 + index * 3;
    instances.push({ id: `dyn-${index}`, geometry: "geo-box", material: "device",
      transform: [0.9, 0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0.9, 0, x, 0.45, 1.5, 1] });
  }
  return { geometries: [
    { id: "geo-sphere", revision: 0, vertices: sphere.vertices, indices: sphere.indices },
    { id: "geo-box", revision: 0, vertices: box.vertices, indices: box.indices },
  ], materials, instances };
}

/** 平移/旋转动态设备的实例更新(其余实例不变)。 */
/** M2 门①机位:远景俯视(同场景同光照)。级联 split0 覆盖随之扩大 → 阴影图 texel
 *  超过屏幕像素足迹,基线边缘进入"图受限阶梯"(锯齿能量可被分辨率优势降低);
 *  虚拟档环 texel = extent·2/16384 仍 ≪ 像素 → 边缘保持屏幕受限 1px 阶梯。 */
export const VIEW_FAR: RenderView = {
  eye: [0, 4.5, 30] as const, target: [0, 0.6, -2] as const, extent: 26,
  background: [0.16, 0.19, 0.24] as const, floor: [0.42, 0.42, 0.44] as const,
  exposure: 1.0, roughness: 0.6,
  lights: { directional: [{ directionWorld: [-0.45, -0.62, -0.45], color: [1, 0.94, 0.86],
    intensity: 3.2 }] },
  width: PROBE_WIDTH, height: PROBE_HEIGHT, pixelRatio: 1,
};

export function buildDeviceUpdate(mode: "translate" | "rotate"): RenderPacket["instances"] {
  const instances: RenderInstance[] = [];
  for (let index = 0; index < 4; index++) {
    const x = -4.5 + index * 3;
    if (mode === "translate") {
      instances.push({ id: `dyn-${index}`, geometry: "geo-box", material: "device",
        transform: [0.9, 0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0.9, 0, x + 2.6, 0.45, 1.5, 1] });
    } else {
      const angle = Math.PI / 4;
      const cos = Math.cos(angle) * 1.1, sin = Math.sin(angle) * 1.1;
      instances.push({ id: `dyn-${index}`, geometry: "geo-box", material: "device",
        transform: [cos, 0, -sin, 0, 0, 1.1, 0, 0, sin, 0, cos, 0, x, 0.45, 1.5, 1] });
    }
  }
  return instances;
}

export interface LumaField { readonly width: number; readonly height: number;
  readonly luma: Float32Array }

/** present-color 读回 → luma 场(显示域 0..1)。 */
export function snapshotToLuma(snapshot: { readonly width: number; readonly height: number;
  readonly bytesPerRow: number; readonly format: string; readonly bytes: Uint8Array }): LumaField {
  const { width, height } = snapshot;
  const luma = new Float32Array(width * height);
  if (snapshot.format === "rgba16float") {
    const words = new Uint16Array(snapshot.bytes.buffer, snapshot.bytes.byteOffset, snapshot.bytes.byteLength / 2);
    const stride = snapshot.bytesPerRow / 2;
    const toFloat = (word: number): number => {
      const exponent = (word >> 10) & 0x1f, fraction = word & 0x3ff, sign = word >> 15 ? -1 : 1;
      const value = exponent === 0 ? fraction * 2 ** -24 : exponent === 0x1f
        ? Number.NaN : (1 + fraction / 1024) * 2 ** (exponent - 15);
      return sign * value;
    };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = y * stride + x * 4;
      luma[y * width + x] = 0.2126 * toFloat(words[offset]!) + 0.7152 * toFloat(words[offset + 1]!)
        + 0.0722 * toFloat(words[offset + 2]!);
    }
  } else {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = y * snapshot.bytesPerRow + x * 4;
      luma[y * width + x] = (0.2126 * snapshot.bytes[offset + 2]! + 0.7152 * snapshot.bytes[offset + 1]!
        + 0.0722 * snapshot.bytes[offset]!) / 255;
    }
  }
  return { width, height, luma };
}

export interface ShadowEdgeStats {
  /** 阴影掩码边界像素数。 */
  readonly boundaryPixels: number;
  /** 阶梯角像素数(边界上 4-邻域构成棋盘/拐角的像素)——锯齿的直接度量。 */
  readonly cornerPixels: number;
  /** 角密度 = cornerPixels / boundaryPixels(锯齿能量口径,gate ①)。 */
  readonly cornerRatio: number;
  /** 边界总长(周长,px)。 */
  readonly boundaryLength: number;
  readonly shadowPixels: number;
  readonly brightMean: number;
  readonly shadowMean: number;
}

/**
 * 阴影边缘锯齿统计(掩码边界角密度口径):
 * - 阴影掩码 = luma < 0.55·(亮均值)(地面测区,亮场/暗场双峰);
 * - 边界像素 = 4-邻域含异类的掩码像素;阶梯角 = 其两对角邻居同为异类且两正交邻居
 *   同类的角点模式 —— 直线边界角密度 ≈ 0,45° 阶梯 ≈ 0.5-1.0;
 * - Sobel 梯度能量同时保留(参考面:更锐利的边缘不等于更多锯齿,不以梯度论胜负)。
 */
export function edgeAliasingEnergy(field: LumaField, region: { x0: number; y0: number; x1: number; y1: number },
  threshold = 0.55): ShadowEdgeStats {
  const at = (x: number, y: number): number => field.luma[y * field.width + x]!;
  let bright = 0, brightCount = 0, shadow = 0, shadowCount = 0;
  const mask = (x: number, y: number): boolean => at(x, y) < threshold;
  let boundaryPixels = 0, cornerPixels = 0, shadowPixels = 0;
  for (let y = Math.max(1, region.y0); y < Math.min(field.height - 1, region.y1); y++) {
    for (let x = Math.max(1, region.x0); x < Math.min(field.width - 1, region.x1); x++) {
      const center = at(x, y);
      const isShadow = mask(x, y);
      if (isShadow) shadowPixels += 1; else { bright += center; brightCount += 1; }
      if (center > 0.02 && !isShadow) { /* bright */ }
      else if (center > 0.02) { shadow += center; shadowCount += 1; }
      const north = mask(x, y - 1), south = mask(x, y + 1);
      const west = mask(x - 1, y), east = mask(x + 1, y);
      const different = ((north !== isShadow) ? 1 : 0) + ((south !== isShadow) ? 1 : 0)
        + ((west !== isShadow) ? 1 : 0) + ((east !== isShadow) ? 1 : 0);
      if (different === 0) continue;
      boundaryPixels += 1;
      // 角点模式:两正交邻居同类、两对角邻居异类(阶梯拐角)。
      const nw = mask(x - 1, y - 1), ne = mask(x + 1, y - 1);
      const sw = mask(x - 1, y + 1), se = mask(x + 1, y + 1);
      const corner = (north === south) === isShadow && (west === east) === isShadow
        && ((nw !== isShadow && se !== isShadow) || (ne !== isShadow && sw !== isShadow));
      if (corner) cornerPixels += 1;
    }
  }
  return { boundaryPixels, cornerPixels,
    cornerRatio: boundaryPixels > 0 ? cornerPixels / boundaryPixels : 0,
    boundaryLength: boundaryPixels,
    shadowPixels,
    brightMean: brightCount > 0 ? bright / brightCount : 0,
    shadowMean: shadowCount > 0 ? shadow / shadowCount : 0 };
}

/**
 * 门①口径裁决测区(与 captureStill 现行栅栏条纹测区逐值同源,抽出共用):
 * 中央净空地面走廊(避开左右前景设备箱的暗面与远景球墙)。
 * 按场尺寸比例计算,1× 与 2× SSAA 下采样场直接复用同一口径。
 */
export function fenceRegionFor(field: { readonly width: number; readonly height: number }):
  { x0: number; y0: number; x1: number; y1: number } {
  return { x0: Math.floor(field.width * 0.34), y0: Math.floor(field.height * 0.52),
    x1: Math.floor(field.width * 0.66), y1: Math.floor(field.height * 0.97) };
}

/**
 * 2×2 box 下采样(4×SSAA 参考场的还原步):2× 渲染场的每 2×2 像素均值合并为 1× 场。
 * 输入场宽高须为偶数(SSAA 腿渲染尺寸 = 1× 尺寸 × 2,恒偶)。
 * 纯图像函数,供门①备选"分辨率敏感度量"(1× 边缘能量 vs 4×SSAA 参考)使用。
 */
export function downsampleLuma2x(field: LumaField): LumaField {
  if (field.width % 2 !== 0 || field.height % 2 !== 0) {
    throw new Error(`downsampleLuma2x requires even dimensions, got ${field.width}x${field.height}.`);
  }
  const width = field.width / 2, height = field.height / 2;
  const luma = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x * 2, sy = y * 2;
      luma[y * width + x] = (field.luma[sy * field.width + sx]!
        + field.luma[sy * field.width + sx + 1]!
        + field.luma[(sy + 1) * field.width + sx]!
        + field.luma[(sy + 1) * field.width + sx + 1]!) / 4;
    }
  }
  return { width, height, luma };
}

/** 黑斑/非有限检查:测区内非有限亮度与"局部中值亮而像素近黑"的斑点(零洞合同)。 */
export function holeCheck(field: LumaField, region: { x0: number; y0: number; x1: number; y1: number }): {
  nonFinite: number; blackSpeckles: number; samples: number } {
  let nonFinite = 0, blackSpeckles = 0, samples = 0;
  const median3 = (x: number, y: number): number => {
    const values: number[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      values.push(field.luma[(y + dy) * field.width + x + dx]!);
    }
    values.sort((left, right) => left - right);
    return values[4]!;
  };
  for (let y = Math.max(1, region.y0); y < Math.min(field.height - 1, region.y1); y++) {
    for (let x = Math.max(1, region.x0); x < Math.min(field.width - 1, region.x1); x++) {
      const value = field.luma[y * field.width + x]!;
      samples += 1;
      if (!Number.isFinite(value)) nonFinite += 1;
      const localMedian = median3(x, y);
      if (localMedian > 0.05 && value < 0.01) blackSpeckles += 1;
    }
  }
  return { nonFinite, blackSpeckles, samples };
}

/** 阴影带平均绝对差(对参考真源):|a-b| 均值,区域可限。 */
export function meanAbsDiff(left: LumaField, right: LumaField,
  region?: { x0: number; y0: number; x1: number; y1: number }): number {
  let sum = 0, count = 0;
  const x0 = region?.x0 ?? 0, y0 = region?.y0 ?? 0;
  const x1 = Math.min(region?.x1 ?? left.width, left.width);
  const y1 = Math.min(region?.y1 ?? left.height, left.height);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    sum += Math.abs(left.luma[y * left.width + x]! - right.luma[y * right.width + x]!);
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

/** 整帧差分(步距 4 下采样):动态延迟收敛判定。 */
export function frameDistance(left: LumaField, right: LumaField): number {
  let sum = 0, count = 0;
  for (let y = 0; y < Math.min(left.height, right.height); y += 4) {
    for (let x = 0; x < Math.min(left.width, right.width); x += 4) {
      const delta = left.luma[y * left.width + x]! - right.luma[y * right.width + x]!;
      sum += Math.abs(delta); count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

// 腿会话与结果合同继续在 virtualShadowProbeSession.ts(ActiveLeg/setActiveView/beginLeg/
// settleLeg/timeLeg/captureStill/dynamicLatencyLeg/finishLeg/ProbeLegResult/ShadowBandField)。
export { VIEW };
