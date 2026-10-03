import {
  WORLD_LIMITS,
  canonicalJson,
  type WorldBodyType,
  type WorldColliderSpec,
  type WorldSnapshotObject,
  type WorldVec3,
} from "@bim-studio/contracts";
import { WorldRuntimeError, sha256Hex } from "./worldMath.js";

/** 与 apps/web primitiveGeometry.ts 的基础几何同尺寸（单位缩放下）；torus/plane 取包围盒近似。 */
const PRIMITIVE_COLLIDERS: Record<string, WorldColliderSpec> = {
  box: { shape: "cuboid", halfExtents: [1, 1, 1] },
  sphere: { shape: "ball", radius: 1 },
  cylinder: { shape: "cylinder", halfHeight: 1, radius: 1 },
  cone: { shape: "cone", halfHeight: 1, radius: 1 },
  capsule: { shape: "capsule", halfHeight: 0.7, radius: 0.65 },
  torus: { shape: "cuboid", halfExtents: [1.32, 0.32, 1.32] },
  plane: { shape: "cuboid", halfExtents: [1.5, 0.005, 1.5] },
};

export const WORLD_PRIMITIVE_KINDS = Object.keys(PRIMITIVE_COLLIDERS);
/** 与 Viewer 一致：碰撞体半尺寸下限，避免零厚度退化。 */
const MIN_HALF_EXTENT = 0.01;
/** Viewer 对动态刚体的固定阻尼与 CCD；无头世界保持同值，行为可对拍。 */
export const DYNAMIC_LINEAR_DAMPING = 0.08;
export const DYNAMIC_ANGULAR_DAMPING = 0.12;
export const DEFAULT_GRAVITY: WorldVec3 = [0, -9.81, 0];
const BODY_TYPES: readonly WorldBodyType[] = ["none", "fixed", "dynamic", "kinematic"];

export function primitiveBaseCollider(kind: string): WorldColliderSpec | undefined {
  return PRIMITIVE_COLLIDERS[kind];
}

/**
 * 基础形状 × 缩放。径向轴非均匀缩放时取径向最大值（包围近似，保守不漏碰）；
 * 与 Viewer 一律使用世界包围盒 cuboid 的做法相比，解析形状更贴合且仍然确定。
 */
