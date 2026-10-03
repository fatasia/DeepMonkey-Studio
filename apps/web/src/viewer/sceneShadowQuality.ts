import * as THREE from "three";
import { DEFAULT_DISPLAY_CONTRACT } from "@bim-studio/contracts";

/**
 * 为默认工业场景提供柔和但可辨识的接触阴影。
 * 阴影强度独立于模型材质，避免浅色地面出现大片纯黑投影。
 */
export function configureDirectionalShadow(light: THREE.DirectionalLight): void {
  // Z1.5 尾巴：作者视图（WebGL 回退）默认场景阴影与 Deep 档位兜底对齐到 2048，
  // 零配置口径下作者视图不再比 Deep 路径糊一档。
  light.shadow.mapSize.set(DEFAULT_DISPLAY_CONTRACT.shadow.mapSize, DEFAULT_DISPLAY_CONTRACT.shadow.mapSize);
  light.shadow.camera.near = 0.1;
  light.shadow.camera.far = 300;
  light.shadow.camera.updateProjectionMatrix();
  light.shadow.intensity = 0.38;
  light.shadow.radius = DEFAULT_DISPLAY_CONTRACT.shadow.radius;
  light.shadow.blurSamples = DEFAULT_DISPLAY_CONTRACT.shadow.blurSamples;
  light.shadow.bias = DEFAULT_DISPLAY_CONTRACT.shadow.bias;
  light.shadow.normalBias = DEFAULT_DISPLAY_CONTRACT.shadow.normalBias;
}
