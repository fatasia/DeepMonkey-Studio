import type { SceneCharacterControllerState } from "@bim-studio/contracts";
import type Rapier from "@dimforge/rapier3d-compat";
import type { Collider, KinematicCharacterController, RigidBody, World } from "@dimforge/rapier3d-compat";

/** 归一化后的角色控制器参数；字段为 `undefined` 表示交给 Rapier 默认值。 */
export interface NormalizedCharacterController {
  readonly offset: number;
  readonly maxSlopeClimbAngle: number;
  readonly minSlopeSlideAngle: number;
  readonly autostep?: { readonly maxHeight: number; readonly minWidth: number; readonly includeDynamicBodies: boolean };
  readonly snapToGround?: { readonly distance: number };
}

export interface MountedRapierCharacter {
  readonly controller: KinematicCharacterController;
  readonly collider: Collider;
}

/** Rapier 的默认值（0.19.3 实测）：偏移 0.01、坡度 45°、自动台阶关闭、贴地 0.2。 */
export const RAPIER_CHARACTER_DEFAULTS = Object.freeze({
  offset: 0.01,
  maxSlopeClimbAngle: Math.PI / 4,
  minSlopeSlideAngle: Math.PI / 4,
  autostepMaxHeight: 0.3,
  autostepMinWidth: 0.2,
  snapToGroundDistance: 0.2,
} as const);

const HALF_PI = Math.PI / 2;
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(finite(value, min), min), max);

/**
 * 归一化作者参数。非法值（NaN/Infinity/越界）一律回落到 Rapier 默认，而不是抛错：
 * 物理参数是运行时手感配置，编辑器已由 `sceneValidation` 把关，这里只保证世界构建不炸。
 */
export function normalizeCharacterController(state: SceneCharacterControllerState | undefined): NormalizedCharacterController {
  const source = state ?? {};
  const autostep = source.autostep;
  const snapToGround = source.snapToGround;
  return {
    offset: clamp(source.offset ?? RAPIER_CHARACTER_DEFAULTS.offset, 1e-4, 10),
    maxSlopeClimbAngle: clamp(source.maxSlopeClimbAngle ?? RAPIER_CHARACTER_DEFAULTS.maxSlopeClimbAngle, 0, HALF_PI),
    minSlopeSlideAngle: clamp(source.minSlopeSlideAngle ?? RAPIER_CHARACTER_DEFAULTS.minSlopeSlideAngle, 0, HALF_PI),
    ...(autostep?.enabled ? { autostep: {
      maxHeight: clamp(autostep.maxHeight ?? RAPIER_CHARACTER_DEFAULTS.autostepMaxHeight, 1e-3, 10),
      minWidth: clamp(autostep.minWidth ?? RAPIER_CHARACTER_DEFAULTS.autostepMinWidth, 1e-3, 10),
      includeDynamicBodies: Boolean(autostep.includeDynamicBodies),
    } } : {}),
    ...(snapToGround?.enabled ? { snapToGround: {
      distance: clamp(snapToGround.distance ?? RAPIER_CHARACTER_DEFAULTS.snapToGroundDistance, 1e-3, 10),
    } } : {}),
  };
}

/** 把归一化参数落到 Rapier 控制器实例上。关闭的可选特性必须显式 disable，否则会继承引擎默认。 */
export function configureCharacterController(
  controller: KinematicCharacterController,
  state: SceneCharacterControllerState | undefined,
): NormalizedCharacterController {
  const normalized = normalizeCharacterController(state);
  controller.setOffset(normalized.offset);
  controller.setMaxSlopeClimbAngle(normalized.maxSlopeClimbAngle);
  controller.setMinSlopeSlideAngle(normalized.minSlopeSlideAngle);
  if (normalized.autostep) controller.enableAutostep(normalized.autostep.maxHeight, normalized.autostep.minWidth, normalized.autostep.includeDynamicBodies);
  else controller.disableAutostep();
  if (normalized.snapToGround) controller.enableSnapToGround(normalized.snapToGround.distance);
  else controller.disableSnapToGround();
  // 默认不对 dynamic 刚体施加冲量：角色推箱子会改变既有动力学结果，必须由作者显式开启。
  controller.setApplyImpulsesToDynamicBodies(false);
  return normalized;
}

/** 为一个已建好的刚体挂角色控制器。offset 在构造时固定，后续用 setOffset 覆盖为作者值。 */
export function mountRapierCharacterController(
  world: World,
  collider: Collider,
  state: SceneCharacterControllerState | undefined,
): MountedRapierCharacter {
  const controller = world.createCharacterController(RAPIER_CHARACTER_DEFAULTS.offset);
  configureCharacterController(controller, state);
  return { controller, collider };
}

/** 移除控制器；Rapier 的 controller 是独立对象，不随刚体释放。 */
export function removeMountedRapierCharacter(world: World, mounted: MountedRapierCharacter): void {
  world.removeCharacterController(mounted.controller);
}

/** 计算当前物理步允许的位移；只排队下一位姿，不推进世界时钟。 */
export function moveRapierCharacter(mounted: MountedRapierCharacter, body: RigidBody, delta: { x: number; y: number; z: number }): { movement: { x: number; y: number; z: number }; grounded: boolean } {
  if (![delta.x, delta.y, delta.z].every(Number.isFinite)) throw new Error("角色位移必须是有限数值");
  if (!body.isKinematic() || mounted.collider.parent()?.handle !== body.handle) throw new Error("角色控制器与 kinematic 刚体不匹配");
  mounted.controller.computeColliderMovement(mounted.collider, delta);
  const movement = mounted.controller.computedMovement();
  const position = body.translation();
  body.setNextKinematicTranslation({ x: position.x + movement.x, y: position.y + movement.y, z: position.z + movement.z });
  return { movement, grounded: mounted.controller.computedGrounded() };
}

export type { Rapier };
