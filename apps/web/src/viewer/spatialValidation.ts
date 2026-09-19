import * as THREE from "three";
import { closestPointsBetweenObjects, preciseIntersection } from "./analysis";

// P5 空间校验套件·切片一：批量规则校验引擎（用户 2026-09-19 批准的轻量切片）。
// 在 analysis.ts 的成对碰撞原语之上提供"规则×对象组→机器可读报告"的校验层：
// 硬碰撞、净空阈值、区域禁入。
// 切片二：区域禁入支持绕 Y 轴旋转（OBB 语义）；成对规则增加宽相预筛（世界包围球
// 排序扫描），候选对之外的原语调用被跳过。宽相只做"跳过"不改迭代顺序，因此
// 早退与最差对追踪和暴力遍历逐字段一致；包围球由三角不等式保证保守（相交对
// 必为候选），并以 1e-6 裕量抵御浮点边界。不引入新依赖、不新建平行系统。

export type SpatialRuleKind = "hard-collision" | "clearance" | "region-exclusion";

export interface SpatialValidationObject {
  id: string;
  root: THREE.Object3D;
  group: string;
}

export interface HardCollisionRule {
  kind: "hard-collision";
  id: string;
  label: string;
  groupA: string;
  groupB: string;
}

export interface ClearanceRule {
  kind: "clearance";
  id: string;
  label: string;
  groupA: string;
  groupB: string;
  minimumMetres: number;
}

/** 禁区包围盒；rotationYRad 缺省/0 = 轴对齐（向后兼容），非零 = 绕区域中心绕 Y 轴旋转的 OBB。 */
export interface RegionExclusionRule {
  kind: "region-exclusion";
  id: string;
  label: string;
  region: {
    center: [number, number, number];
    size: [number, number, number];
    rotationYRad?: number;
  };
  targets: string;
}

export type SpatialRule = HardCollisionRule | ClearanceRule | RegionExclusionRule;

export interface SpatialValidationFinding {
  ruleId: string;
  ruleLabel: string;
  kind: SpatialRuleKind;
  status: "pass" | "fail" | "skipped";
  objectIdA?: string;
  objectIdB?: string;
  distanceMetres?: number;
  marginMetres?: number;
  point?: [number, number, number];
  detail: string;
}

/** 宽相统计：候选对/全对，跨硬碰撞与净空规则聚合；纯区域规则不产生成对遍历。 */
export interface SpatialValidationBroadPhaseMeta {
  candidatePairs: number;
  totalPairs: number;
  /** 候选对/全对；<1 说明宽相剪枝生效，totalPairs 为 0 时记 0。 */
  candidatePairRatio: number;
}

export interface SpatialValidationReport {
  generatedAt: string;
  objectCount: number;
  ruleCount: number;
  findings: SpatialValidationFinding[];
  summary: {
    hardCollisionViolations: number;
    clearanceViolations: number;
    regionExclusionViolations: number;
    skippedRules: number;
  };
  meta: { broadPhase: SpatialValidationBroadPhaseMeta };
  passed: boolean;
  evidenceBoundary: string;
}

export function runSpatialValidation(objects: SpatialValidationObject[], rules: SpatialRule[]): SpatialValidationReport {
  const findings: SpatialValidationFinding[] = [];
  const broadPhase = { candidatePairs: 0, totalPairs: 0 };
  for (const rule of rules) {
    if (rule.kind === "hard-collision") {
      findings.push(checkHardCollision(objects, rule, broadPhase));
    } else if (rule.kind === "clearance") {
      findings.push(checkClearance(objects, rule, broadPhase));
    } else {
      findings.push(checkRegionExclusion(objects, rule));
    }
  }
  const count = (kind: SpatialRuleKind) => findings.filter((finding) => finding.kind === kind && finding.status === "fail").length;
  const summary = {
    hardCollisionViolations: count("hard-collision"),
    clearanceViolations: count("clearance"),
    regionExclusionViolations: count("region-exclusion"),
    skippedRules: findings.filter((finding) => finding.status === "skipped").length,
  };
  return {
    generatedAt: new Date().toISOString(),
    objectCount: objects.length,
    ruleCount: rules.length,
    findings,
    summary,
    meta: {
      broadPhase: {
        candidatePairs: broadPhase.candidatePairs,
        totalPairs: broadPhase.totalPairs,
        candidatePairRatio: broadPhase.totalPairs > 0 ? broadPhase.candidatePairs / broadPhase.totalPairs : 0
      }
    },
    passed: summary.hardCollisionViolations + summary.clearanceViolations + summary.regionExclusionViolations === 0,
    evidenceBoundary:
      "几何规则校验结果；不替代施工规范审查。区域禁入为包围盒语义：目标取世界包围盒，区域支持绕 Y 轴旋转（OBB），相交按精确分离轴判定；成对规则经包围球宽相预筛，结果与全量遍历一致"
  };
}

