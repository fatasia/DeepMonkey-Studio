import * as THREE from "three";
import type { ThreeObjectSource } from "@bim-studio/deep-engine/three-bridge";
import type { StudioDeepRenderView } from "./StudioDeepRenderView";
import type { ViewerEngine } from "./ViewerEngine";

export type BridgeModule = typeof import("@bim-studio/deep-engine/three-bridge");
export type BridgeModuleLoader = () => Promise<BridgeModule>;
export interface RuntimeSession {
  readonly state?: string;
  readonly diagnostics?: readonly { message: string }[];
  readonly onFatalLoss?: (listener: (reason: { readonly message: string }) => void) => () => void;
  readonly onDeviceRecreated?: (listener: (epoch: number) => void) => () => void;
  readonly device?: { readonly lost: Promise<{ readonly message: string; readonly reason: string }>;
    readonly queue?: { onSubmittedWorkDone(): Promise<void> } };
}

export type DeepRenderView = ReturnType<StudioDeepRenderView["renderViewDirect"]>;

export function cameraSnapshot(viewer: ViewerEngine): readonly number[] {
  const camera = viewer.camera, target = viewer.orbit.target;
  return [camera.position.x, camera.position.y, camera.position.z,
    target.x, target.y, target.z, camera.fov, camera.zoom, camera.near, camera.far,
    camera.up.x, camera.up.y, camera.up.z];
}

export function authorModelId(source: { userData?: Record<string, unknown>; parent?: unknown }): string | undefined {
  let current: { userData?: Record<string, unknown>; parent?: unknown } | undefined = source;
  for (let depth = 0; current && depth < 64; depth++) {
    const value = current.userData?.modelId;
    if (typeof value === "string" && value.length > 0) return value;
    current = current.parent as typeof current;
  }
  return undefined;
}

export function resolveAuthorWorldTransform(viewer: ViewerEngine, source: ThreeObjectSource): ArrayLike<number> | undefined {
  const modelId = authorModelId(source as unknown as { userData?: Record<string, unknown>; parent?: unknown });
  if (!modelId) return undefined;
  const model = viewer.listModels().find(candidate => candidate.id === modelId);
  const authored = viewer.getModelTransform(modelId);
  if (!model || !authored) return undefined;
  const root = model.object;
  root.updateWorldMatrix(true, true);
  const object = source as unknown as THREE.Object3D;
  object.updateWorldMatrix(true, false);
  const relative = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(object.matrixWorld);
  const authoredWorld = new THREE.Matrix4().compose(
    new THREE.Vector3(authored.position.x, authored.position.y, authored.position.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(authored.rotation.x, authored.rotation.y, authored.rotation.z)),
    new THREE.Vector3(authored.scale.x, authored.scale.y, authored.scale.z),
  );
  return authoredWorld.multiply(relative).elements;
}

export function sameSnapshot(a: readonly number[], b: readonly number[] | undefined, epsilon = 1e-6): boolean {
  return b !== undefined && a.length === b.length && a.every((value, index) => Math.abs(value - b[index]!) <= epsilon);
}

/** 呈现指纹:eye/target/尺寸/编辑辅助投影/灯光摘要的轻量序列。编辑辅助(选择
 * 盒/gizmo/测量线)的顶点校验和与灯光强度/颜色随场景状态变化,足以区分"同一
 * 画面"与"新状态";未纳入指纹的编辑仍由保底重同步与 settle 序列收敛。 */
export function renderViewFingerprint(view: DeepRenderView): string {
  const overlay = view.editorOverlay;
  let overlaySum = 0;
  if (overlay && "vertices" in overlay) {
    const vertices = overlay.vertices as ArrayLike<number>;
    for (let index = 0; index < vertices.length; index += 12) overlaySum += vertices[index]!;
  }
  const lights = view.lights;
  let lightsKey = "0";
  if (lights) {
    const digest: string[] = [];
    for (const light of lights.directional ?? []) digest.push(`${light.intensity?.toFixed(3)},${light.color?.map(v => v.toFixed(2)).join(".")}`);
    for (const light of lights.points ?? []) digest.push(`${light.intensity?.toFixed(3)}`);
    for (const light of lights.spots ?? []) digest.push(`${light.intensity?.toFixed(3)}`);
    lightsKey = digest.join(";");
  }
  return `${view.eye[0]},${view.eye[1]},${view.eye[2]},${view.target[0]},${view.target[1]},${view.target[2]},`
    + `${view.width}x${view.height}@${view.pixelRatio}|ov:${overlay ? overlay.revision : -1}:${overlaySum.toFixed(2)}|li:${lightsKey}`;
}

export function threePrototypeHooks() {
  return {
    objectBeforeRender: THREE.Object3D.prototype.onBeforeRender,
    objectAfterRender: THREE.Object3D.prototype.onAfterRender,
    objectBeforeShadow: THREE.Object3D.prototype.onBeforeShadow,
    objectAfterShadow: THREE.Object3D.prototype.onAfterShadow,
    materialBeforeRender: THREE.Material.prototype.onBeforeRender,
    materialBeforeCompile: THREE.Material.prototype.onBeforeCompile,
    materialProgramCacheKey: THREE.Material.prototype.customProgramCacheKey,
  };
}

export function nextFrame(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Renderer switch cancelled", "AbortError"));
  return new Promise((resolve, reject) => {
    const frame = requestAnimationFrame(() => { signal?.removeEventListener("abort", onAbort); resolve(); });
    const onAbort = () => { cancelAnimationFrame(frame); reject(new DOMException("Renderer switch cancelled", "AbortError")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
