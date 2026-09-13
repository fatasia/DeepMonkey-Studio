import type * as THREE from "three";
import type { ScenePostProcessingState } from "@bim-studio/contracts";
import type { RendererInstance } from "./viewerRendererTypes";

export type OffscreenJson = Record<string, unknown>;
export type OffscreenImage = { uuid: string; bitmap?: ImageBitmap; pixels?: { data: THREE.TypedArray; width: number; height: number } };
export type OffscreenSnapshot = { json: OffscreenJson; images: OffscreenImage[] };
export type OffscreenObjectFrame = { uuid: string; matrix: number[]; visible: boolean; layers: number; renderOrder: number };
export type OffscreenFrame = {
  sequence: number; width: number; height: number; pixelRatio: number; delta: number;
  camera: { matrix: number[]; projection: number[]; near: number; far: number; fov: number; aspect: number };
  objects: OffscreenObjectFrame[]; materials: OffscreenJson[];
  postProcessing: ScenePostProcessingState; outlined: string[];
  renderer: { outputColorSpace: string; toneMapping: number; exposure: number; shadowEnabled: boolean; shadowType: number; clearColor: number; clearAlpha: number };
};
export type OffscreenContext = {
  scene: THREE.Scene; camera: THREE.PerspectiveCamera; renderer: RendererInstance;
  width: number; height: number; delta: number; postProcessing: ScenePostProcessingState; outlined: string[];
  fallbackReason?: string;
};
export type OffscreenRequest = { type: "init"; canvas: OffscreenCanvas; snapshot: OffscreenSnapshot; frame: OffscreenFrame }
  | { type: "frame"; frame: OffscreenFrame } | { type: "dispose" };
/** bitmap 由 Worker 的 OffscreenCanvas 提交后转移给主线程覆盖画布；reason 约定 "scene-stale" 表示结构漂移可静默重启。 */
export type OffscreenResponse = { type: "ready" }
  | { type: "frame"; sequence: number; drawCalls: number; triangles: number; renderMs: number; bitmap: ImageBitmap }
  | { type: "error"; reason: string };

/** 浏览器与运行环境是否具备后台渲染的最低能力；缺失时 UI 提示具体原因而不是静默空开关。 */
export function offscreenEnvironmentSupported(): boolean {
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined"
    && typeof createImageBitmap === "function" && typeof HTMLCanvasElement !== "undefined";
}