function objectsInGroup(objects: SpatialValidationObject[], group: string): SpatialValidationObject[] {
  return objects.filter((object) => object.group === group);
}

function checkHardCollision(objects: SpatialValidationObject[], rule: HardCollisionRule, broadPhase: BroadPhaseStats): SpatialValidationFinding {
  const groupA = objectsInGroup(objects, rule.groupA);
  const groupB = objectsInGroup(objects, rule.groupB);
  if (groupA.length === 0 || groupB.length === 0) {
    return skippedFinding(rule, `对象组缺失：${groupA.length === 0 ? rule.groupA : rule.groupB}`);
  }
  const candidates = pairwiseCandidatePairs(groupA, groupB, broadPhase);
  for (const [indexA, objectA] of groupA.entries()) {
    for (const [indexB, objectB] of groupB.entries()) {
      // 宽相只跳过候选对之外的原语调用，迭代顺序与暴力遍历完全一致 → 早退结果逐字段一致。
      if (!candidates.has(indexA * groupB.length + indexB)) continue;
      const intersection = preciseIntersection(objectA.root, objectB.root);
      if (!intersection) continue;
      return {
        ruleId: rule.id,
        ruleLabel: rule.label,
        kind: rule.kind,
        status: "fail",
        objectIdA: intersection.nodeIdA === "root" ? objectA.id : intersection.nodeIdA,
        objectIdB: intersection.nodeIdB === "root" ? objectB.id : intersection.nodeIdB,
        point: roundPoint(intersection.point),
        detail: `${objectA.id} 与 ${objectB.id} 存在实体相交`,
      };
    }
  }
  return { ruleId: rule.id, ruleLabel: rule.label, kind: rule.kind, status: "pass", detail: "未发现实体相交" };
}

function checkClearance(objects: SpatialValidationObject[], rule: ClearanceRule, broadPhase: BroadPhaseStats): SpatialValidationFinding {
  const groupA = objectsInGroup(objects, rule.groupA);
  const groupB = objectsInGroup(objects, rule.groupB);
  if (groupA.length === 0 || groupB.length === 0) {
    return skippedFinding(rule, `对象组缺失：${groupA.length === 0 ? rule.groupA : rule.groupB}`);
  }
  const candidates = pairwiseCandidatePairs(groupA, groupB, broadPhase);
  let worst: { objectA: SpatialValidationObject; objectB: SpatialValidationObject; distance: number; pointA: THREE.Vector3 } | undefined;
  for (const [indexA, objectA] of groupA.entries()) {
    for (const [indexB, objectB] of groupB.entries()) {
      if (!candidates.has(indexA * groupB.length + indexB)) continue;
      const closest = closestPointsBetweenObjects(objectA.root, objectB.root);
      if (!closest) continue;
      if (!worst || closest.distance < worst.distance) {
        worst = { objectA, objectB, distance: closest.distance, pointA: closest.pointA };
      }
      if (closest.distance <= 1e-7) break;
    }
  }
  if (!worst) {
    return skippedFinding(rule, "对象间无有效几何距离（空网格或不可见）");
  }
  const margin = Number((worst.distance - rule.minimumMetres).toFixed(6));
  return {
    ruleId: rule.id,
    ruleLabel: rule.label,
    kind: rule.kind,
    status: margin < 0 ? "fail" : "pass",
    objectIdA: worst.objectA.id,
    objectIdB: worst.objectB.id,
    distanceMetres: Number(worst.distance.toFixed(6)),
    marginMetres: margin,
    point: roundPoint(worst.pointA),
    detail: margin < 0
      ? `最小间距 ${worst.distance.toFixed(3)}m 低于要求 ${rule.minimumMetres}m（缺口 ${Math.abs(margin).toFixed(3)}m）`
      : `最小间距 ${worst.distance.toFixed(3)}m 满足要求 ${rule.minimumMetres}m`,
  };
}

