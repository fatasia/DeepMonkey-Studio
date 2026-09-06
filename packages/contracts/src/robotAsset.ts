import type { Vector3Value } from "./geometry.js";

export const ROBOT_IMPORT_LIMITS = {
  compressedBytes: 128 * 1024 * 1024,
  maxEntries: 2048,
  expandedBytes: 256 * 1024 * 1024,
  entryBytes: 64 * 1024 * 1024,
  xmlBytes: 8 * 1024 * 1024,
  maxJoints: 512,
} as const;

/** URDF 的长度/平移为 m，转角为 rad；资源结构与场景实例姿态分开保存。 */
export interface RobotOrigin { xyz: Vector3Value; rpy: Vector3Value }
export interface RobotMaterialDefinition {
  name?: string;
  color?: [number, number, number, number];
  texture?: { filename: string; resolvedPath: string };
}
export type RobotGeometryDefinition =
  | { type: "mesh"; filename: string; resolvedPath: string; scale: Vector3Value }
  | { type: "box"; size: Vector3Value }
  | { type: "sphere"; radius: number }
  | { type: "cylinder"; radius: number; length: number };
export interface RobotVisualDefinition {
  name?: string;
  origin: RobotOrigin;
  geometry: RobotGeometryDefinition;
  material?: RobotMaterialDefinition;
}
export interface RobotLinkDefinition {
  name: string;
  visuals: RobotVisualDefinition[];
  collisions: RobotVisualDefinition[];
  inertial?: { origin: RobotOrigin; mass: number; ixx: number; ixy: number; ixz: number; iyy: number; iyz: number; izz: number };
}
export interface RobotJointDefinition {
  name: string;
  type: "fixed" | "revolute" | "continuous" | "prismatic";
  parent: string;
  child: string;
  origin: RobotOrigin;
  axis: Vector3Value;
  limit?: { lower?: number; upper?: number; effort?: number; velocity?: number };
  mimic?: { joint: string; multiplier: number; offset: number };
}
export interface RobotResourceEvidence { path: string; size: number; sha256: string }
export interface RobotAssetDefinition {
  schemaVersion: 1;
  name: string;
  entryPath: string;
  rootLink: string;
  links: RobotLinkDefinition[];
  joints: RobotJointDefinition[];
  materials: RobotMaterialDefinition[];
  resources: RobotResourceEvidence[];
}

export function assertRobotPose(value: unknown, path = "robotPose"): asserts value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${path} 必须是关节 SI 值对象`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.values(descriptors).some(item => !Object.hasOwn(item, "value"))) throw new Error(`${path} 必须使用普通关节数值属性`);
  const entries = Object.entries(value);
  if (entries.length > ROBOT_IMPORT_LIMITS.maxJoints) throw new Error(`${path} 关节数量超过 ${ROBOT_IMPORT_LIMITS.maxJoints}`);
  for (const [name, position] of entries) {
    if (!name.trim() || name.length > 180 || /[\u0000-\u001f]/.test(name) || ["__proto__", "prototype", "constructor"].includes(name) ||
      typeof position !== "number" || !Number.isFinite(position)) throw new Error(`${path}.${name} 必须是有效关节名称与有限 SI 数值`);
  }
}
