import type {
  PrimitiveKind,
  SceneSnapshot,
  Vector3Value,
  WorkcellAuditInput,
  WorkcellAuditObject,
  WorkcellBounds,
  WorkcellObjectRole,
  WorkcellRobotTrajectory,
} from "@bim-studio/contracts";

export function workcellAuditInputFromScene(scene: SceneSnapshot): WorkcellAuditInput {
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
  const trajectories = sceneTrajectories(scene, objects);
  return {
    sceneId: scene.id,
    objects,
    clearanceThreshold: 0.25,
    ...(trajectories.length ? { trajectories } : {}),
  };
}

/** 场景适配器只生成直线候选轨迹；精度未由用户声明，因此内核会明确标为 partial。 */
function sceneTrajectories(
  scene: SceneSnapshot,
  objects: WorkcellAuditInput["objects"],
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
      // 0.5 m/s 仅用于形成可复核时序候选，不等同于控制器节拍承诺。
      elapsed += Math.max(0.1, vectorDistance(previous, target.position) / 0.5);
      waypoints.push({ id: `${model.modelId}:${target.id}`, timeSec: elapsed, position: { ...target.position } });
      previous = target.position;
    }
    return [{
      id: `scene-path:${model.modelId}`,
      name: `${model.name} · 场景直线候选`,
      robotId: model.modelId,
      tcpRadius: 0.1,
      precision: { source: "scene-transform" as const },
      waypoints,
    }];
  });
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
