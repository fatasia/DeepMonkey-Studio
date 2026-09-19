// E02 IES 光域网集成（设计 §3.2/§3.3）：Web 着色消费的打包与 CPU 参考评测。
// 唯一权威采样语义在 iesSampling.intensityFactor；本文件只做「表进 GPU」的
// 等价变换与逐位可复算的 CPU 参考：
//   1. 垂直角展开：intensityFactor 先把 θ 量化到 0.5° 网格再做最近邻查表，因此
//      有效函数是 0.5° 网格上的阶梯函数——打包时按 361 个网格角（θ=0.5j）把
//      「最近邻 + 角域外为 0」预先展开进表，着色器零间接寻址且语义逐点相等；
//   2. 归一化：着色器只吃 candela/maxCandela（f32 存储，f64 除法经 fround 与
//      f32 除法同舍入：f64 尾数 ≥ 2×f24+2，无双舍入效应），factor = 存储值 ×
//      f32(scaleFactor)，跨端字节一致；
//   3. θ/φ 从方向向量推导（evaluateIesShadingFactor 与 WGSL deepSpotIesFactor
//      同式），0.5° 量化吸收两端 acos/atan2 的 ULP 差异。
// 无 ies 字段的灯：params.x = -1 → 因子恒等返回 1.0，`attenuation * 1.0` 在
// IEEE f32 下逐位恒等，既有路径字节不变。

import type { RuntimeLightProfile } from "../runtimePackage/environmentTypes.js";
import { intensityFactor, prepareIesSampling } from "./iesSampling.js";
import type { SpotLight } from "./types.js";

/** 展开表的列数：θ ∈ [0,180] 按 0.5° 网格 → 361 列。 */
export const IES_EXPANDED_COLUMNS = 361;
/** 每行占用的 vec4 数：ceil(361/4)，尾部 3 个分量填 0。 */
export const IES_TABLE_ROW_STRIDE_VEC4 = 91;
/** 打包缓冲预算（vec4 数）：512 行合同极限 × 91 ≈ 47k，多灯多 profile 场景再留裕量。 */
export const IES_MAX_SHADING_VEC4S = 1 << 20;
const MAX_PROFILES = 64;
const MAX_SPOTS = 65_535;
const DEG_PER_RAD = 180 / Math.PI;

/** 单个 storage buffer 的 vec4 布局：
 * [0, max(spotCount,1))          每灯参数 (profileIndex|-1, rotationHalfDeg, scaleFactor, metaBase|-)
 * [next, +profileCount)          每 profile 元数据 (tableBaseVec4, rowCount, rowHalfStep, symmetry)
 * [之后]                         展开的归一化光度表（每行 91 个 vec4）。
 * metaBase 直接存进参数字（着色器免知 spotCount）；评测端与着色器同读该字。 */
export interface PackedIesShading {
  readonly data: Float32Array;
  readonly vec4Count: number;
  readonly spotCount: number;
  readonly profileCount: number;
  /** 每 profile 的 tableBase（vec4 单位），供摘要与评测复算。 */
  readonly tableBases: readonly number[];
}

interface ResolvedIesSpot {
  readonly index: number;
  readonly profileIndex: number;
  readonly rotationHalfDeg: number;
  readonly scaleFactor: number;
}

function fail(message: string): never {
  throw new Error(`ies shading: ${message}`);
}

function integerFloat(value: number, label: string): number {
  if (!Number.isFinite(value) || Math.abs(value) >= 2 ** 24 || Math.abs(value - Math.round(value)) > 1e-9) {
    fail(`${label} 必须是可被 f32 精确表达的整数（半度数、行距或索引）`);
  }
  return Math.round(value);
}

/** 打包前的合同验证（列名报错，不静默降级为无 IES）。 */
function resolveIesSpots(spots: readonly SpotLight[], profiles: readonly RuntimeLightProfile[] | undefined): ResolvedIesSpot[] {
  const referenced: ResolvedIesSpot[] = [];
  for (const [index, spot] of spots.entries()) {
    const ies = spot.ies;
    if (ies === undefined) continue;
    if (profiles === undefined) {
      fail(`spots[${index}].ies 引用了 profileId ${ies.profileId}，但 lights 未携带 lightProfiles 载荷`);
    }
    const profileIndex = profiles.findIndex(profile => profile.profileId === ies.profileId);
    if (profileIndex < 0) {
      fail(`spots[${index}].ies.profileId ${ies.profileId} 未在 lightProfiles 中声明（已声明：${profiles.map(profile => profile.profileId).join(", ") || "（空）"}）`);
    }
    const rotation = ies.rotationDeg === undefined ? 0 : ies.rotationDeg;
    if (!Number.isFinite(rotation) || rotation < 0 || rotation >= 360) fail(`spots[${index}].ies.rotationDeg ${rotation} 超出 [0,360)`);
    const scale = ies.scaleFactor === undefined ? 1 : ies.scaleFactor;
    if (!Number.isFinite(scale) || scale < 0 || scale > 10) fail(`spots[${index}].ies.scaleFactor ${scale} 超出 [0,10]`);
    referenced.push({
      index,
      profileIndex,
      rotationHalfDeg: integerFloat(rotation * 2, `spots[${index}].ies.rotationDeg×2`),
      scaleFactor: Math.fround(scale),
    });
  }
  return referenced;
}

