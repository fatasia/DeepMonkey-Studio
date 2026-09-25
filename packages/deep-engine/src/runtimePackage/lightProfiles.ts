// E02 IES 光域网集成（设计 docs/development.md §2/§4）：
// 运行包 lightProfiles 资源节的生产者（量化）与消费者（验证）。
// 量化纪律同 r3-state-frame-v1：角度 0.5° 网格、坎德拉/流明 1e-3 网格、-0→+0。
// f32 ULP 论证：跨端消费合同是 intensityFactor = candela/maxCandela ∈ [0,1]
//（f64 双端位一致）；绝对坎德拉 v > 8388 时 f32 半 ULP v·5.96e-8 已越过 5e-4
// 量化半宽，绝对值不承诺 f32 round-trip——消费端必须吃归一化因子，golden 以
// binary64 canonical 哈希互钉（runtimeContentSha256 双端已互钉）。

import { iesTotalLuminousFlux, type IesProfile } from "../lighting/iesProfile.js";
import { array, record, requireValue, string } from "./primitives.js";
import type { RuntimeJson } from "./types.js";
import type { RuntimeLightIes, RuntimeLightProfile } from "./environmentTypes.js";

export const IES_ANGLE_STEP_DEG = 0.5;
/** 坎德拉合同上限（极端探照灯量级）；×1000 后远小于 2^53，f64 精确。 */
export const IES_MAX_CANDELA = 1e6;
export const IES_MAX_TOTAL_LUMENS = 1e7;
export const IES_MAX_ROTATION_DEG = 360;
export const IES_MAX_SCALE_FACTOR = 10;
/** 单 profile 预算：181×361 全网格极限（对称 2 的 0.5° 行距）之上再留裕量。 */
export const IES_MAX_PROFILE_ROWS = 512;
const CANDELA_QUANTUM = 0.001;
const GRID_TOLERANCE = 1e-6;

export function isOnIesAngleGrid(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value * 2 - Math.round(value * 2)) <= GRID_TOLERANCE;
}

function normalizeNegativeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** 1e-3 量化：round(x/quantum)×quantum。合同输入域为非负（负值先行拒绝），
 * 因此 JS Math.round 与 Rust f64::round 的半整数方向差异不会出现。 */
function quantizeCandela(value: number): number {
  return normalizeNegativeZero(Math.round(value / CANDELA_QUANTUM) * CANDELA_QUANTUM);
}

/**
 * 生产者：解析器 IesProfile → 量化运行时表。
 * 合同性拒绝（列名报错，不静默降级为全向灯）：
 * - photometricType 2/3（B/A 型光度，测量几何与 C 型不同）；
 * - 垂直角不在 0.5° 网格、出现负值或重复；
 * - 水平扫描不是单行（旋转对称）或 0–90/0–180 等距扫描——非对称 φ 分布
 *   无法在无 horizontalAngles 字段的表合同中如实表达，如实拒绝。
 * 坎德拉按 1e-3 量化（有损 ≤5e-4 cd），角度只验证不重采样。
 */
export function quantizeIesLightProfile(profileId: string, parsed: IesProfile): RuntimeLightProfile {
  const fail = (message: string): never => {
    throw new Error(`ies profile ${profileId}: ${message}`);
  };
  if (parsed.photometricType !== 1) {
    fail(`photometricType ${parsed.photometricType}（B/A 型光度）按合同拒绝，仅支持 C 型（1）；不得静默降级`);
  }
  const verticalAngles = parsed.verticalAngles.map((angle) => {
    if (angle < 0 || angle > 180) fail(`垂直角 ${angle} 超出 [0,180]`);
    if (!isOnIesAngleGrid(angle)) fail(`垂直角 ${angle} 不在 0.5° 网格上，合同要求先在源数据网格化`);
    return normalizeNegativeZero(angle);
  });
  for (let index = 1; index < verticalAngles.length; index += 1) {
    if (!(verticalAngles[index]! > verticalAngles[index - 1]!)) {
      fail(`垂直角必须严格升序：${verticalAngles[index - 1]} → ${verticalAngles[index]}`);
    }
  }
  const rows = parsed.candela.length;
  const horizontal = parsed.horizontalAngles;
  const spanDeg = (horizontal[horizontal.length - 1] ?? 0) - (horizontal[0] ?? 0);
  // 多行合同：扫描必须恰好从 0° 起、止于 90°/180°（行角 i×span/(行数−1) 可推导）。
  // 任意起点（如 90–270）会整体错位 φ 标注，按合同拒绝，不做静默重标。
  const startsAtZero = Math.abs(horizontal[0] ?? 1) < GRID_TOLERANCE;
  const isUniformSweep = rows === horizontal.length && startsAtZero && isUniformHorizontalSweep(horizontal);
  const symmetry: 1 | 2 | 4 =
    rows === 1 ? 1 // 单行=全周旋转对称（解析器同语义）。
    : isUniformSweep && Math.abs(spanDeg - 90) < GRID_TOLERANCE ? 4
    : isUniformSweep && Math.abs(spanDeg - 180) < GRID_TOLERANCE ? 2
    : (fail(`水平扫描 ${horizontal[0]}–${horizontal[horizontal.length - 1]}°（${rows} 行）非旋转对称且非自 0° 起的 0–90/0–180 等距扫描，非对称 φ 分布按合同拒绝，不静默降级`), 2);
  // multiplier × ballastFactor 折叠进存储坎德拉，使表最大值/采样/totalLumens
  // 描述同一物理分布（iesTotalLuminousFlux 对原始表乘同样增益，二者自洽）。
  const gain = parsed.multiplier * (parsed.ballastFactor || 1);
  if (!Number.isFinite(gain) || gain < 0) fail(`multiplier×ballastFactor = ${gain} 非法（须为非负有限值）`);
  const candela = parsed.candela.map((row) => {
    if (row.length !== verticalAngles.length) fail(`坎德拉行宽 ${row.length} ≠ 垂直角数 ${verticalAngles.length}`);
    return row.map((value) => {
      const scaled = value * gain;
      if (!Number.isFinite(scaled) || scaled < 0) fail(`坎德拉出现负值或非有限值 ${scaled}`);
      if (scaled > IES_MAX_CANDELA) fail(`坎德拉 ${scaled} 超出合同上限 ${IES_MAX_CANDELA}`);
      return quantizeCandela(scaled);
    });
  });
  const totalLumens = quantizeCandela(Math.max(0, iesTotalLuminousFlux(parsed)));
  if (totalLumens > IES_MAX_TOTAL_LUMENS) {
    fail(`总光通量 ${totalLumens} 超出合同上限 ${IES_MAX_TOTAL_LUMENS}`);
  }
  const format = parsed.format === "LM-63-2002" ? "LM-63-2002" : "LM-63-1995";
  return { profileId, format, verticalAngles, candela, horizontalSymmetry: symmetry, totalLumens };
}

