import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { closestPointsBetweenObjects, preciseIntersection } from "./analysis";
import {
  broadPhaseCandidatePairs,
  runSpatialValidation,
  worldBoundingSphere,
  type SpatialRule,
  type SpatialValidationObject
} from "./spatialValidation";

function boxAt(id: string, group: string, position: [number, number, number], size: [number, number, number] = [1, 1, 1]): SpatialValidationObject {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
  mesh.name = id;
  mesh.userData.layerNodeId = id;
  mesh.position.set(...position);
  return { id, group, root: mesh };
}

const REGION = { center: [10, 0, 0] as [number, number, number], size: [2, 2, 2] as [number, number, number] };

describe("spatial validation", () => {
  it("fails hard-collision when two groups intersect", () => {
    const objects = [boxAt("pipe-a", "pipe", [0, 0, 0], [2, 1, 1]), boxAt("beam-b", "beam", [1, 0, 0], [2, 1, 1])];
    const rules: SpatialRule[] = [{ kind: "hard-collision", id: "R1", label: "管线-钢梁硬碰撞", groupA: "pipe", groupB: "beam" }];
    const report = runSpatialValidation(objects, rules);
    expect(report.passed).toBe(false);
    expect(report.summary.hardCollisionViolations).toBe(1);
    const finding = report.findings[0]!;
    expect(finding.status).toBe("fail");
    expect(finding.objectIdA).toBe("pipe-a");
    expect(finding.objectIdB).toBe("beam-b");
    expect(finding.point).toHaveLength(3);
  });

  it("passes hard-collision for separated groups", () => {
    const objects = [boxAt("pipe-a", "pipe", [0, 0, 0]), boxAt("beam-b", "beam", [6, 0, 0])];
    const rules: SpatialRule[] = [{ kind: "hard-collision", id: "R1", label: "硬碰撞", groupA: "pipe", groupB: "beam" }];
    const report = runSpatialValidation(objects, rules);
    expect(report.passed).toBe(true);
    expect(report.findings[0]!.status).toBe("pass");
  });

  it("checks clearance against the required minimum with margin evidence", () => {
    const objects = [boxAt("duct-a", "duct", [0, 0, 0]), boxAt("cable-b", "cable", [1.5, 0, 0])];
    const rules: SpatialRule[] = [
      { kind: "clearance", id: "R2", label: "电缆桥架净空 0.8m", groupA: "duct", groupB: "cable", minimumMetres: 0.8 },
      { kind: "clearance", id: "R3", label: "检修净空 0.3m", groupA: "duct", groupB: "cable", minimumMetres: 0.3 },
    ];
    const report = runSpatialValidation(objects, rules);
    const tight = report.findings.find((finding) => finding.ruleId === "R2");
    const loose = report.findings.find((finding) => finding.ruleId === "R3");
    expect(tight?.status).toBe("fail");
    expect(tight?.distanceMetres).toBeCloseTo(0.5, 5);
    expect(tight?.marginMetres).toBeCloseTo(-0.3, 5);
    expect(loose?.status).toBe("pass");
    expect(loose?.marginMetres).toBeGreaterThan(0);
  });

  it("fails region-exclusion when a target enters the forbidden box", () => {
    const objects = [boxAt("stockpile", "storage", [10, 0, 0], [1.5, 1.5, 1.5]), boxAt("pump", "equipment", [0, 0, 0])];
    const rules: SpatialRule[] = [{ kind: "region-exclusion", id: "R4", label: "消防通道禁堆料", region: REGION, targets: "storage" }];
    const report = runSpatialValidation(objects, rules);
    expect(report.summary.regionExclusionViolations).toBe(1);
    expect(report.findings[0]!.status).toBe("fail");
    expect(report.findings[0]!.objectIdA).toBe("stockpile");
  });

  it("passes region-exclusion when targets stay outside", () => {
    const objects = [boxAt("pump", "equipment", [0, 0, 0])];
    const rules: SpatialRule[] = [{ kind: "region-exclusion", id: "R5", label: "配电禁区", region: REGION, targets: "equipment" }];
    const report = runSpatialValidation(objects, rules);
    expect(report.passed).toBe(true);
  });

  it("skips rules with missing groups instead of silently passing", () => {
    const objects = [boxAt("pipe-a", "pipe", [0, 0, 0])];
    const rules: SpatialRule[] = [
      { kind: "hard-collision", id: "R6", label: "缺对手组", groupA: "pipe", groupB: "ghost" },
      { kind: "region-exclusion", id: "R7", label: "缺目标组", region: REGION, targets: "ghost" },
    ];
    const report = runSpatialValidation(objects, rules);
    expect(report.passed).toBe(true);
    expect(report.summary.skippedRules).toBe(2);
    expect(report.findings.every((finding) => finding.status === "skipped")).toBe(true);
  });

  it("aggregates a mixed report", () => {
    const objects = [
      boxAt("wall-a", "structure", [0, 0, 0], [2, 2, 2]),
      boxAt("robot-b", "robot", [1, 0, 0], [2, 2, 2]),
      boxAt("pallet-c", "storage", [10, 0, 0], [1.5, 1.5, 1.5]),
    ];
    const rules: SpatialRule[] = [
      { kind: "hard-collision", id: "R1", label: "结构-机器人硬碰撞", groupA: "structure", groupB: "robot" },
      { kind: "region-exclusion", id: "R4", label: "消防通道禁堆料", region: REGION, targets: "storage" },
    ];
    const report = runSpatialValidation(objects, rules);
    expect(report.passed).toBe(false);
    expect(report.objectCount).toBe(3);
    expect(report.ruleCount).toBe(2);
    expect(report.summary.hardCollisionViolations).toBe(1);
    expect(report.summary.regionExclusionViolations).toBe(1);
  });
});