/**
 * 把一个 profile 的有效采样函数展开为 361 列（0.5° 网格）× 行 的归一化表。
 * 展开值 = intensityFactor（唯一权威）在行中心 φ 上的取值：行中心按
 * row = round(gHalf/rowHalfStep) 的逆像选取（落在折叠区内部，无镜像歧义），
 * 因此对任何折叠后落入该行的 φ，着色器查表值与 intensityFactor 逐点相等。
 * 值 = f32(candela/maxCandela)。
 */
export function expandIesProfileTable(profile: RuntimeLightProfile): Float32Array {
  const sampling = prepareIesSampling(profile);
  const rows = sampling.candela.length;
  const expanded = new Float32Array(rows * IES_EXPANDED_COLUMNS);
  for (let row = 0; row < rows; row += 1) {
    const rowCenterDeg = sampling.rowHalfStep === 0 ? 0 : row * sampling.rowHalfStep / 2;
    for (let column = 0; column < IES_EXPANDED_COLUMNS; column += 1) {
      const value = intensityFactor(sampling, column * 0.5, rowCenterDeg, 0, 1);
      expanded[row * IES_EXPANDED_COLUMNS + column] = value === 0 ? 0 : Math.fround(value);
    }
  }
  return expanded;
}

/** 把 view-space 灯阵与其 IES 载荷打包成 group-3 binding 12 的存储缓冲字节。
 * 无任何 ies 引用时返回仅含一个 -1 参数行的最小缓冲（因子恒 1，路径不变）。 */
export function packIesShading(spots: readonly SpotLight[], profiles?: readonly RuntimeLightProfile[]): PackedIesShading {
  if (spots.length > MAX_SPOTS) fail(`spot 数 ${spots.length} 超出打包上限 ${MAX_SPOTS}`);
  if ((profiles?.length ?? 0) > MAX_PROFILES) fail(`lightProfiles 数超出打包上限 ${MAX_PROFILES}`);
  const resolved = resolveIesSpots(spots, profiles);
  const usedProfiles: readonly RuntimeLightProfile[] = profiles ?? [];
  const spotSection = Math.max(spots.length, 1);
  const metaSection = usedProfiles.length;
  let tableVec4Count = 0;
  const tableBases: number[] = [];
  const expandedTables: Float32Array[] = [];
  for (const profile of usedProfiles) {
    tableBases.push(spotSection + metaSection + tableVec4Count);
    tableVec4Count += profile.candela.length * IES_TABLE_ROW_STRIDE_VEC4;
  }
  const vec4Count = spotSection + metaSection + tableVec4Count;
  if (vec4Count > IES_MAX_SHADING_VEC4S) fail(`IES 打包缓冲 ${vec4Count} 个 vec4 超出预算 ${IES_MAX_SHADING_VEC4S}`);
  const data = new Float32Array(vec4Count * 4);
  for (const [profileIndex, profile] of usedProfiles.entries()) {
    expandedTables.push(expandIesProfileTable(profile));
    const rows = profile.candela.length;
    const rowHalfStep = rows < 2 ? 0
      : profile.horizontalSymmetry === 2 ? 360 / (rows - 1) : 180 / (rows - 1);
    data.set([tableBases[profileIndex]!, rows,
      integerFloat(rowHalfStep, `profile ${profile.profileId} 行距`), profile.horizontalSymmetry],
    (spotSection + profileIndex) * 4);
    const expanded = expandedTables[profileIndex]!;
    // 展开数组按 361 浮点连续；缓冲内每行占 91 个 vec4（364 浮点，尾部 3 填 0），
    // 必须逐行拷贝，不能整块 set。
    for (let row = 0; row < profile.candela.length; row += 1) {
      data.set(expanded.subarray(row * IES_EXPANDED_COLUMNS, (row + 1) * IES_EXPANDED_COLUMNS),
        (tableBases[profileIndex]! + row * IES_TABLE_ROW_STRIDE_VEC4) * 4);
    }
  }
  // 参数节最后写：无 ies 的灯占位 -1（因子恒 1）；有 ies 的灯写真实参数与 meta 基址。
  for (let index = 0; index < spotSection; index += 1) data.set([-1, 0, 0, 0], index * 4);
  for (const entry of resolveIesSpots(spots, profiles)) {
    data.set([entry.profileIndex, entry.rotationHalfDeg, entry.scaleFactor,
      spotSection + entry.profileIndex], entry.index * 4);
  }
  return { data, vec4Count, spotCount: spots.length, profileCount: usedProfiles.length, tableBases };
}