function isUniformHorizontalSweep(angles: number[]): boolean {
  if (angles.length < 2) return false;
  const step = ((angles[angles.length - 1] ?? 0) - (angles[0] ?? 0)) / (angles.length - 1);
  return angles.every((angle, index) => Math.abs(angle - ((angles[0] ?? 0) + index * step)) <= GRID_TOLERANCE);
}

/**
 * 消费者：验证载荷中的 lightProfiles 节（白名单字段 + 量化网格 + 形状），
 * 并强制 ies.profileId 引用闭合。所有拒绝都带载荷路径（列名可定位）。
 */
export function validateLightingIes(lighting: Record<string, unknown>, path: string): void {
  const locals = lighting.localLights;
  const profiles = lighting.lightProfiles;
  if (profiles === undefined) {
    // 未声明 lightProfiles 时任何 ies 引用都无法闭合。
    const referenced = referencedProfileIds(locals, path);
    if (referenced.length > 0) {
      requireValue(false, path, `ies 引用了未声明的 profileId：${referenced.join(", ")}（缺 lightProfiles 节）`);
    }
    return;
  }
  const table = new Map<string, string>();
  const profileList = array(profiles, `${path}.lightProfiles`, IES_MAX_PROFILE_ROWS);
  for (const [index, candidate] of profileList.entries()) {
    const profilePath = `${path}.lightProfiles[${index}]`;
    const entry = record(candidate, profilePath);
    const profileId = string(entry.profileId, `${profilePath}.profileId`);
    requireValue(profileId.length > 0 && profileId.length <= 128, `${profilePath}.profileId`, "Profile id must be 1..128 characters.");
    requireValue(!table.has(profileId), profilePath, `Duplicate profileId: ${profileId}.`);
    table.set(profileId, profilePath);
    validateLightProfileShape(entry, profilePath);
  }
  for (const profileId of referencedProfileIds(locals, path)) {
    requireValue(table.has(profileId), `${path}.localLights`, `ies 引用了未声明的 profileId：${profileId}；已声明：${[...table.keys()].join(", ") || "（空）"}`);
  }
}

function referencedProfileIds(locals: unknown, path: string): string[] {
  if (locals === undefined) return [];
  const ids: string[] = [];
  const lights = array(locals, `${path}.localLights`);
  for (const [index, light] of lights.entries()) {
    const ies = record(light, `${path}.localLights[${index}]`).ies;
    if (ies !== undefined) ids.push(string(record(ies, `${path}.localLights[${index}].ies`).profileId, `${path}.localLights[${index}].ies.profileId`));
  }
  return ids;
}

