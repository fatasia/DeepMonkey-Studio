import * as THREE from "three";
import { closestPointsBetweenObjects, preciseIntersection } from "./analysis";

// P5 空间校验套件·切片一：批量规则校验引擎（用户 2026-09-19 批准的轻量切片）。
// 在 analysis.ts 的成对碰撞原语之上提供"规则×对象组→机器可读报告"的校验层：
// 硬碰撞、净空阈值、区域禁入。放大到全园区规模时由 D01 空间索引做批量加速，
// 本切片不引入新依赖、不新建平行系统。

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

/** 世界轴对齐禁区；区域旋转需求留待切片二（先以包围盒语义诚实交付）。 */
export interface RegionExclusionRule {
  kind: "region-exclusion";
  id: string;
  label: string;
  region: { center: [number, number, number]; size: [number, number, number] };
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
  passed: boolean;
  evidenceBoundary: "几何规则校验结果；不替代施工规范审查，区域仅支持轴对齐包围盒语义";
}

export function runSpatialValidation(objects: SpatialValidationObject[], rules: SpatialRule[]): SpatialValidationReport {
  const findings: SpatialValidationFinding[] = [];
  for (const rule of rules) {
    if (rule.kind === "hard-collision") {
      findings.push(checkHardCollision(objects, rule));
    } else if (rule.kind === "clearance") {
      findings.push(checkClearance(objects, rule));
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
    passed: summary.hardCollisionViolations + summary.clearanceViolations + summary.regionExclusionViolations === 0,
    evidenceBoundary: "几何规则校验结果；不替代施工规范审查，区域仅支持轴对齐包围盒语义",
  };
}

function objectsInGroup(objects: SpatialValidationObject[], group: string): SpatialValidationObject[] {
  return objects.filter((object) => object.group === group);
}

function checkHardCollision(objects: SpatialValidationObject[], rule: HardCollisionRule): SpatialValidationFinding {
  const groupA = objectsInGroup(objects, rule.groupA);
  const groupB = objectsInGroup(objects, rule.groupB);
  if (groupA.length === 0 || groupB.length === 0) {
    return skippedFinding(rule, `对象组缺失：${groupA.length === 0 ? rule.groupA : rule.groupB}`);
  }
  for (const objectA of groupA) {
    for (const objectB of groupB) {
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

function checkClearance(objects: SpatialValidationObject[], rule: ClearanceRule): SpatialValidationFinding {
  const groupA = objectsInGroup(objects, rule.groupA);
  const groupB = objectsInGroup(objects, rule.groupB);
  if (groupA.length === 0 || groupB.length === 0) {
    return skippedFinding(rule, `对象组缺失：${groupA.length === 0 ? rule.groupA : rule.groupB}`);
  }
  let worst: { objectA: SpatialValidationObject; objectB: SpatialValidationObject; distance: number; pointA: THREE.Vector3 } | undefined;
  for (const objectA of groupA) {
    for (const objectB of groupB) {
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
  const region = new THREE.Box3(
    new THREE.Vector3(...rule.region.center).sub(new THREE.Vector3(...rule.region.size).multiplyScalar(0.5)),
    new THREE.Vector3(...rule.region.center).add(new THREE.Vector3(...rule.region.size).multiplyScalar(0.5))
  );
  for (const target of targets) {
    target.root.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(target.root);
    if (box.isEmpty() || !box.intersectsBox(region)) continue;
    const overlap = box.clone().intersect(region);
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
  return { ruleId: rule.id, ruleLabel: rule.label, kind: rule.kind, status: "pass", detail: "无目标进入禁区" };
}

function roundPoint(point: THREE.Vector3): [number, number, number] {
  return [Number(point.x.toFixed(6)), Number(point.y.toFixed(6)), Number(point.z.toFixed(6))];
}

function skippedFinding(rule: SpatialRule, reason: string): SpatialValidationFinding {
  return { ruleId: rule.id, ruleLabel: rule.label, kind: rule.kind, status: "skipped", detail: reason };
}