export function scaleCollider(base: WorldColliderSpec, scale: WorldVec3): WorldColliderSpec {
  const [sx, sy, sz] = [Math.abs(scale[0]), Math.abs(scale[1]), Math.abs(scale[2])];
  const clamp = (value: number) => Math.max(value, MIN_HALF_EXTENT);
  switch (base.shape) {
    case "cuboid":
      return { shape: "cuboid", halfExtents: [clamp(base.halfExtents[0] * sx), clamp(base.halfExtents[1] * sy), clamp(base.halfExtents[2] * sz)] };
    case "ball":
      return { shape: "ball", radius: clamp(base.radius * Math.max(sx, sy, sz)) };
    default:
      return { shape: base.shape, halfHeight: clamp(base.halfHeight * sy), radius: clamp(base.radius * Math.max(sx, sz)) };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function vec(value: unknown, fallback: WorldVec3, field: string): WorldVec3 {
  if (value === undefined) return fallback;
  const input = record(value);
  const values = input ? [input.x, input.y, input.z] : Array.isArray(value) ? value : [];
  if (values.length !== 3 || values.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new WorldRuntimeError("invalid-scene", `${field} 必须是 {x,y,z} 有限数`);
  }
  return [values[0] as number, values[1] as number, values[2] as number];
}

function number(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new WorldRuntimeError("invalid-scene", `${field} 必须是有限数`);
  return value;
}

function primitiveCollider(value: unknown, field: string): WorldColliderSpec {
  const input = record(value);
  const radius = number(input?.radius, 0, `${field}.radius`);
  switch (input?.shape) {
    case "cuboid": return { shape: "cuboid", halfExtents: vec(input.halfExtents, [0, 0, 0], `${field}.halfExtents`) };
    case "sphere": return { shape: "ball", radius };
    case "cylinder": return { shape: "cylinder", radius, halfHeight: number(input.halfHeight, 0, `${field}.halfHeight`) };
    default: throw new WorldRuntimeError("invalid-scene", `${field}.shape 必须是 cuboid/sphere/cylinder`);
  }
}

export interface ParsedScene {
  sceneId: string;
  gravity: WorldVec3;
  objects: WorldSnapshotObject[];
  /** reset 时一次性施加的 initialLinearVelocity（不进入持续状态）。 */
  initialVelocities: Map<string, WorldVec3>;
}

/** SceneSnapshot → 无头世界对象表。只读取物理相关字段；缺失碰撞体的带刚体模型 fail-closed。 */
export function parseSceneObjects(scene: Record<string, unknown>): ParsedScene {
  const sceneId = scene.id as string;
  const physics = record(scene.physics);
  const gravity = vec(physics?.gravity, DEFAULT_GRAVITY, "scene.physics.gravity");
  const objects: WorldSnapshotObject[] = [];
  const initialVelocities = new Map<string, WorldVec3>();
  const seen = new Set<string>();
  const entries = [
    ...((scene.primitives as unknown[] | undefined) ?? []).map((item) => ({ item, source: "primitive" as const })),
    ...((scene.models as unknown[] | undefined) ?? []).map((item) => ({ item, source: "model" as const })),
  ];
  for (const { item, source } of entries) {
    const model = record(item);
    const id = model?.modelId;
    if (typeof id !== "string" || id.length === 0 || id.length > WORLD_LIMITS.maxIdLength || id.startsWith("@")) {
      throw new WorldRuntimeError("invalid-scene", `物体 modelId 必须是不以 @ 开头的 1..${WORLD_LIMITS.maxIdLength} 字符串`);
    }
    if (seen.has(id)) throw new WorldRuntimeError("invalid-scene", `物体 id 重复：${id}`);
    seen.add(id);
    const kind = source === "primitive" ? String(model?.kind) : "model";
    const body = record(model?.physics);
    const type = (body?.type ?? "none") as WorldBodyType;
    if (!BODY_TYPES.includes(type)) throw new WorldRuntimeError("invalid-scene", `${id}.physics.type 非法：${String(body?.type)}`);
    let collider: WorldColliderSpec | null;
    if (source === "primitive") {
      collider = primitiveBaseCollider(kind) ?? null;
      if (!collider) throw new WorldRuntimeError("invalid-scene", `${id} 的基础体类型不受支持：${kind}`);
    } else {
      const spec = record(body?.collider);
      collider = spec?.kind === "primitive" ? primitiveCollider(spec.primitive, `${id}.physics.collider.primitive`) : null;
      if (type !== "none" && !collider) {
        throw new WorldRuntimeError("invalid-scene", `模型 ${id} 带刚体但没有 primitive 碰撞体：无头世界没有网格，请在 physics.collider 声明 kind=primitive`);
      }
    }
    const transform = record(model?.transform);
    objects.push({
      id,
      kind,
      source,
      name: typeof model?.name === "string" ? model.name : id,
      visible: model?.visible !== false,
      body: {
        type,
        mass: number(body?.mass, 1, `${id}.physics.mass`),
        friction: number(body?.friction, 0.5, `${id}.physics.friction`),
        restitution: number(body?.restitution, 0, `${id}.physics.restitution`),
      },
      transform: {
        position: vec(transform?.position, [0, 0, 0], `${id}.transform.position`),
        rotation: vec(transform?.rotation, [0, 0, 0], `${id}.transform.rotation`),
        scale: vec(transform?.scale, [1, 1, 1], `${id}.transform.scale`),
      },
      collider,
      handle: null,
    });
    if (type === "dynamic" && body?.initialLinearVelocity !== undefined) {
      initialVelocities.set(id, vec(body.initialLinearVelocity, [0, 0, 0], `${id}.physics.initialLinearVelocity`));
    }
  }
  if (objects.length > WORLD_LIMITS.maxObjects) throw new WorldRuntimeError("limit-exceeded", `场景物体数 ${objects.length} 超过上限 ${WORLD_LIMITS.maxObjects}`);
  return { sceneId, gravity, objects, initialVelocities };
}

/** 场景语义哈希：只覆盖物理相关投影（id、重力、对象初始状态），不受缩略图等无关字段影响。 */
export function sceneSemanticHash(parsed: ParsedScene, ground: boolean): string {
  return sha256Hex(canonicalJson({ sceneId: parsed.sceneId, gravity: parsed.gravity, ground, objects: parsed.objects }));
}
