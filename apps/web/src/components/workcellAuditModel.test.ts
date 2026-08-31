import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { primitiveWorldBounds, workcellAuditInputFromScene, workcellRole } from "./workcellAuditModel";

describe("workcell audit scene adapter", () => {
  it("classifies high-value workcell objects without treating robot parts as full robots", () => {
    expect(workcellRole("机器人 A")).toBe("robot");
    expect(workcellRole("机器人腕部")).toBe("equipment");
    expect(workcellRole("末端夹具")).toBe("tool");
    expect(workcellRole("安全围栏")).toBe("obstacle");
    expect(workcellRole("焊点 01")).toBe("target");
  });

  it("creates conservative world bounds for rotated primitives", () => {
    const bounds = primitiveWorldBounds("box", { x: 2, y: 1, z: 0 }, { x: 0, y: 0, z: Math.PI / 2 }, { x: 2, y: 1, z: 1 });
    expect(bounds.min.x).toBeCloseTo(1);
    expect(bounds.max.x).toBeCloseTo(3);
    expect(bounds.min.y).toBeCloseTo(-1);
    expect(bounds.max.y).toBeCloseTo(3);
  });

  it("treats an explicitly configured vendor model as a robot", () => {
    const timestamp = "2026-08-30T00:00:00.000Z";
    const scene: SceneSnapshot = {
      schemaVersion: 1, id: "scene", projectId: "project", name: "工位",
      camera: { position: { x: 1, y: 1, z: 1 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
      models: [{
        modelId: "abb", name: "IRB 6700", visible: true, opacity: 1,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        rig: { bones: [], ik: [], robot: { enabled: true, baseBonePath: "root", joints: [] } },
      }],
      primitives: [], measurements: [], createdAt: timestamp, updatedAt: timestamp,
    };

    expect(workcellAuditInputFromScene(scene).objects[0]?.role).toBe("robot");
  });

  it("derives an explicitly approximate straight trajectory from configured scene targets", () => {
    const timestamp = "2026-08-30T00:00:00.000Z";
    const scene: SceneSnapshot = {
      schemaVersion: 1, id: "scene", projectId: "project", name: "工位",
      camera: { position: { x: 1, y: 1, z: 1 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
      models: [{
        modelId: "robot", name: "机器人", visible: true, opacity: 1,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        rig: {
          bones: [{ bonePath: "joint-1", rotation: { x: 0, y: Math.PI / 4, z: 0 } }],
          ik: [],
          robot: {
            enabled: true,
            baseBonePath: "root",
            targetObjectIds: ["target-1"],
            joints: [{ bonePath: "joint-1", name: "J1", axis: "y", length: 1, minAngleDeg: -90, maxAngleDeg: 90 }],
          },
        },
      }],
      primitives: [],
      annotations: [{ id: "target-1", name: "抓取目标", position: { x: 1, y: 0, z: 0 }, color: "#fff", visible: true, locked: false }],
      measurements: [], createdAt: timestamp, updatedAt: timestamp,
    };
    const input = workcellAuditInputFromScene(scene);

    expect(input.trajectories).toMatchObject([{
      id: "scene-path:robot",
      robotId: "robot",
      tcpRadius: 0.1,
      precision: { source: "scene-transform" },
      waypoints: [
        { id: "robot:current", timeSec: 0, jointAnglesDeg: [45] },
        { id: "robot:target-1", timeSec: 2, position: { x: 1, y: 0, z: 0 } },
      ],
    }]);
  });
});