function checkRegionExclusion(objects: SpatialValidationObject[], rule: RegionExclusionRule): SpatialValidationFinding {
  const targets = objectsInGroup(objects, rule.targets);
  if (targets.length === 0) {
    return skippedFinding(rule, `目标对象组缺失：${rule.targets}`);
  }
  const center = new THREE.Vector3(...rule.region.center);
  const size = new THREE.Vector3(...rule.region.size);
  const rotationYRad = rule.region.rotationYRad;
  // 缺省/0 走原轴对齐路径（与切片一逐字段一致）；非零旋转走 OBB 精确 SAT。
  const axisAlignedRegion =
    typeof rotationYRad === "number" && rotationYRad !== 0
      ? undefined
      : new THREE.Box3(
          center.clone().sub(size.clone().multiplyScalar(0.5)),
          center.clone().add(size.clone().multiplyScalar(0.5))
        );
  for (const target of targets) {
    target.root.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(target.root);
    if (box.isEmpty()) continue;
    if (axisAlignedRegion) {
      if (!box.intersectsBox(axisAlignedRegion)) continue;
      const overlap = box.clone().intersect(axisAlignedRegion);
      return {
        ruleId: rule.id,
        ruleLabel: rule.label,
        kind: rule.kind,
        status: "fail",
        objectIdA: target.id,
        point: roundPoint(overlap.isEmpty() ? box.getCenter(new THREE.Vector3()) : overlap.getCenter(new THREE.Vector3())),
        detail: `${target.id} 进入禁入区域（规则 ${rule.id}）`,
      };
    }
    const rotation = rotationYRad as number;
    if (!rotatedRegionIntersectsTargetBox(box, center, size, rotation)) continue;
    const evidencePoint = closestRegionPointToBoxCenter(box, center, size, rotation);
    return {
      ruleId: rule.id,
      ruleLabel: rule.label,
      kind: rule.kind,
      status: "fail",
      objectIdA: target.id,
      point: roundPoint(evidencePoint),
      detail: `${target.id} 进入禁入区域（规则 ${rule.id}，区域旋转 ${((rotation * 180) / Math.PI).toFixed(1)}°）`,
    };
  }
  return { ruleId: rule.id, ruleLabel: rule.label, kind: rule.kind, status: "pass", detail: "无目标进入禁区" };
}

function roundPoint(point: THREE.Vector3): [number, number, number] {
  return [Number(point.x.toFixed(6)), Number(point.y.toFixed(6)), Number(point.z.toFixed(6))];
}

function skippedFinding(rule: SpatialRule, reason: string): SpatialValidationFinding {
  return { ruleId: rule.id, ruleLabel: rule.label, kind: rule.kind, status: "skipped", detail: reason };
}

// ─── 宽相：世界包围球排序扫描（切片二）──────────────────────────────────────────

export interface WorldBoundingSphere {
  centerX: number;
  centerY: number;
  centerZ: number;
  /** 覆盖全部几何的包围球半径；空几何记 -1（与任何球都不构成候选，与暴力路径一致）。 */
  radius: number;
}

interface BroadPhaseStats {
  candidatePairs: number;
  totalPairs: number;
}

const BROAD_PHASE_EPSILON = 1e-6;

