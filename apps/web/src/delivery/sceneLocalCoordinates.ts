import type { SceneSnapshot } from "@bim-studio/contracts";
import { RUNTIME_COORDINATE_PROFILE } from "@bim-studio/deep-engine/runtime-package";

export interface SceneCoordinate { readonly x: number; readonly y: number; readonly z: number }
export const SCENE_LOCAL_COORDINATE_PROFILE = RUNTIME_COORDINATE_PROFILE;
export interface SceneLocalCoordinateFrame {
  readonly schemaVersion: 1;
  readonly profile: typeof SCENE_LOCAL_COORDINATE_PROFILE;
  readonly origin: SceneCoordinate;
}
const axes = ["x", "y", "z"] as const;

/** 容差以作者场景单位计；只约束根位置和相机，不证明几何、拾取或测量精度。 */
export function createSceneLocalFrame(scene: SceneSnapshot, origin?: SceneCoordinate): SceneLocalCoordinateFrame {
  const camera = scene.cameraViews?.find(view => view.id === scene.defaultCameraViewId)?.camera ?? scene.camera;
  finiteCoordinate(camera.target, "camera.target");
  const round = (value: number) => Math.round(value / SCENE_LOCAL_COORDINATE_PROFILE.originGrid) * SCENE_LOCAL_COORDINATE_PROFILE.originGrid;
  const anchor = origin ?? { x: round(camera.target.x), y: round(camera.target.y), z: round(camera.target.z) };
  finiteCoordinate(anchor, "origin");
  return Object.freeze({ schemaVersion: 1, profile: SCENE_LOCAL_COORDINATE_PROFILE,
    origin: Object.freeze({ x: cleanZero(anchor.x), y: cleanZero(anchor.y), z: cleanZero(anchor.z) }) });
}

export function worldToLocal(world: SceneCoordinate, origin: SceneCoordinate, path = "position"): SceneCoordinate {
  finiteCoordinate(world, path); finiteCoordinate(origin, "origin");
  const result = { x: 0, y: 0, z: 0 };
  for (const axis of axes) {
    const local = world[axis] - origin[axis];
    checkLocal(local, `${path}.${axis}`);
    checkRoundTrip(local + origin[axis], world[axis], `${path}.${axis}`);
    result[axis] = cleanZero(local);
  }
  return result;
}

export function localToWorld(local: SceneCoordinate, origin: SceneCoordinate, path = "position"): SceneCoordinate {
  finiteCoordinate(local, path); finiteCoordinate(origin, "origin");
  const result = { x: 0, y: 0, z: 0 };
  for (const axis of axes) {
    checkLocal(local[axis], `${path}.${axis}`);
    const world = local[axis] + origin[axis];
    if (!Number.isFinite(world)) throw new Error(`局部坐标 ${path}.${axis} 超出数值范围`);
    checkRoundTrip(world - origin[axis], local[axis], `${path}.${axis}`);
    result[axis] = cleanZero(world);
  }
  return result;
}

/** 原始快照留给源身份校验；局部副本仅用于静态编译，禁止回写作者数据。 */
export function localizeSceneCoordinates(input: SceneSnapshot, origin?: SceneCoordinate): { scene: SceneSnapshot; frame: SceneLocalCoordinateFrame } {
  const scene = structuredClone(input), frame = createSceneLocalFrame(scene, origin);
  for (const [kind, objects] of [["models", scene.models], ["primitives", scene.primitives]] as const) {
    for (const object of objects) {
      object.transform.position = worldToLocal(object.transform.position, frame.origin, `${kind}[${object.modelId}].position`);
    }
  }
  const camera = (value: SceneSnapshot["camera"], path: string) => {
    value.position = worldToLocal(value.position, frame.origin, `${path}.position`);
    value.target = worldToLocal(value.target, frame.origin, `${path}.target`);
  };
  camera(scene.camera, "camera");
  scene.cameraViews?.forEach((view, index) => camera(view.camera, `cameraViews[${index}].camera`));
  return { scene, frame };
}

function finiteCoordinate(value: SceneCoordinate, path: string): void {
  if (!value || axes.some(axis => !Number.isFinite(value[axis]))) throw new Error(`局部坐标 ${path} 必须为有限数值`);
}
function checkLocal(value: number, path: string): void {
  const rounded = Math.fround(value);
  if (!Number.isFinite(value) || !Number.isFinite(rounded)) throw new Error(`局部坐标 ${path} 超出 Float32 范围`);
  if (Math.abs(rounded - value) > SCENE_LOCAL_COORDINATE_PROFILE.maxFloat32CoordinateError) {
    throw new Error(`局部坐标 ${path} 的 Float32 误差超过 ${SCENE_LOCAL_COORDINATE_PROFILE.maxFloat32CoordinateError} 场景单位`);
  }
}
function checkRoundTrip(actual: number, expected: number, path: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > SCENE_LOCAL_COORDINATE_PROFILE.maxRoundTripError) {
    throw new Error(`局部坐标 ${path} 的往返误差超过 ${SCENE_LOCAL_COORDINATE_PROFILE.maxRoundTripError} 场景单位`);
  }
}
function cleanZero(value: number): number { return Object.is(value, -0) ? 0 : value; }
