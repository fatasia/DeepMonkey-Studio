import * as THREE from "three";
import type { RobotAssetDefinition, RobotJointDefinition, Vector3Value } from "@bim-studio/contracts";
import type { URDFJoint } from "urdf-loader";

/** 先按最大分量缩放，避免超大但有限的合法轴在 lengthSq 中溢出成零向量。 */
export function normalizedRobotAxis(axis: Vector3Value): THREE.Vector3 {
  const scale = Math.max(Math.abs(axis.x), Math.abs(axis.y), Math.abs(axis.z));
  if (!Number.isFinite(scale) || scale === 0) throw new Error("机器人关节轴向无效");
  const value = new THREE.Vector3(axis.x / scale, axis.y / scale, axis.z / scale);
  return value.divideScalar(Math.hypot(value.x, value.y, value.z));
}

/** 只规范化已验证的同一源字段；不重命名关节、不改变原文件字节。 */
export function normalizeUrdfJointAxes(document: Document, definition: RobotAssetDefinition): void {
  const joints = new Map(definition.joints.map(joint => [joint.name, joint]));
  for (const element of document.querySelectorAll("robot > joint")) {
    const joint = joints.get(element.getAttribute("name") ?? "");
    if (!joint) throw new Error("机器人关节不在资源清单中");
    const axis = normalizedRobotAxis(joint.axis);
    let node = [...element.children].find(child => child.nodeName === "axis");
    if (!node) { node = document.createElement("axis"); element.appendChild(node); }
    node.setAttribute("xyz", `${axis.x} ${axis.y} ${axis.z}`);
  }
}

export function assertLoadedRobotJoint(loaded: URDFJoint, joint: RobotJointDefinition): void {
  const axis = normalizedRobotAxis(joint.axis);
  const position = new THREE.Vector3(joint.origin.xyz.x, joint.origin.xyz.y, joint.origin.xyz.z);
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(joint.origin.rpy.x, joint.origin.rpy.y, joint.origin.rpy.z, "ZYX"));
  if (![...loaded.axis.toArray(), ...loaded.position.toArray(), ...loaded.quaternion.toArray()].every(Number.isFinite) ||
    loaded.axis.distanceTo(axis) > 1e-8 || loaded.position.distanceTo(position) > 1e-8 || loaded.quaternion.angleTo(rotation) > 1e-7 ||
    (joint.limit?.lower !== undefined && loaded.limit.lower !== joint.limit.lower) || (joint.limit?.upper !== undefined && loaded.limit.upper !== joint.limit.upper)) {
    throw new Error("机器人关节轴向、原点或限位与清单不一致");
  }
}