/** 目标的世界包围球（保守：完全包含其全部几何）。 */
export function worldBoundingSphere(root: THREE.Object3D): WorldBoundingSphere {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return { centerX: 0, centerY: 0, centerZ: 0, radius: -1 };
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  return { centerX: sphere.center.x, centerY: sphere.center.y, centerZ: sphere.center.z, radius: sphere.radius };
}

/**
 * 跨组宽相候选对，key = indexA * spheresB.length + indexB。
 * 保守性：若两目标几何相交，交点同时在两个世界包围盒内，而包围盒被包围球包含，
 * 由三角不等式 |cA-cB| ≤ |cA-p| + |p-cB| ≤ rA+rB，故相交对必为候选；
 * 再叠加 BROAD_PHASE_EPSILON 抵御浮点边界。变半径场景下前向 break 用全局最大半径
 * 兜底，保证任何潜在候选对都不会被提前截断。
 */
export function broadPhaseCandidatePairs(spheresA: WorldBoundingSphere[], spheresB: WorldBoundingSphere[]): Set<number> {
  const pairs = new Set<number>();
  if (spheresA.length === 0 || spheresB.length === 0) return pairs;
  const all = [...spheresA, ...spheresB];
  let maxRadius = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const sphere of all) {
    minX = Math.min(minX, sphere.centerX - sphere.radius);
    maxX = Math.max(maxX, sphere.centerX + sphere.radius);
    minY = Math.min(minY, sphere.centerY - sphere.radius);
    maxY = Math.max(maxY, sphere.centerY + sphere.radius);
    minZ = Math.min(minZ, sphere.centerZ - sphere.radius);
    maxZ = Math.max(maxZ, sphere.centerZ + sphere.radius);
    maxRadius = Math.max(maxRadius, sphere.radius);
  }
  const spanX = maxX - minX, spanY = maxY - minY, spanZ = maxZ - minZ;
  const axis = spanX >= spanY && spanX >= spanZ ? "x" : spanY >= spanZ ? "y" : "z";
  const entries = all.map((sphere, index) => ({
    isA: index < spheresA.length,
    groupIndex: index < spheresA.length ? index : index - spheresA.length,
    center: axis === "x" ? sphere.centerX : axis === "y" ? sphere.centerY : sphere.centerZ,
    x: sphere.centerX,
    y: sphere.centerY,
    z: sphere.centerZ,
    radius: sphere.radius
  }));
  entries.sort((left, right) => left.center - right.center);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    for (let j = i + 1; j < entries.length; j++) {
      const other = entries[j]!;
      const centerGap = other.center - entry.center;
      // 后续条目中心单调递增，超过 entry 半径 + 全局最大半径后必无候选，安全截断。
      if (centerGap > entry.radius + maxRadius + BROAD_PHASE_EPSILON) break;
      if (entry.isA === other.isA) continue;
      // 候选判定用完整三维球距（平方比较）：扫描轴的一维间距只是截断依据，
      // 不够成候选理由。空球（radius -1）与任何球半径和为负，直接排除。
      const radiusSum = entry.radius + other.radius + BROAD_PHASE_EPSILON;
      if (radiusSum < 0) continue;
      const dx = entry.x - other.x, dy = entry.y - other.y, dz = entry.z - other.z;
      if (dx * dx + dy * dy + dz * dz > radiusSum * radiusSum) continue;
      const indexA = entry.isA ? entry : other;
      const indexB = entry.isA ? other : entry;
      pairs.add(indexA.groupIndex * spheresB.length + indexB.groupIndex);
    }
  }
  return pairs;
}

/** 成对规则的宽相入口：建球、求候选、累计 meta 统计。 */
function pairwiseCandidatePairs(groupA: SpatialValidationObject[], groupB: SpatialValidationObject[], stats: BroadPhaseStats): Set<number> {
  const candidates = broadPhaseCandidatePairs(groupA.map((object) => worldBoundingSphere(object.root)), groupB.map((object) => worldBoundingSphere(object.root)));
  stats.candidatePairs += candidates.size;
  stats.totalPairs += groupA.length * groupB.length;
  return candidates;
}

