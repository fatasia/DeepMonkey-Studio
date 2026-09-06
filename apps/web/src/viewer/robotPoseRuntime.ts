import { assertRobotPose, type RobotAssetDefinition } from "@bim-studio/contracts";
import type { Object3D } from "three";
import type { URDFRobot } from "urdf-loader";

interface RobotRuntime { robot: URDFRobot; definition: RobotAssetDefinition; authored: Record<string, number> }
// 对象身份天然区分共享资源的各实例；替换回滚重新挂载原对象即可恢复原运行态。
const runtimes = new WeakMap<Object3D, RobotRuntime>();

export function attachRobotRuntime(object: Object3D, robot: URDFRobot, definition: RobotAssetDefinition): void {
  const runtime: RobotRuntime = { robot, definition: structuredClone(definition), authored: {} };
  // 自行按拓扑先限幅再派生，避免库在 mimic 链内部先传播再限幅导致下游读数偏离。
  for (const joint of Object.values(robot.joints)) joint.mimicJoints = [];
  runtimes.set(object, runtime);
  writeRobotPose(object, {}, true, true);
}

export function readRobotDefinition(object: Object3D | undefined): RobotAssetDefinition | undefined {
  const value = object && runtimes.get(object)?.definition;
  return value ? structuredClone(value) : undefined;
}

export function readRobotPose(object: Object3D | undefined): Record<string, number> | undefined {
  const runtime = object && runtimes.get(object);
  return runtime ? { ...runtime.authored } : undefined;
}

export function readLiveRobotPose(object: Object3D): Record<string, number> | undefined {
  const runtime = runtimes.get(object);
  return runtime ? Object.fromEntries(runtime.definition.joints.filter(joint => joint.type !== "fixed" && !joint.mimic)
    .map(joint => [joint.name, runtime.robot.joints[joint.name]?.jointValue[0] ?? 0])) : undefined;
}

/** 全量预检后一次应用；遥测不回写作者状态。fixed/mimic 的同步读数不作为驱动。 */
export function writeRobotPose(object: Object3D | undefined, values: Record<string, number>, author: boolean, reset = false): boolean {
  const runtime = object && runtimes.get(object);
  if (!runtime || !object) return false;
  assertRobotPose(values);
  const joints = new Map(runtime.definition.joints.map(joint => [joint.name, joint]));
  for (const name of Object.keys(values)) if (!joints.has(name)) throw new Error(`机器人没有关节 ${name}`);
  const pose: Record<string, number> = {};
  for (const joint of joints.values()) {
    if (joint.type === "fixed" || joint.mimic) continue;
    const base = reset ? 0 : author ? Object.hasOwn(runtime.authored, joint.name) ? runtime.authored[joint.name]! : 0 : runtime.robot.joints[joint.name]?.jointValue[0] ?? 0;
    let value = Object.hasOwn(values, joint.name) ? values[joint.name]! : base;
    if (joint.type !== "continuous") value = Math.max(joint.limit?.lower ?? -Infinity, Math.min(joint.limit?.upper ?? Infinity, value));
    pose[joint.name] = value;
  }
  const resolved = resolveRobotJointValues(runtime.definition, pose);
  for (const [name, value] of Object.entries(resolved)) runtime.robot.setJointValue(name, value);
  object.updateWorldMatrix(true, true);
  if (author) runtime.authored = pose;
  return true;
}

export function resolveRobotJointValues(definition: RobotAssetDefinition, pose: Record<string, number>): Record<string, number> {
  const joints = new Map(definition.joints.map(joint => [joint.name, joint])), result: Record<string, number> = {}, visiting = new Set<string>();
  const read = (name: string): number => {
    if (Object.hasOwn(result, name)) return result[name]!;
    const joint = joints.get(name);
    if (!joint || visiting.has(name)) throw new Error("机器人 mimic 关节引用无效");
    visiting.add(name);
    let value = joint.type === "fixed" ? 0 : joint.mimic ? read(joint.mimic.joint) * joint.mimic.multiplier + joint.mimic.offset : Object.hasOwn(pose, name) ? pose[name]! : 0;
    if (!Number.isFinite(value)) throw new Error(`机器人关节 ${name} 派生值无效`);
    if (joint.type !== "continuous") value = Math.max(joint.limit?.lower ?? -Infinity, Math.min(joint.limit?.upper ?? Infinity, value));
    visiting.delete(name); result[name] = value; return value;
  };
  for (const name of joints.keys()) read(name);
  return result;
}

export function restoreAuthoredRobotPose(object: Object3D | undefined): boolean {
  const runtime = object && runtimes.get(object);
  return runtime ? writeRobotPose(object, runtime.authored, false, true) : false;
}

/** 几何兼容不足以保护关节控制引用，拓扑/单位语义发生变化必须拒绝。 */
export function assertRobotReplacementCompatible(previous: Object3D, candidate: Object3D): void {
  const before = runtimes.get(previous)?.definition, after = runtimes.get(candidate)?.definition;
  if (!before && !after) return;
  if (!before || !after) throw new Error("机器人与普通素材不能保引用互换，请新增实例");
  const semantic = (value: RobotAssetDefinition) => JSON.stringify({
    rootLink: value.rootLink,
    joints: [...value.joints].sort((a, b) => a.name.localeCompare(b.name)).map(({ name, type, parent, child, origin, axis, limit, mimic }) => ({
      name, type, parent, child, origin, axis, lower: limit?.lower, upper: limit?.upper, mimic,
    })),
  });
  if (semantic(before) !== semantic(after)) throw new Error("新素材的关节结构、轴向或限位不兼容；原实例未修改");
}
