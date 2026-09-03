import type {
  PrimitiveKind,
  RobotLoadCapabilityState,
  RobotToolLoadState,
  SceneSnapshot,
  SceneModelState,
  Vector3Value,
  WorkcellAuditInput,
  WorkcellAuditObject,
  WorkcellBounds,
  WorkcellObjectRole,
  WorkcellPlanningAssumptionState,
  WorkcellRobotTrajectory,
} from "@bim-studio/contracts";
import { robotLoadCapabilityFromPrefab } from "../viewer/robotKinematics";

export interface WorkcellScenePlanningParameters {
  clearanceThresholdMeters: number;
  generatedTrajectorySpeedMps: number;
  generatedTrajectoryTcpRadiusMeters: number;
  origin: WorkcellPlanningAssumptionState["origin"];
  status: WorkcellPlanningAssumptionState["status"];
}

export function starterWorkcellScenePlanningParameters(): WorkcellScenePlanningParameters {
  return {
    clearanceThresholdMeters: .25,
    generatedTrajectorySpeedMps: .5,
    generatedTrajectoryTcpRadiusMeters: .1,
    origin: "starter-values",
    status: "unconfirmed",
  };
}

export function workcellAuditInputFromScene(
  scene: SceneSnapshot,
  planning = starterWorkcellScenePlanningParameters(),
): WorkcellAuditInput {
  validatePlanningParameters(planning);
  const objects: WorkcellAuditObject[] = [
    ...scene.models.map((model) => ({
      id: model.modelId,
      name: model.name,
      // 用户显式启用机器人关节链后，以配置事实为准，避免 ABB/KUKA 等型号名被误判为普通设备。
      role: model.rig?.robot?.enabled ? "robot" as const : workcellRole(model.name),
      position: { ...model.transform.position },
      ...(model.rig?.robot?.enabled ? {
        robot: {
          base: { ...model.transform.position },
          links: model.rig.robot.joints.map((joint) => ({ id: joint.bonePath, name: joint.name, length: joint.length, minAngleDeg: joint.minAngleDeg, maxAngleDeg: joint.maxAngleDeg })),
          ...(model.rig.robot.toolObjectId ? { toolObjectId: model.rig.robot.toolObjectId } : {}),
          ...(model.rig.robot.targetObjectIds?.length ? { targetObjectIds: [...model.rig.robot.targetObjectIds] } : {}),
          ...robotPlanningProfileFromSceneModel(model),
        },
      } : {}),
    })),
    ...scene.primitives.map((primitive) => ({
      id: primitive.modelId,
      name: primitive.name,
      role: workcellRole(primitive.name),
      position: { ...primitive.transform.position },
      bounds: primitiveWorldBounds(primitive.kind, primitive.transform.position, primitive.transform.rotation, primitive.transform.scale),
    })),
    ...(scene.annotations ?? []).filter((item) => workcellRole(item.name) === "target").map((item) => ({
      id: item.id,
      name: item.name,
      role: "target" as const,
      position: { ...item.position },
    })),
  ];
  const trajectories = sceneTrajectories(scene, objects, planning);
  const ergonomicsProfiles = scene.models
    // 只有资源元数据明确声明为人员时才预建档案；名称猜测可能把“操作员控制台”等设备误当成人。
    .filter((model) => model.prefab?.kind === "person")
    .map((model) => ({ id: `human-task:${model.modelId}`, name: `${model.name} · 人工作业`, operatorObjectId: model.modelId }));
  return {
    sceneId: scene.id,
    objects,
    clearanceThreshold: planning.clearanceThresholdMeters,
    planningAssumptions: {
      origin: planning.origin,
      status: planning.status,
      ...(trajectories.length ? {
        generatedTrajectorySpeedMps: planning.generatedTrajectorySpeedMps,
        generatedTrajectoryTcpRadiusMeters: planning.generatedTrajectoryTcpRadiusMeters,
      } : {}),
    },
    ...(trajectories.length ? { trajectories } : {}),
    ...(ergonomicsProfiles.length ? { ergonomicsProfiles } : {}),
  };
}

/** 场景显式配置优先；只有机器人资源预制体的 payloadKg 可作为额定负载回退证据。 */
export function robotPlanningProfileFromSceneModel(model: SceneModelState): {
  loadCapability?: RobotLoadCapabilityState;
  toolLoad?: RobotToolLoadState;
} {
  const robot = model.rig?.robot;
  if (!robot) return {};
  const loadCapability = robot.loadCapability ?? robotLoadCapabilityFromPrefab(model.prefab);
  return {
    ...(loadCapability ? { loadCapability: structuredClone(loadCapability) } : {}),
    ...(robot.toolLoad ? { toolLoad: structuredClone(robot.toolLoad) } : {}),
  };
}

