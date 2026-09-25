// R0 黄金样例 golden-07(规格 ps-pd-plant-full-replacement-upgrade-plan-2026-09-25.md)
// 机器人碰撞:输入 → auditWorkcell 运行 → 证据链指纹固化。
// 业务约束:碰撞结论只允许来自确定性 AABB 相交,禁止无几何时编造结论;
// 同一输入必须产生同一指纹,碰撞样例与无碰撞对照必须可被指纹区分。
import { describe, expect, it } from "vitest";
import { fingerprint64Labeled } from "@bim-studio/contracts";
import type { WorkcellAuditInput, WorkcellAuditResult } from "@bim-studio/contracts";
import { auditWorkcell } from "./engine.js";

describe("R0 golden-07 机器人碰撞证据链", () => {
  it("碰撞样例产出 collision error finding,且结论来自确定的 AABB 相交对", () => {
    const result = auditWorkcell(collisionFixture(true));

    expect(result.status).toBe("failed");
    const collisionFindings = result.findings.filter((item) => item.category === "collision");
    expect(collisionFindings).toEqual([
      expect.objectContaining({
        id: "collision-robot-07-guard-07",
        severity: "error",
        objectIds: ["robot-07", "guard-07"],
      }),
    ]);
    expect(result.collisionPairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectIds: ["robot-07", "guard-07"], distance: 0, intersects: true, required: true }),
      ]),
    );
    // 可达性与负载均通过,证明 failed 只由空间冲突导致
    expect(result.reachability).toEqual([
      expect.objectContaining({ robotId: "robot-07", targetId: "pick-point", status: "reachable" }),
    ]);
    expect(result.loadChecks).toEqual([expect.objectContaining({ status: "within-planning-envelope" })]);
  });

  it("无碰撞对照样例不产出任何 finding,必要对保持声明距离", () => {
    const result = auditWorkcell(collisionFixture(false));

    expect(result.status).toBe("passed");
    expect(result.findings).toEqual([]);
    expect(result.collisionPairs.every((item) => !item.intersects)).toBe(true);
    expect(result.collisionPairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectIds: ["robot-07", "guard-07"], distance: 1.6, intersects: false }),
      ]),
    );
  });

  it("同一输入两次运行产生同一证据指纹,且碰撞与对照可被指纹区分", () => {
    const collisionFirst = auditWorkcell(collisionFixture(true));
    const collisionSecond = auditWorkcell(collisionFixture(true));
    const clearRun = auditWorkcell(collisionFixture(false));

    // 内置证据指纹:同输入同值
    expect(collisionFirst.evidenceFingerprint).toBe(collisionSecond.evidenceFingerprint);
    // 黄金证据链指纹:标签化组合指纹,同输入同值、不同证据不同值
    expect(evidenceChainOf(collisionFirst)).toBe(evidenceChainOf(collisionSecond));
    expect(evidenceChainOf(collisionFirst)).not.toBe(evidenceChainOf(clearRun));
    expect(collisionFirst.evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});

/** 黄金证据链指纹:场景、结论状态、空间关系与碰撞发现分标签掺入,任一变化都会改变指纹。 */
function evidenceChainOf(result: WorkcellAuditResult): string {
  return fingerprint64Labeled([
    ["sceneId", result.sceneId],
    ["status", result.status],
    ["collisionPairs", result.collisionPairs],
    ["collisionFindings", result.findings.filter((item) => item.category === "collision" || item.category === "clearance")],
  ]);
}

function collisionFixture(intersecting: boolean): WorkcellAuditInput {
  return {
    sceneId: "golden-07-robot-collision",
    clearanceThreshold: 0.25,
    planningAssumptions: { origin: "authored", status: "engineer-confirmed" },
    objects: [
      {
        id: "robot-07", name: "六轴机器人", role: "robot", position: { x: 0, y: 0, z: 0 },
        bounds: { min: { x: -1, y: -0.5, z: 0 }, max: { x: 1, y: 0.5, z: 2 } },
        robot: {
          base: { x: 0, y: 0, z: 0 },
          toolObjectId: "gripper-07",
          targetObjectIds: ["pick-point"],
          links: [
            { id: "j1", name: "J1", length: 1.5, minAngleDeg: -180, maxAngleDeg: 180 },
            { id: "j2", name: "J2", length: 1, minAngleDeg: -180, maxAngleDeg: 180 },
          ],
          loadCapability: { ratedPayloadKg: 20, maximumLoadCenterDistanceMeters: 0.35, source: "configured-prefab" },
          toolLoad: {
            toolMassKg: 4,
            carriedPayloadKg: 8,
            tcpPositionMeters: { x: 0, y: 0, z: 0.25 },
            tcpOrientationEulerDeg: { x: 0, y: 90, z: 0 },
            combinedCenterOfMassMeters: { x: 0, y: 0, z: 0.2 },
            source: "author-confirmed",
          },
        },
      },
      { id: "gripper-07", name: "真空抓手", role: "tool", position: { x: 0, y: 0, z: 1.8 }, bounds: { min: { x: -0.1, y: -0.1, z: 1.7 }, max: { x: 0.1, y: 0.1, z: 1.9 } } },
      { id: "pick-point", name: "取料点", role: "target", position: { x: 2, y: 0, z: 0 }, bounds: { min: { x: 1.99, y: -0.01, z: -0.01 }, max: { x: 2.01, y: 0.01, z: 0.01 } } },
      {
        id: "guard-07", name: "安全围栏", role: "obstacle", position: { x: intersecting ? 1 : 2.9, y: 0, z: intersecting ? 1 : 0 },
        bounds: intersecting
          ? { min: { x: 0.5, y: -0.5, z: 0 }, max: { x: 1.5, y: 0.5, z: 2 } }
          : { min: { x: 2.6, y: -0.5, z: -1 }, max: { x: 3.2, y: 0.5, z: 1 } },
      },
    ],
  };
}
