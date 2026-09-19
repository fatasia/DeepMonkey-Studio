// E02 IES 光域网集成（设计 §3.1）：intensityFactor(θ,φ) 的唯一权威语义。
// TS 与 Rust（deep-engine-native/src/runtime_package/light_profiles.rs）各有一份
// 逐位一致的实现，由 fixtures/ies/e02-golden.json 互钉；修改本文件必须同步
// Rust 侧并重新生成 golden。
//
// 采样顺序合同（双端同序，任何重排都可能破坏跨端确定性）：
//   1. θ = clamp(θ, 0, 180)；φ = φ − rotationDeg
//   2. φ = φ mod 360（负值 +360）
//   3. θ、φ 各自 round(x×2)/2 量化到 0.5° 网格——吸收两端从方向向量算角的
//      f32/f64 ULP 差异；φ ≥ 360 → 0
//   4. φ 按对称系数折叠（LM-63 镜像语义）：2 → I(φ)=I(360−φ)，g∈(0,180]；
//      4 → 周期 180 + 镜像（g=φ mod 180，>90 折回），g∈[0,90]；
//      1 → 行 0（旋转对称，θ 剖面如实、不做镜像外推）
//   5. 行索引 = round((g×2)/行距半度数) 夹紧（恰在中点时半整数向上取，双端同约）；
//      列索引 = 垂直角最近邻（并列取低索引）；θ 超出实测角域 [首角,末角] → 0
//      （合同性不外推：半光度文件 0–90 的表不得把 nadir 强度外推到天顶）
//   6. factor = candela[行][列] / maxCandela × scaleFactor（maxCandela=0 → 0）
// round 半整数差异（JS 向 +∞ / Rust 远离零）不会出现：所有 round 输入非负。
// 非有限输入 fail-safe 返回 0（无光），不抛错——着色热路径禁异常。

import type { RuntimeLightProfile } from "../runtimePackage/environmentTypes.js";

export interface IesSamplingTable {
  readonly verticalAngles: readonly number[];
  readonly candela: readonly (readonly number[])[];
  readonly horizontalSymmetry: 1 | 2 | 4;
  /** 表内最大坎德拉（f64 归约，双端一致）；0 表示全黑表。 */
  readonly maxCandela: number;
  /** φ 行距的半度数（整数语义：对称 2 → 360/(行数−1)，4 → 180/(行数−1)，1 → 0）。 */
  readonly rowHalfStep: number;
}

export function iesMaxCandela(profile: Pick<RuntimeLightProfile, "candela">): number {
  let max = 0;
  for (const row of profile.candela) for (const value of row) max = Math.max(max, value === 0 ? 0 : value);
  return max;
}

export function prepareIesSampling(profile: RuntimeLightProfile): IesSamplingTable {
  const rows = profile.candela.length;
  const rowHalfStep = profile.horizontalSymmetry === 1 || rows < 2 ? 0
    : profile.horizontalSymmetry === 2 ? 360 / (rows - 1) : 180 / (rows - 1);
  return { verticalAngles: profile.verticalAngles, candela: profile.candela, horizontalSymmetry: profile.horizontalSymmetry, maxCandela: iesMaxCandela(profile), rowHalfStep };
}

export function intensityFactor(
  table: IesSamplingTable,
  thetaDeg: number,
  phiDeg: number,
  rotationDeg = 0,
  scaleFactor = 1,
): number {
  if (!Number.isFinite(thetaDeg) || !Number.isFinite(phiDeg) || !Number.isFinite(rotationDeg) || !Number.isFinite(scaleFactor)) return 0;
  if (table.maxCandela <= 0 || table.candela.length === 0 || table.verticalAngles.length === 0) return 0;
  const theta = Math.min(Math.max(thetaDeg, 0), 180);
  let phi = (phiDeg - rotationDeg) % 360;
  if (phi < 0) phi += 360;
  const thetaGrid = Math.round(theta * 2) / 2;
  let phiGrid = Math.round(phi * 2) / 2;
  if (phiGrid >= 360) phiGrid = 0;
  let g = phiGrid;
  if (table.horizontalSymmetry === 2) {
    if (g > 180) g = 360 - g; // 镜像半周：φ=180 保持末行，不折回第 0 行。
  } else if (table.horizontalSymmetry === 4) {
    g %= 180;
    if (g > 90) g = 180 - g;
  }
  const row = table.horizontalSymmetry === 1 ? 0
    : Math.min(Math.max(Math.round((g * 2) / table.rowHalfStep), 0), table.candela.length - 1);
  const column = nearestVerticalIndex(table.verticalAngles, thetaGrid);
  if (column < 0) return 0; // θ 超出实测角域：不外推，如实返回无光。
  const candela = table.candela[row]?.[column];
  if (candela === undefined) return 0;
  return (candela / table.maxCandela) * scaleFactor;
}

/** 垂直角最近邻：verticalAngles 严格升序；并列取低索引；
 * θ 在实测角域之外返回 -1（调用方合同性返回 0，不外推）。 */
function nearestVerticalIndex(angles: readonly number[], theta: number): number {
  if (angles.length === 1) return theta === (angles[0] ?? NaN) ? 0 : -1;
  let low = 0;
  let high = angles.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >>> 1;
    if ((angles[mid] ?? 0) >= theta) high = mid; else low = mid;
  }
  const lower = angles[low] ?? 0;
  const upper = angles[high] ?? 0;
  if (theta < lower || theta > upper) return -1;
  if (theta <= lower) return low;
  if (theta >= upper) return high;
  return theta - lower <= upper - theta ? low : high;
}
