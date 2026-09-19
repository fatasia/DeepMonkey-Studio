import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { runSpatialValidation, type SpatialRule, type SpatialValidationObject } from "./spatialValidation";

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
