import { planSharedShadowAtlas } from "./sharedShadowAtlas.js";
import { buildShadowPageRequests, ShadowPageTable, type ShadowPageTileSpec } from "./shadowPages.js";

/**
 * F7 虚拟化阴影画质评估的纯 CPU 层：确定性场景、等预算双腿规划与画质判据。
 *
 * 评估域 = 局部光阴影（shadowPages 原型的域）。基线腿是现行默认的
 * sharedShadowAtlas（全有/全无 tile）；候选腿是 ShadowPageTable（mip 链驻留）。
 * 两腿在同字节预算下各自决定"每盏灯拿到的阴影图有效分辨率或无影"，供
 * lab/shadowPagingQualityGpuProbe.ts 在真机上按 granted 分辨率渲染对照。
 * 方向光级联不在本评估域：原型不分页级联数组，两者不竞争同一预算（报告口径）。
 */

export interface EvaluationOccluder {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface EvaluationSpotLight {
  readonly key: string;
  readonly importance: number;
  readonly position: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
  readonly outerHalfAngleRadians: number;
  readonly range: number;
  /** 接收者地板补丁（y=0）中心 xz 与半边长。 */
  readonly patchCenter: readonly [number, number];
  readonly patchHalfExtent: number;
  readonly occluders: readonly EvaluationOccluder[];
}

export interface EvaluationScenario {
  readonly lights: readonly EvaluationSpotLight[];
  readonly patchPitch: number;
}

export const EVALUATION_PATCH_HALF_EXTENT = 3;
export const EVALUATION_PATCH_PITCH = 7;
export const EVALUATION_LIGHT_HEIGHT = 5;

/** 每补丁三根竖条遮挡器：细→粗，分辨率与渗漏效应在不同影宽下均可观测。 */
const OCCLUDER_SPECS = Object.freeze([
  { offset: -1.6, width: 0.12, height: 1.5 },
  { offset: 0, width: 0.3, height: 1.2 },
  { offset: 1.6, width: 0.7, height: 0.9 },
] as const);

export function buildEvaluationLights(count: number): EvaluationScenario {
  if (!Number.isSafeInteger(count) || count < 1 || count > 16) {
    throw new RangeError("Evaluation light count must be a safe integer in 1..16.");
  }
  const grid = Math.ceil(Math.sqrt(count));
  const lights: EvaluationSpotLight[] = [];
  for (let index = 0; index < count; index += 1) {
    const column = index % grid, row = Math.floor(index / grid);
    const centerX = (column - (grid - 1) / 2) * EVALUATION_PATCH_PITCH;
    const centerZ = (row - (grid - 1) / 2) * EVALUATION_PATCH_PITCH;
    const half = EVALUATION_PATCH_HALF_EXTENT;
    const occluders = OCCLUDER_SPECS.map(spec => Object.freeze({
      min: Object.freeze([centerX + spec.offset - spec.width / 2, 0, centerZ - spec.width / 2]) as readonly [number, number, number],
      max: Object.freeze([centerX + spec.offset + spec.width / 2, spec.height, centerZ + spec.width / 2]) as readonly [number, number, number],
    }));
    // 半角覆盖补丁对角线加 0.5 m 余量，保证补丁完全在锥内（判据只看补丁内像素）。
    const diagonal = half * Math.SQRT2 + 0.5;
    lights.push(Object.freeze({
      key: `eval-spot-${index}`, importance: count - index,
      position: Object.freeze([centerX, EVALUATION_LIGHT_HEIGHT, centerZ]) as readonly [number, number, number],
      direction: Object.freeze([0, -1, 0]) as readonly [number, number, number],
      outerHalfAngleRadians: Math.atan(diagonal / EVALUATION_LIGHT_HEIGHT),
      range: EVALUATION_LIGHT_HEIGHT + 2,
      patchCenter: Object.freeze([centerX, centerZ]) as readonly [number, number],
      patchHalfExtent: half,
      occluders: Object.freeze(occluders),
    }));
  }
  return Object.freeze({ lights: Object.freeze(lights), patchPitch: EVALUATION_PATCH_PITCH });
}

export const EVALUATION_BUDGET_BYTES = 4 * 1024 * 1024;

export interface LegShadow {
  readonly key: string;
  /** 阴影图有效边长（texel）：atlas 为 tile 内有效尺寸（扣 guard），paged 为页 mip0 边长。 */
  readonly texels: number;
  readonly bytes: number;
}

export interface LegPlan {
  readonly strategy: "atlas" | "paged";
  readonly config: string;
  readonly budgetBytes: number;
  /** atlas = 图集保留字节（与灯数无关）；paged = 驻留字节（按量计费）。 */
  readonly depthBytes: number;
  readonly shadowed: readonly LegShadow[];
  readonly unshadowed: readonly string[];
}

export interface AtlasLegOptions {
  readonly requestedAtlasSize: number;
  readonly tileTexels: number;
}

/** 基线腿：现行 planSharedShadowAtlas 以等字节预算决定全有/全无 tile 分配。 */
export function planAtlasLeg(lights: readonly EvaluationSpotLight[], budgetBytes: number,
  options: AtlasLegOptions): LegPlan {
  const atlasSize = powerOfTwo(options.requestedAtlasSize, "atlas size");
  if (atlasSize < 64 || atlasSize > 8192) throw new RangeError("Atlas size must be in 64..8192.");
  if (atlasSize * atlasSize * 4 > budgetBytes) throw new RangeError("Requested atlas exceeds the evaluation budget.");
  const tilesPerAxis = atlasSize / powerOfTwo(options.tileTexels, "tile texels");
  if (!Number.isSafeInteger(tilesPerAxis) || tilesPerAxis < 1 || tilesPerAxis > 16) {
    throw new RangeError("tileTexels must divide the atlas into 1..16 tiles per axis.");
  }
  const plan = planSharedShadowAtlas(
    lights.map(light => ({ key: light.key, kind: "spot" as const, importance: light.importance })),
    { maxTextureDimension2D: atlasSize, maxDepthTextureBytes: budgetBytes },
    { requestedAtlasSize: atlasSize, tilesPerAxis,
      maxShadowedLights: tilesPerAxis * tilesPerAxis, maxShadowViews: tilesPerAxis * tilesPerAxis });
  const shadowed = plan.allocations.map(allocation => ({ key: allocation.key,
    texels: allocation.tiles[0]!.size, bytes: options.tileTexels * options.tileTexels * 4 }));
  return Object.freeze({ strategy: "atlas", config: `atlas-${options.tileTexels}`,
    budgetBytes, depthBytes: plan.estimatedDepthTextureBytes,
    shadowed: Object.freeze(shadowed), unshadowed: Object.freeze(plan.rejected.map(entry => entry.key)) });
}

export interface PagedLegOptions {
  readonly tileEdgeTexels: number;
  readonly mipLevels: number;
}

/** 候选腿：ShadowPageTable 以同预算做 mip 链驻留（mip0 先于深 mip，覆盖优先）。 */
export function planPagedLeg(lights: readonly EvaluationSpotLight[], budgetBytes: number,
  options: PagedLegOptions): LegPlan {
  const spec: ShadowPageTileSpec = { tileEdgeTexels: powerOfTwo(options.tileEdgeTexels, "page tile edge"),
    depthBytesPerTexel: 4 };
  const requests = buildShadowPageRequests(lights.map(light => ({ key: light.key, kind: "spot" as const,
    importance: light.importance, mipLevels: options.mipLevels })), spec);
  const plan = new ShadowPageTable(spec, { maxBytes: budgetBytes }).plan(requests, 0);
  const residentBytesByLight = new Map<string, number>();
  const mip0 = new Set<string>();
  for (const page of plan.resident) {
    residentBytesByLight.set(page.lightKey, (residentBytesByLight.get(page.lightKey) ?? 0) + page.costBytes);
    if (page.mip === 0) mip0.add(page.lightKey);
  }
  const shadowed = lights.filter(light => mip0.has(light.key)).map(light => ({ key: light.key,
    texels: spec.tileEdgeTexels, bytes: residentBytesByLight.get(light.key) ?? 0 }));
  return Object.freeze({ strategy: "paged", config: `paged-${spec.tileEdgeTexels}-mip${options.mipLevels}`,
    budgetBytes, depthBytes: plan.stats.residentBytes,
    shadowed: Object.freeze(shadowed), unshadowed: Object.freeze(lights.filter(light => !mip0.has(light.key)).map(light => light.key)) });
}

/** 解析硬影参考：接收点 → 灯位射线与遮挡器 AABB 的 slab 相交（t∈(ε,1)）。 */
export function analyticSpotVisibility(point: readonly [number, number, number],
  light: EvaluationSpotLight): boolean {
  const [ox, oy, oz] = point, [lx, ly, lz] = light.position;
  const dx = lx - ox, dy = ly - oy, dz = lz - oz;
  for (const occluder of light.occluders) {
    let entry = Number.EPSILON, exit = 1 - Number.EPSILON, hit = true;
    for (let axis = 0; axis < 3 && hit; axis += 1) {
      const origin = axis === 0 ? ox : axis === 1 ? oy : oz;
      const direction = axis === 0 ? dx : axis === 1 ? dy : dz;
      const boundMin = occluder.min[axis]!, boundMax = occluder.max[axis]!;
      if (Math.abs(direction) < 1e-9) {
        if (origin < boundMin || origin > boundMax) hit = false;
        continue;
      }
      let near = (boundMin - origin) / direction, far = (boundMax - origin) / direction;
      if (near > far) [near, far] = [far, near];
      entry = Math.max(entry, near); exit = Math.min(exit, far);
      if (entry > exit) hit = false;
    }
    if (hit && entry <= exit) return true;
  }
  return false;
}

/** 未遮挡辐照度（与 GPU probe 同式的 CPU 口径）：64/d²，d<1 截断。 */
export function spotIrradiance(point: readonly [number, number, number],
  light: EvaluationSpotLight): number {
  const [lx, ly, lz] = light.position;
  const dx = lx - point[0], dy = ly - point[1], dz = lz - point[2];
  return 64 / Math.max(1, dx * dx + dy * dy + dz * dz);
}

export interface ShadowQualityStats {
  readonly samples: number;
  readonly shadowedSamples: number;
  /** measured 与解析硬影可见度的 RMS 误差（可见度域 0..1）。 */
  readonly rmse: number;
  /** 参考影内测得可见度 > 0.1 的像素占比（渗漏）。 */
  readonly leakFraction: number;
  /** 影边缘 10%→90% 过渡宽度（像素）p50 / p95；无边缘时为 0。 */
  readonly edgeWidthP50: number;
  readonly edgeWidthP95: number;
}

/**
 * 补丁内画质判据：measured/reference 为行主序可见度数组（已按未遮挡辐照度归一），
 * mask 为有效样本（辐照度 ≥ 阈值），width 为补丁宽。
 */
export function summarizeShadowQuality(measured: Float32Array, reference: Float32Array,
  mask: Uint8Array, width: number): ShadowQualityStats {
  const height = mask.length / width;
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isInteger(height) || height < 1
    || measured.length !== mask.length || reference.length !== mask.length) {
    throw new RangeError("Shadow quality arrays must share the patch mask shape.");
  }
  let samples = 0, shadowed = 0, squared = 0, leak = 0;
  const widths: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (mask[index] === 0) continue;
      samples += 1;
      const expected = reference[index]!, actual = measured[index]!;
      squared += (actual - expected) * (actual - expected);
      if (expected === 0) {
        shadowed += 1;
        if (actual > 0.1) leak += 1;
      }
      const previous = x > 0 && mask[index - 1] === 1 ? reference[index - 1]! : expected;
      if (x > 0 && mask[index - 1] === 1 && previous !== expected) {
        const span = edgeTransitionWidth(measured, reference, mask, width, height, x, y, expected);
        if (span > 0) widths.push(span);
      }
    }
  }
  const sorted = [...widths].sort((left, right) => left - right);
  return Object.freeze({ samples, shadowedSamples: shadowed, rmse: samples > 0 ? Math.sqrt(squared / samples) : 0,
    leakFraction: shadowed > 0 ? leak / shadowed : 0,
    edgeWidthP50: percentile(sorted, 0.5), edgeWidthP95: percentile(sorted, 0.95) });
}