/** 单个 profile 的结构/量化网格验证（不含引用闭合）。 */
export function validateLightProfileShape(entry: Record<string, unknown>, path: string): void {
  const allowed = ["profileId", "format", "verticalAngles", "candela", "horizontalSymmetry", "totalLumens"];
  for (const key of Object.keys(entry)) requireValue(allowed.includes(key), `${path}.${key}`, "Unknown field.");
  const format = string(entry.format, `${path}.format`);
  requireValue(format === "LM-63-1995" || format === "LM-63-2002", `${path}.format`, "Unsupported IES format.");
  const symmetry = entry.horizontalSymmetry;
  requireValue(symmetry === 1 || symmetry === 2 || symmetry === 4, `${path}.horizontalSymmetry`, "horizontalSymmetry must be 1, 2 or 4.");
  const vertical = array(entry.verticalAngles, `${path}.verticalAngles`, 512).map((value, index) => {
    const anglePath = `${path}.verticalAngles[${index}]`;
    requireValue(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 180, anglePath, "Vertical angle out of [0,180].");
    requireValue(isOnIesAngleGrid(value), anglePath, `Angle ${value} is off the 0.5° grid.`);
    return normalizeNegativeZero(value);
  });
  requireValue(vertical.length >= 1, `${path}.verticalAngles`, "At least one vertical angle is required.");
  for (let index = 1; index < vertical.length; index += 1) {
    requireValue(vertical[index]! > vertical[index - 1]!, `${path}.verticalAngles[${index}]`, "Vertical angles must be strictly ascending.");
  }
  const rows = array(entry.candela, `${path}.candela`, IES_MAX_PROFILE_ROWS);
  const symmetryValue = symmetry as number;
  if (symmetryValue === 1) {
    requireValue(rows.length === 1, `${path}.candela`, "horizontalSymmetry=1 requires exactly one row (rotationally symmetric).");
  } else {
    const spanDeg = symmetryValue === 2 ? 180 : 90;
    requireValue(rows.length >= 2 && (spanDeg * 2) % (rows.length - 1) === 0,
      `${path}.candela`, `horizontalSymmetry=${symmetryValue} requires rows evenly covering [0,${spanDeg}] with a 0.5°-grid row step.`);
  }
  let maxCandela = 0;
  for (const [rowIndex, rowValue] of rows.entries()) {
    const row = array(rowValue, `${path}.candela[${rowIndex}]`, 512);
    requireValue(row.length === vertical.length, `${path}.candela[${rowIndex}]`, "Candela row width must match the vertical angle count.");
    for (const [column, value] of row.entries()) {
      const cellPath = `${path}.candela[${rowIndex}][${column}]`;
      requireValue(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= IES_MAX_CANDELA, cellPath, "Candela value out of contract range.");
      requireValue(Math.abs(value * 1000 - Math.round(value * 1000)) <= GRID_TOLERANCE, cellPath, `Candela ${value} is off the 1e-3 quantization grid.`);
      maxCandela = Math.max(maxCandela, normalizeNegativeZero(value));
    }
  }
  const totalLumens = entry.totalLumens;
  requireValue(typeof totalLumens === "number" && Number.isFinite(totalLumens) && totalLumens >= 0 && totalLumens <= IES_MAX_TOTAL_LUMENS,
    `${path}.totalLumens`, "Total lumens out of contract range.");
  requireValue(Math.abs(totalLumens * 1000 - Math.round(totalLumens * 1000)) <= GRID_TOLERANCE, `${path}.totalLumens`, "Total lumens is off the 1e-3 quantization grid.");
}

/** 灯的 ies 引用形状验证（无 lightProfiles 上下文，闭合在 validateLightingIes）。 */
export function validateLightIes(ies: unknown, path: string): RuntimeLightIes {
  const entry = record(ies, path);
  for (const key of Object.keys(entry)) {
    requireValue(key === "profileId" || key === "rotationDeg" || key === "scaleFactor", `${path}.${key}`, "Unknown field.");
  }
  const profileId = string(entry.profileId, `${path}.profileId`);
  requireValue(profileId.length > 0 && profileId.length <= 128, `${path}.profileId`, "Profile id must be 1..128 characters.");
  const rotation = entry.rotationDeg;
  if (rotation !== undefined) {
    requireValue(typeof rotation === "number" && Number.isFinite(rotation) && rotation >= 0 && rotation < IES_MAX_ROTATION_DEG && isOnIesAngleGrid(rotation),
      `${path}.rotationDeg`, "rotationDeg must sit on the 0.5° grid inside [0,360).");
  }
  const scale = entry.scaleFactor;
  if (scale !== undefined) {
    requireValue(typeof scale === "number" && Number.isFinite(scale) && scale >= 0 && scale <= IES_MAX_SCALE_FACTOR,
      `${path}.scaleFactor`, "scaleFactor must be within [0,10].");
  }
  return entry as unknown as RuntimeLightIes;
}

/** 供哈希/证据使用：表的 canonical 快照（snapshotJson 语义由调用方包裹）。 */
export function lightProfileToJson(profile: RuntimeLightProfile): RuntimeJson {
  return {
    profileId: profile.profileId,
    format: profile.format,
    verticalAngles: [...profile.verticalAngles],
    candela: profile.candela.map((row) => [...row]),
    horizontalSymmetry: profile.horizontalSymmetry,
    totalLumens: profile.totalLumens,
  };
}
