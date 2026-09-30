/**
 * A2 SDF 碰撞 profile 对照合同:Rapier 凸包真值 vs SDF 查询,逐字段 fail-closed。
 * (按职责从 sdfCollisionProfile.ts 拆分;总合同语义见彼处头注。)
 *
 * 分区规则(与 native 对照 tests/sdf_collision_profile_truth.rs 同文):
 * - hull > 0 且最近凸包面共享 → outside-agreement(距离上界 + 近表面法线对齐);
 * - hull ≥ 0 且最近凸包面为凸包独有面 → outside-ghost-adjacent(anti-leak 上界);
 * - hull < 0 ≤ sdf → ghost(凹域,幽灵厚度证据 + 分类);
 * - sdf < 0 ≤ hull → leak(SDF 比凸包更「实」——构建回归信号,签名级违规);
 * - 双负 → inside-agreement(分类逐字段验收)。
 * hull == 0 的边界退化行(真值吸附到共享面)若 sdf < 0 属「点在形状内部、恰在
 * 凸包面上」,由 outside-agreement 分支按采样上界验收,不是 leak。
 */
import type { SdfGrid } from "./sdfGrid.js";
import type { SdfCollisionProfile } from "./sdfCollisionProfile.js";

/**
 * 一行 Rapier 凸包真值。hullDistance 为 solid 口径有符号距离(外部 ≥ 0,内部 < 0);
 * hullNormal 为最近面单位法线、指向距离增大方向(外部朝外/内部朝内);hull 命中点
 * 由 native 对照侧另行记录(本合同只消费距离/法线/面共享性)。
 * hullFeatureIsGhostFace:最近凸包面是否为「凸包独有面」(凹源几何的对角切面及其
 * 上下的端面楔形区,该面不是源几何表面)—— 由真值提供方按投影特征判定,合同不猜。
 */
export interface SdfProfileTruthRow {
  readonly point: readonly [number, number, number];
  readonly hullDistance: number;
  readonly hullNormal: readonly [number, number, number];
  readonly hullFeatureIsGhostFace: boolean;
}

/**
 * 误差预算(全部显式,不接受隐式默认):
 * - maxOutsideDistanceError:双方都在源几何外部的区域,|sdf − hull| 上界。
 *   推导值 = grid.maxSamplingError = (√3/2)·cellSize(体素采样误差上界);
 * - minNormalAlignment:近表面带内 dot(unit(gradient), hullNormal) 下界(cos 值);
 * - nearSurfaceBand:法线对拍生效的 |sdf| 带(米);
 * - maxGhostThickness:凹域幽灵厚度上界(几何推导,如凹口切角深度 + 采样误差)。
 */
export interface SdfProfileBudget {
  readonly maxOutsideDistanceError: number;
  readonly minNormalAlignment: number;
  readonly nearSurfaceBand: number;
  readonly maxGhostThickness: number;
}

/** 从 grid 派生默认距离上界(其余三项必须由测量/几何推导显式给出)。 */
export function deriveSdfProfileDistanceBound(grid: SdfGrid): number {
  return grid.maxSamplingError;
}

export type SdfProfileRegion =
  | "outside-agreement"      // 双方外部,最近凸包面 = 共享面:距离+法线+分类逐字段验收
  | "outside-ghost-adjacent" // 外部但最近凸包面 = 幽灵面:anti-leak + 厚度证据
  | "ghost"                  // 凸包内部、SDF 外部(凹域,SDF 的价值所在):厚度证据 + 分类
  | "inside-agreement"       // 双方内部:分类逐字段验收
  | "leak";                  // sdf < 0 < hull:SDF 比凸包更「实」——构建回归信号,一律违规

export interface SdfProfileComparisonRow {
  readonly index: number;
  readonly point: readonly [number, number, number];
  readonly region: SdfProfileRegion;
  readonly sdfDistance: number;
  readonly hullDistance: number;
  readonly outsideDistanceError: number | null;
  readonly ghostThickness: number | null;
  readonly normalAlignment: number | null;
  readonly penetrating: boolean;
}

export interface SdfProfileViolation {
  readonly index: number;
  readonly field: "domain" | "distance" | "normal" | "leak" | "ghost-bound" | "classification";
  readonly detail: string;
}

export interface SdfProfileComparisonTable {
  readonly rows: readonly SdfProfileComparisonRow[];
  readonly violations: readonly SdfProfileViolation[];
}

const REGION_FIELD_ORDER: readonly SdfProfileRegion[] =
  ["outside-agreement", "outside-ghost-adjacent", "ghost", "inside-agreement", "leak"];

/**
 * 收集对照表(除签名级 leak/域外外不判预算):逐行判区、逐字段计算实测证据。
 * 预算判定(上界比对)统一在 validateSdfProfileAgainstRapierHull。
 */
