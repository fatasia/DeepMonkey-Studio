import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { primitiveWorldBounds, robotPlanningProfileFromSceneModel, starterWorkcellScenePlanningParameters, workcellAuditInputFromScene, workcellRole } from "./workcellAuditModel";

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

    expect(input.planningAssumptions).toEqual({
      origin: "starter-values",
      status: "unconfirmed",
      generatedTrajectorySpeedMps: .5,
      generatedTrajectoryTcpRadiusMeters: .1,
    });
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

    const confirmed = workcellAuditInputFromScene(scene, {
      ...starterWorkcellScenePlanningParameters(),
      generatedTrajectorySpeedMps: 1,
      generatedTrajectoryTcpRadiusMeters: .05,
      origin: "authored",
      status: "engineer-confirmed",
    });
    expect(confirmed).toMatchObject({
      clearanceThreshold: .25,
      planningAssumptions: {
        origin: "authored",
        status: "engineer-confirmed",
        generatedTrajectorySpeedMps: 1,
        generatedTrajectoryTcpRadiusMeters: .05,
      },
      trajectories: [{ tcpRadius: .05, waypoints: [{ timeSec: 0 }, { timeSec: 1 }] }],
    });

    const colocated = structuredClone(scene);
    colocated.annotations![0]!.position = { x: 0, y: 0, z: 0 };
    expect(workcellAuditInputFromScene(colocated).trajectories).toBeUndefined();
  });

  it("reuses a configured robot prefab payload but never invents tool/TCP evidence", () => {
    const model: SceneSnapshot["models"][number] = {
      modelId: "robot", name: "六轴机器人", visible: true, opacity: 1,
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      prefab: {
        definitionId: "robot.articulated-6", definitionVersion: "1.0.0", kind: "robot-arm",
        parameters: { payloadKg: 20 }, operatingState: "idle",
      },
      rig: { bones: [], ik: [], robot: { enabled: true, baseBonePath: "root", joints: [] } },
    };

    expect(robotPlanningProfileFromSceneModel(model)).toEqual({
      loadCapability: { ratedPayloadKg: 20, source: "configured-prefab", reference: "robot.articulated-6@1.0.0" },
    });
    const modelWithoutPrefab = structuredClone(model);
    delete modelWithoutPrefab.prefab;
    expect(robotPlanningProfileFromSceneModel(modelWithoutPrefab)).toEqual({});
  });

  it("discovers person prefabs but never invents anthropometry or task evidence", () => {
    const timestamp = "2026-08-30T00:00:00.000Z";
    const scene: SceneSnapshot = {
      schemaVersion: 1, id: "scene-human", projectId: "project", name: "人工工位",
      camera: { position: { x: 1, y: 1, z: 1 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
      models: [{
        modelId: "person-1", name: "装配人员", visible: true, opacity: 1,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        prefab: { definitionId: "person.operator", definitionVersion: "1.0.0", kind: "person", parameters: { speedMps: 1.3 }, operatingState: "idle" },
      }, {
        modelId: "console-1", name: "操作员控制台", visible: true, opacity: 1,
        transform: { position: { x: 1, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      }],
      primitives: [], measurements: [], createdAt: timestamp, updatedAt: timestamp,
    };

    expect(workcellAuditInputFromScene(scene).ergonomicsProfiles).toEqual([{
      id: "human-task:person-1", name: "装配人员 · 人工作业", operatorObjectId: "person-1",
    }]);
    expect(workcellAuditInputFromScene(scene).ergonomicsProfiles?.[0]).not.toHaveProperty("anthropometry");
    expect(workcellAuditInputFromScene(scene).ergonomicsProfiles?.[0]).not.toHaveProperty("task");
    expect(workcellAuditInputFromScene(scene).ergonomicsProfiles?.[0]).not.toHaveProperty("policy");
  });
});