/**
 * 过渡宽度：参考边界（列 x-1 与 x 参考值不同）两侧窗口内，落在开区间 (0.1, 0.9)
 * 的中间样本数 + 1。硬边 = 1；半影每多一个中间像素 +1。平台安全（硬边不会被
 * 恒亮/恒暗平台拉长），且两侧必须各自存在 ≥0.9 / ≤0.1 锚点，否则放弃该过渡。
 */
function edgeTransitionWidth(measured: Float32Array, reference: Float32Array, mask: Uint8Array,
  width: number, height: number, x: number, y: number, expected: number): number {
  const window = 16;
  const at = (px: number, py: number): number => measured[py * width + px]!;
  const inMask = (px: number, py: number): boolean =>
    px >= 0 && px < width && py >= 0 && py < height && mask[py * width + px] === 1;
  // expected=0（入影）：亮侧在左（x-1）、影侧在右（x）；expected=1（出影）相反。
  const litSide = expected === 0 ? x - 1 : x;
  const shadowSide = expected === 0 ? x : x - 1;
  const litStep = expected === 0 ? -1 : 1;
  const shadowStep = expected === 0 ? 1 : -1;
  let litAnchor = false, shadowAnchor = false, middle = 0;
  for (let step = 0; step < window; step += 1) {
    const litPixel = litSide + litStep * step, shadowPixel = shadowSide + shadowStep * step;
    const litMasked = inMask(litPixel, y), shadowMasked = inMask(shadowPixel, y);
    if (litMasked && at(litPixel, y) >= 0.9) litAnchor = true;
    if (shadowMasked && at(shadowPixel, y) <= 0.1) shadowAnchor = true;
    if (litMasked && at(litPixel, y) > 0.1 && at(litPixel, y) < 0.9) middle += 1;
    if (shadowMasked && at(shadowPixel, y) > 0.1 && at(shadowPixel, y) < 0.9) middle += 1;
    if (!litMasked && !shadowMasked) break;
  }
  if (!litAnchor || !shadowAnchor) return 0;
  return middle + 1;
}

export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function powerOfTwo(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || (value & (value - 1)) !== 0) {
    throw new RangeError(`${label} must be a power-of-two safe integer.`);
  }
  return value;
}