/** 场景适配器只生成直线候选轨迹；精度未由用户声明，因此内核会明确标为 partial。 */
function sceneTrajectories(
  scene: SceneSnapshot,
  objects: WorkcellAuditInput["objects"],
  planning: WorkcellScenePlanningParameters,
): WorkcellRobotTrajectory[] {
  const objectById = new Map(objects.map((item) => [item.id, item]));
  const genericTargets = objects.filter((item) => item.role === "target");
  return scene.models.flatMap((model) => {
    const robot = model.rig?.robot;
    if (!robot?.enabled || !robot.joints.length) return [];
    const targets = robot.targetObjectIds?.length
      ? robot.targetObjectIds.map((id) => objectById.get(id)).filter(isAuditObject)
      : genericTargets;
    if (!targets.length) return [];
    const start = objectById.get(robot.toolObjectId ?? "")?.position ?? model.transform.position;
    const poseByBone = new Map(model.rig?.bones.map((item) => [item.bonePath, item.rotation]) ?? []);
    const currentAngles = robot.joints.map((joint) => {
      const rotation = poseByBone.get(joint.bonePath);
      return rotation ? rotation[joint.axis] * 180 / Math.PI : undefined;
    });
    let elapsed = 0;
    let previous = start;
    const waypoints: WorkcellRobotTrajectory["waypoints"] = [{
      id: `${model.modelId}:current`,
      timeSec: 0,
      position: { ...start },
      ...(currentAngles.every((item): item is number => item !== undefined)
        ? { jointAnglesDeg: currentAngles }
        : {}),
    }];
    for (const target of targets) {
      const distance = vectorDistance(previous, target.position);
      // 重合点没有可证明的运动时长；跳过该段，避免再引入隐藏的最短动作时间。
      if (distance <= 1e-9) continue;
      elapsed += distance / planning.generatedTrajectorySpeedMps;
      waypoints.push({ id: `${model.modelId}:${target.id}`, timeSec: elapsed, position: { ...target.position } });
      previous = target.position;
    }
    if (waypoints.length < 2) return [];
    return [{
      id: `scene-path:${model.modelId}`,
      name: `${model.name} · 场景直线候选`,
      robotId: model.modelId,
      tcpRadius: planning.generatedTrajectoryTcpRadiusMeters,
      precision: { source: "scene-transform" as const },
      waypoints,
    }];
  });
}

function validatePlanningParameters(value: WorkcellScenePlanningParameters): void {
  if (!Number.isFinite(value.clearanceThresholdMeters) || value.clearanceThresholdMeters < 0 || value.clearanceThresholdMeters > 100) {
    throw new Error("工位安全间隙必须在 0–100 m 之间");
  }
  if (!Number.isFinite(value.generatedTrajectorySpeedMps) || value.generatedTrajectorySpeedMps <= 0) {
    throw new Error("候选轨迹 TCP 速度必须大于 0 m/s");
  }
  if (!Number.isFinite(value.generatedTrajectoryTcpRadiusMeters) || value.generatedTrajectoryTcpRadiusMeters <= 0) {
    throw new Error("候选轨迹 TCP 包络半径必须大于 0 m");
  }
}

export function workcellRole(name: string): WorkcellObjectRole {
  const normalized = name.toLowerCase();
  if (/(target|目标|抓取点|焊点|装配点|工位点)/.test(normalized)) return "target";
  if (/(夹具|抓手|末端工具|焊枪|tool|gripper|fixture)/.test(normalized)) return "tool";
  if (/(围栏|护栏|安全门|墙|障碍|fence|guard|wall|obstacle)/.test(normalized)) return "obstacle";
  if (/(机器人|机械臂|robot)/.test(normalized) && !/(底座|肩|大臂|小臂|肘|腕|关节|base|arm|elbow|wrist|joint)/.test(normalized)) return "robot";
  return "equipment";
}

export function primitiveWorldBounds(kind: PrimitiveKind, position: Vector3Value, rotation: Vector3Value, scale: Vector3Value): WorkcellBounds {
  const local = localHalfSize(kind);
  const half = { x: local.x * Math.abs(scale.x), y: local.y * Math.abs(scale.y), z: local.z * Math.abs(scale.z) };
  const matrix = rotationMatrix(rotation);
  const extent = {
    x: Math.abs(matrix[0]) * half.x + Math.abs(matrix[1]) * half.y + Math.abs(matrix[2]) * half.z,
    y: Math.abs(matrix[3]) * half.x + Math.abs(matrix[4]) * half.y + Math.abs(matrix[5]) * half.z,
    z: Math.abs(matrix[6]) * half.x + Math.abs(matrix[7]) * half.y + Math.abs(matrix[8]) * half.z,
  };
  return {
    min: { x: position.x - extent.x, y: position.y - extent.y, z: position.z - extent.z },
    max: { x: position.x + extent.x, y: position.y + extent.y, z: position.z + extent.z },
  };
}

function localHalfSize(kind: PrimitiveKind): Vector3Value {
  if (kind === "torus") return { x: 1.32, y: 1.32, z: 0.32 };
  if (kind === "plane") return { x: 1.5, y: 0.01, z: 1.5 };
  if (kind === "capsule") return { x: 0.65, y: 1.35, z: 0.65 };
  return { x: 1, y: 1, z: 1 };
}

function rotationMatrix(rotation: Vector3Value): [number, number, number, number, number, number, number, number, number] {
  const a = Math.cos(rotation.x), b = Math.sin(rotation.x);
  const c = Math.cos(rotation.y), d = Math.sin(rotation.y);
  const e = Math.cos(rotation.z), f = Math.sin(rotation.z);
  return [c * e, -c * f, d, a * f + b * e * d, a * e - b * f * d, -b * c, b * f - a * e * d, b * e + a * f * d, a * c];
}

function isAuditObject(value: WorkcellAuditInput["objects"][number] | undefined): value is WorkcellAuditInput["objects"][number] {
  return Boolean(value);
}

function vectorDistance(left: Vector3Value, right: Vector3Value): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}