/**
 * 与 WGSL deepSpotIesFactor 同式的 CPU 参考（读同一份打包字节）。
 * 输入必须是打包后的 f32 方向（spot storage buffer 的 directionOuterCos.xyz 与
 * 着色器实际使用的 surfaceToLight 分量），保证与 GPU 消费同一数值域。
 * 量化次序合同（与 iesSampling.intensityFactor 同序，round 输入全为非负，
 * JS ties-up 与 WGSL ties-away 在非负域一致）：
 *   θ = acos(clamp(dot(-s, l))) → 0.5° 网格；
 *   φ = atan2(dot(-s, pole), dot(-s, right)) − rotationDeg → floor 模 360 → 0.5° 网格；
 *   φ 按对称系数折叠 → 行 = round(gHalf/rowHalfStep) 夹紧；列 = θ 半度数直取。
 */
export function evaluateIesShadingFactor(packing: PackedIesShading, spotIndex: number,
  packedLightDirection: readonly [number, number, number],
  surfaceToLightDirection: readonly [number, number, number]): number {
  if (!Number.isInteger(spotIndex) || spotIndex < 0 || spotIndex >= packing.spotCount) return 1;
  const base = spotIndex * 4;
  const profileIndex = packing.data[base];
  if (profileIndex === undefined || profileIndex < 0) return 1;
  const metaBase = packing.data[base + 3]!;
  const tableBase = packing.data[metaBase * 4]!, rowCount = packing.data[metaBase * 4 + 1]!;
  const rowHalfStep = packing.data[metaBase * 4 + 2]!, symmetry = packing.data[metaBase * 4 + 3]!;
  const [lx, ly, lz] = packedLightDirection, [sx, sy, sz] = surfaceToLightDirection;
  const toSurfaceX = -sx, toSurfaceY = -sy, toSurfaceZ = -sz;
  const cosTheta = Math.min(Math.max(toSurfaceX * lx + toSurfaceY * ly + toSurfaceZ * lz, -1), 1);
  const thetaHalf = Math.min(Math.max(Math.round(Math.acos(cosTheta) * DEG_PER_RAD * 2), 0), 360);
  // right = normalize(cross(up, light))：up = (0,1,0)，光轴近 ±Y 时取 (1,0,0)。
  const useX = Math.abs(ly) > 0.999;
  const rawRightX = useX ? 0 : lz, rawRightY = useX ? -lz : 0, rawRightZ = useX ? ly : -lx;
  const rightLength = Math.hypot(rawRightX, rawRightY, rawRightZ);
  if (!(rightLength > 0)) return 1; // 非单位向量等退化输入：fail-safe 恒等。
  const rightX = rawRightX / rightLength, rightY = rawRightY / rightLength, rightZ = rawRightZ / rightLength;
  // pole = cross(light, right)。
  const poleX = ly * rightZ - lz * rightY, poleY = lz * rightX - lx * rightZ, poleZ = lx * rightY - ly * rightX;
  const azimuthX = toSurfaceX * rightX + toSurfaceY * rightY + toSurfaceZ * rightZ;
  const azimuthY = toSurfaceX * poleX + toSurfaceY * poleY + toSurfaceZ * poleZ;
  let phi = Math.atan2(azimuthY, azimuthX) * DEG_PER_RAD - packing.data[base + 1]! * 0.5;
  phi -= Math.floor(phi / 360) * 360;
  let phiHalf = Math.round(phi * 2);
  if (phiHalf >= 720) phiHalf = 0;
  let gHalf = phiHalf;
  if (symmetry === 2 && gHalf > 360) gHalf = 720 - gHalf;
  if (symmetry === 4) {
    gHalf %= 360;
    if (gHalf > 180) gHalf = 360 - gHalf;
  }
  const row = symmetry === 1 ? 0 : Math.min(Math.max(Math.round(gHalf / rowHalfStep), 0), rowCount - 1);
  const value = packing.data[(tableBase + row * IES_TABLE_ROW_STRIDE_VEC4) * 4 + thetaHalf];
  if (value === undefined) return 0;
  return value * packing.data[base + 2]!;
}