// ─── 切片二：区域旋转语义（OBB）───────────────────────────────────────────────
// 用例几何已经分离轴判据数值预验（区域 size [8,2,1] @ 原点，yaw 45°）：
// 目标 A (2.6,0,-1.5)³⁰·⁵：不旋转不进、旋转 45° 进（分离轴在旋转后全部闭合）；
// 目标 B (3.7,0,0.45)³⁰·⁵：不旋转进、旋转 45° 出（世界 X 轴 3.7 > 3.432 分离）。

const ROTATED_REGION = {
  center: [0, 0, 0] as [number, number, number],
  size: [8, 2, 1] as [number, number, number],
  rotationYRad: Math.PI / 4
};
const UNROTATED_REGION = { center: ROTATED_REGION.center, size: ROTATED_REGION.size };

describe("region-exclusion yaw rotation (OBB)", () => {
  it("admits a target the unrotated region would keep out once rotated 45°", () => {
    const objects = [boxAt("crane", "storage", [2.6, 0, -1.5], [0.5, 0.5, 0.5])];
    const rules: SpatialRule[] = [
      { kind: "region-exclusion", id: "ROT", label: "旋转禁区", region: { ...ROTATED_REGION }, targets: "storage" },
      { kind: "region-exclusion", id: "AXIS", label: "同位轴对齐", region: { ...UNROTATED_REGION }, targets: "storage" }
    ];
    const report = runSpatialValidation(objects, rules);
    const rotated = report.findings.find((finding) => finding.ruleId === "ROT");
    const axisAligned = report.findings.find((finding) => finding.ruleId === "AXIS");
    expect(rotated?.status).toBe("fail");
    expect(rotated?.objectIdA).toBe("crane");
    expect(axisAligned?.status).toBe("pass");
  });

  it("keeps a target out that the unrotated region would flag once rotated 45°", () => {
    const objects = [boxAt("pallet", "storage", [3.7, 0, 0.45], [0.5, 0.5, 0.5])];
    const rules: SpatialRule[] = [
      { kind: "region-exclusion", id: "ROT", label: "旋转禁区", region: { ...ROTATED_REGION }, targets: "storage" },
      { kind: "region-exclusion", id: "AXIS", label: "同位轴对齐", region: { ...UNROTATED_REGION }, targets: "storage" }
    ];
    const report = runSpatialValidation(objects, rules);
    const rotated = report.findings.find((finding) => finding.ruleId === "ROT");
    const axisAligned = report.findings.find((finding) => finding.ruleId === "AXIS");
    expect(rotated?.status).toBe("pass");
    expect(axisAligned?.status).toBe("fail");
    expect(axisAligned?.objectIdA).toBe("pallet");
  });

  it("behaves identically to the axis-aligned path when rotationYRad is undefined or zero", () => {
    const objects = [
      boxAt("stockpile", "storage", [10, 0, 0], [1.5, 1.5, 1.5]),
      boxAt("pump", "equipment", [0, 0, 0])
    ];
    const base: SpatialRule = { kind: "region-exclusion", id: "R4", label: "消防通道禁堆料", region: { ...REGION }, targets: "storage" };
    const zeroed: SpatialRule = {
      kind: "region-exclusion",
      id: "R4",
      label: "消防通道禁堆料",
      region: { ...REGION, rotationYRad: 0 },
      targets: "storage"
    };
    const withUndefined = runSpatialValidation(objects, [base]);
    const withZero = runSpatialValidation(objects, [zeroed]);
    // 逐字段一致（generatedAt 为时间戳，不参与比较）
    expect(JSON.stringify(withZero.findings)).toBe(JSON.stringify(withUndefined.findings));
    expect(JSON.stringify(withZero.summary)).toBe(JSON.stringify(withUndefined.summary));
  });

  it("reports an evidence point on the rotated region for intruding targets", () => {
    const objects = [boxAt("crane", "storage", [2.6, 0, -1.5], [0.5, 0.5, 0.5])];
    const rules: SpatialRule[] = [{ kind: "region-exclusion", id: "ROT", label: "旋转禁区", region: { ...ROTATED_REGION }, targets: "storage" }];
    const report = runSpatialValidation(objects, rules);
    const finding = report.findings[0]!;
    expect(finding.status).toBe("fail");
    // 目标中心 (2.6,0,-1.5) 在区域局部系 clamp 后转回世界系：localZ=0.7778 → 0.5（区域表面）
    expect(finding.point?.[0]).toBeCloseTo(2.403553, 5);
    expect(finding.point?.[1]).toBeCloseTo(0, 5);
    expect(finding.point?.[2]).toBeCloseTo(-1.696447, 5);
  });

  it("updates the evidence boundary to cover rotated region semantics", () => {
    const report = runSpatialValidation([], []);
    expect(report.evidenceBoundary).not.toContain("仅支持轴对齐");
    expect(report.meta.broadPhase).toEqual({ candidatePairs: 0, totalPairs: 0, candidatePairRatio: 0 });
  });
});