// ─── 区域禁入 OBB：目标世界 AABB vs 绕 Y 旋转区域（切片二）──────────────────────

/**
 * 精确 6 轴分离轴判定：世界 X/Y/Z 三轴 + 区域两条水平轴（Y 轴共享）。
 * 刻意不做"把目标盒变换到区域局部系后重取 AABB"——旋转后的目标盒重轴对齐化会
 * 无界膨胀（细长目标旋转 45° 的包络远大于本体），产生大量假阳性；SAT 才是
 * "目标世界包围盒 vs 旋转区域"的精确盒相交。全程标量运算，规避向量原地突变。
 */
function rotatedRegionIntersectsTargetBox(targetBox: THREE.Box3, regionCenter: THREE.Vector3, regionSize: THREE.Vector3, rotationYRad: number): boolean {
  const halfX = regionSize.x / 2;
  const halfY = regionSize.y / 2;
  const halfZ = regionSize.z / 2;
  const boxCenter = targetBox.getCenter(new THREE.Vector3());
  const dx = boxCenter.x - regionCenter.x;
  const dy = boxCenter.y - regionCenter.y;
  const dz = boxCenter.z - regionCenter.z;
  const extentX = (targetBox.max.x - targetBox.min.x) / 2;
  const extentY = (targetBox.max.y - targetBox.min.y) / 2;
  const extentZ = (targetBox.max.z - targetBox.min.z) / 2;
  const cos = Math.cos(rotationYRad);
  const sin = Math.sin(rotationYRad);
  const absCos = Math.abs(cos);
  const absSin = Math.abs(sin);
  const axes = [
    // 世界 X 轴：区域投影 = halfX·|cos| + halfZ·|sin|
    { separation: Math.abs(dx), targetRadius: extentX, regionRadius: halfX * absCos + halfZ * absSin },
    { separation: Math.abs(dy), targetRadius: extentY, regionRadius: halfY },
    // 世界 Z 轴：区域投影 = halfX·|sin| + halfZ·|cos|
    { separation: Math.abs(dz), targetRadius: extentZ, regionRadius: halfX * absSin + halfZ * absCos },
    // 区域局部 X 轴（世界方向 (cos,0,-sin)）：区域投影 = halfX
    { separation: Math.abs(dx * cos - dz * sin), targetRadius: extentX * absCos + extentZ * absSin, regionRadius: halfX },
    // 区域局部 Z 轴（世界方向 (sin,0,cos)）：区域投影 = halfZ
    { separation: Math.abs(dx * sin + dz * cos), targetRadius: extentX * absSin + extentZ * absCos, regionRadius: halfZ }
  ];
  return axes.every((axis) => axis.separation <= axis.targetRadius + axis.regionRadius);
}

/** 证据点：目标盒中心在区域局部系的 clamp 点转回世界系 = 区域 OBB 上离目标中心最近的点。 */
function closestRegionPointToBoxCenter(targetBox: THREE.Box3, regionCenter: THREE.Vector3, regionSize: THREE.Vector3, rotationYRad: number): THREE.Vector3 {
  const boxCenter = targetBox.getCenter(new THREE.Vector3());
  const dx = boxCenter.x - regionCenter.x;
  const dy = boxCenter.y - regionCenter.y;
  const dz = boxCenter.z - regionCenter.z;
  const cos = Math.cos(rotationYRad);
  const sin = Math.sin(rotationYRad);
  // 世界 → 区域局部：R(-θ)，v_local.x = cos·dx - sin·dz，v_local.z = sin·dx + cos·dz
  const localX = clamp(dx * cos - dz * sin, -(regionSize.x / 2), regionSize.x / 2);
  const localY = clamp(dy, -(regionSize.y / 2), regionSize.y / 2);
  const localZ = clamp(dx * sin + dz * cos, -(regionSize.z / 2), regionSize.z / 2);
  // 区域局部 → 世界：R(θ)
  return new THREE.Vector3(
    regionCenter.x + cos * localX + sin * localZ,
    regionCenter.y + localY,
    regionCenter.z - sin * localX + cos * localZ
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
