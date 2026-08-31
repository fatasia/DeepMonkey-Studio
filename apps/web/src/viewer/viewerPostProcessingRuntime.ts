import type * as THREE from "three";
import type { ScenePostProcessingState } from "@bim-studio/contracts";

/** WebGL Composer 与 WebGPU TSL 管线共享的最小生命周期契约。 */
export interface ViewerPostProcessingRuntime {
  apply(state: ScenePostProcessingState, outlinedObjects: THREE.Object3D[]): void;
  /** 场景短暂清空时解除对象引用，但保留已编译管线等待下一场景复用。 */
  suspend(): void;
  setPixelRatio(value: number): void;
  setSize(width: number, height: number): void;
  render(delta: number): void;
  dispose(): void;
}