export function collectSdfProfileComparison(
  profile: SdfCollisionProfile, rows: readonly SdfProfileTruthRow[],
): SdfProfileComparisonTable {
  const table: SdfProfileComparisonRow[] = [];
  const violations: SdfProfileViolation[] = [];
  rows.forEach((row, index) => {
    const sample = profile.sample(row.point);
    if (!sample.inDomain) {
      violations.push({ index, field: "domain", detail: "真值点落在 SDF 域外(fail-closed,不得静默)" });
      return;
    }
    if (!row.hullNormal.every(Number.isFinite) || !Number.isFinite(row.hullDistance)) {
      violations.push({ index, field: "domain", detail: "真值行含非有限值" });
      return;
    }
    const penetrating = sample.distance < -profile.contactSkin;
    let region: SdfProfileRegion;
    let outsideDistanceError: number | null = null;
    let ghostThickness: number | null = null;
    let normalAlignment: number | null = null;
    if (row.hullDistance > 0 && sample.distance < 0) {
      region = "leak";
      violations.push({
        index, field: "leak",
        detail: `SDF 判内部(${sample.distance})而凸包判外部(${row.hullDistance}):SDF 比凸包更实,构建回归`,
      });
    } else if (row.hullDistance >= 0 && !row.hullFeatureIsGhostFace) {
      region = "outside-agreement";
      outsideDistanceError = Math.abs(sample.distance - row.hullDistance);
      const length = Math.hypot(...sample.gradient);
      if (length > 0) {
        normalAlignment = (sample.gradient[0]! * row.hullNormal[0]!
          + sample.gradient[1]! * row.hullNormal[1]!
          + sample.gradient[2]! * row.hullNormal[2]!) / length;
      }
    } else if (row.hullDistance >= 0) {
      region = "outside-ghost-adjacent";
    } else if (sample.distance >= 0) {
      region = "ghost";
      ghostThickness = sample.distance - row.hullDistance;
    } else {
      region = "inside-agreement";
      if (!penetrating) {
        violations.push({ index, field: "classification", detail: "双内部区 profile 未判 penetrating" });
      }
    }
    table.push({
      index, point: row.point, region, sdfDistance: sample.distance, hullDistance: row.hullDistance,
      outsideDistanceError, ghostThickness, normalAlignment, penetrating,
    });
  });
  table.sort((a, b) => REGION_FIELD_ORDER.indexOf(a.region) - REGION_FIELD_ORDER.indexOf(b.region));
  return { rows: table, violations };
}

/**
 * 逐字段 fail-closed 验收:任何违规抛 Error(带行号+字段+实测/上界),绝不静默;
 * 通过时返回对照表(误差/幽灵厚度/法线对齐的实测证据,供报告量化)。
 * 预算生效范围:距离上界与法线对齐只在 outside-agreement 生效;法线只看
 * nearSurfaceBand 内的行(远场梯度是等距面法线,不与凸包面对拍);
 * anti-leak 上界在 outside-ghost-adjacent 生效;幽灵厚度上界在 ghost 生效。
 */
export function validateSdfProfileAgainstRapierHull(
  profile: SdfCollisionProfile, rows: readonly SdfProfileTruthRow[], budget: SdfProfileBudget,
): SdfProfileComparisonTable {
  const collected = collectSdfProfileComparison(profile, rows);
  const table = collected.rows;
  const violations = [...collected.violations];
  for (const row of table) {
    if (row.region === "outside-agreement" && row.outsideDistanceError !== null
      && row.outsideDistanceError > budget.maxOutsideDistanceError) {
      violations.push({
        index: row.index, field: "distance",
        detail: `外部一致区距离误差 ${row.outsideDistanceError} 超预算 ${budget.maxOutsideDistanceError}`,
      });
    }
    if (row.region === "outside-agreement" && row.normalAlignment !== null
      && Math.abs(row.sdfDistance) <= budget.nearSurfaceBand
      && row.normalAlignment < budget.minNormalAlignment) {
      violations.push({
        index: row.index, field: "normal",
        detail: `近表面带法线对齐 ${row.normalAlignment} 低于预算 ${budget.minNormalAlignment}`,
      });
    }
    if (row.region === "outside-ghost-adjacent"
      && row.sdfDistance < row.hullDistance - budget.maxOutsideDistanceError) {
      violations.push({
        index: row.index, field: "leak",
        detail: `幽灵面邻接区 SDF(${row.sdfDistance})低于凸包(${row.hullDistance})超出采样误差,疑似泄漏`,
      });
    }
    if (row.region === "ghost" && row.ghostThickness !== null) {
      if (row.ghostThickness <= 0) {
        violations.push({ index: row.index, field: "ghost-bound", detail: `凹域幽灵厚度必须为正,实测 ${row.ghostThickness}` });
      } else if (row.ghostThickness > budget.maxGhostThickness) {
        violations.push({
          index: row.index, field: "ghost-bound",
          detail: `幽灵厚度 ${row.ghostThickness} 超几何上界 ${budget.maxGhostThickness}`,
        });
      }
    }
  }
  if (violations.length) {
    const first = violations[0]!;
    throw new Error(
      `SDF 碰撞 profile 对照失败(fail-closed,共 ${violations.length} 项;首项行 ${first.index} 字段 ${first.field}: ${first.detail})`,
    );
  }
  return { rows: table, violations };
}