// ─── 切片二：宽相预筛 ─────────────────────────────────────────────────────────
// 70 对象场景：35 pipe + 35 beam，7×5 网格（x 间距 6、z 间距 3），单位立方体。
// beam 默认位于同格 pipe +1.2（表面距 0.2，候选但不相交）；beam-5/12/27 改 +0.4
// （与所属 pipe 相交）；beam-8 改 +1.9（球距 1.9 > 2×0.866，验证宽相剪枝）。

function broadPhaseScene(): SpatialValidationObject[] {
  const objects: SpatialValidationObject[] = [];
  const pipeAt = (i: number): [number, number, number] => [(i % 7) * 6, 0, Math.floor(i / 7) * 3];
  for (let i = 0; i < 35; i++) {
    objects.push(boxAt(`pipe-${i}`, "pipe", pipeAt(i)));
  }
  for (let i = 0; i < 35; i++) {
    const offset = i === 5 || i === 12 || i === 27 ? 0.4 : i === 8 ? 1.9 : 1.2;
    const [x, y, z] = pipeAt(i);
    objects.push(boxAt(`beam-${i}`, "beam", [x + offset, y, z]));
  }
  return objects;
}

describe("broad-phase pruning", () => {
  it("matches brute-force pairwise results field by field at 60+ object scale", () => {
    const objects = broadPhaseScene();
    const pipes = objects.filter((object) => object.group === "pipe");
    const beams = objects.filter((object) => object.group === "beam");
    expect(pipes.length + beams.length).toBeGreaterThanOrEqual(60);
    // 暴力参考：与引擎同序遍历全部 35×35 对（不经宽相）
    let bruteHit: { a: string; b: string; point: [number, number, number] } | undefined;
    for (const pipe of pipes) {
      if (bruteHit) break;
      for (const beam of beams) {
        const intersection = preciseIntersection(pipe.root, beam.root);
        if (!intersection) continue;
        bruteHit = {
          a: intersection.nodeIdA === "root" ? pipe.id : intersection.nodeIdA,
          b: intersection.nodeIdB === "root" ? beam.id : intersection.nodeIdB,
          point: [intersection.point.x, intersection.point.y, intersection.point.z]
        };
        break;
      }
    }
    let bruteWorst: { distance: number; a: string; b: string } | undefined;
    for (const pipe of pipes) {
      for (const beam of beams) {
        const closest = closestPointsBetweenObjects(pipe.root, beam.root);
        if (!closest) continue;
        if (!bruteWorst || closest.distance < bruteWorst.distance) {
          bruteWorst = { distance: closest.distance, a: pipe.id, b: beam.id };
        }
      }
    }
    expect(bruteHit).toBeDefined();
    expect(bruteWorst).toBeDefined();
    const rules: SpatialRule[] = [
      { kind: "hard-collision", id: "HC", label: "硬碰撞", groupA: "pipe", groupB: "beam" },
      { kind: "clearance", id: "CL", label: "净空 0.25m", groupA: "pipe", groupB: "beam", minimumMetres: 0.25 }
    ];
    const report = runSpatialValidation(objects, rules);
    const hardCollision = report.findings.find((finding) => finding.ruleId === "HC")!;
    const clearance = report.findings.find((finding) => finding.ruleId === "CL")!;
    // 硬碰撞：首个相交对与逐字段一致
    expect(hardCollision.status).toBe("fail");
    expect(hardCollision.objectIdA).toBe(bruteHit!.a);
    expect(hardCollision.objectIdB).toBe(bruteHit!.b);
    expect(hardCollision.point?.[0]).toBeCloseTo(bruteHit!.point[0], 6);
    expect(hardCollision.point?.[1]).toBeCloseTo(bruteHit!.point[1], 6);
    expect(hardCollision.point?.[2]).toBeCloseTo(bruteHit!.point[2], 6);
    // 净空：全局最小距离对逐字段一致
    expect(clearance.status).toBe("fail");
    expect(clearance.distanceMetres).toBeCloseTo(bruteWorst!.distance, 6);
    expect(clearance.objectIdA).toBe(bruteWorst!.a);
    expect(clearance.objectIdB).toBe(bruteWorst!.b);
  });

  it("records a pruning ratio below 1 and consistent reports across repeated runs", () => {
    const objects = broadPhaseScene();
    const rules: SpatialRule[] = [
      { kind: "hard-collision", id: "HC", label: "硬碰撞", groupA: "pipe", groupB: "beam" },
      { kind: "clearance", id: "CL", label: "净空 0.25m", groupA: "pipe", groupB: "beam", minimumMetres: 0.25 }
    ];
    const first = runSpatialValidation(objects, rules);
    const second = runSpatialValidation(objects, rules);
    expect(JSON.stringify(first.findings)).toBe(JSON.stringify(second.findings));
    expect(first.meta.broadPhase.totalPairs).toBe(35 * 35 * 2);
    expect(first.meta.broadPhase.candidatePairs).toBeGreaterThan(0);
    expect(first.meta.broadPhase.candidatePairRatio).toBeLessThan(1);
    expect(first.meta.broadPhase.candidatePairRatio).toBeCloseTo(first.meta.broadPhase.candidatePairs / first.meta.broadPhase.totalPairs, 12);
  });

  it("keeps every world-box-overlap pair as a broad-phase candidate", () => {
    const objects = broadPhaseScene();
    const spheres = objects.map((object) => worldBoundingSphere(object.root));
    const pipes = spheres.slice(0, 35);
    const beams = spheres.slice(35);
    const candidates = broadPhaseCandidatePairs(pipes, beams);
    // 暴力参考：世界包围盒相交对必须全部入选候选（宽相保守性）
    const boxes = objects.map((object) => {
      object.root.updateWorldMatrix(true, true);
      return new THREE.Box3().setFromObject(object.root);
    });
    let overlapPairs = 0;
    for (let i = 0; i < 35; i++) {
      for (let j = 0; j < 35; j++) {
        if (!boxes[i]!.intersectsBox(boxes[35 + j]!)) continue;
        overlapPairs++;
        expect(candidates.has(i * 35 + j)).toBe(true);
      }
    }
    expect(overlapPairs).toBeGreaterThan(0);
    expect(candidates.size).toBeLessThan(35 * 35);
  });
});
