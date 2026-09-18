import * as THREE from "three";

/**
 * 为默认工业场景提供柔和但可辨识的接触阴影。
 * 阴影强度独立于模型材质，避免浅色地面出现大片纯黑投影。
 */
export function configureDirectionalShadow(light: THREE.DirectionalLight): void {
  light.shadow.mapSize.set(1_024, 1_024);
  light.shadow.camera.near = 0.1;
  light.shadow.camera.far = 300;
  light.shadow.camera.updateProjectionMatrix();
  light.shadow.intensity = 0.38;
  light.shadow.radius = 3;
  light.shadow.blurSamples = 8;
  light.shadow.bias = -0.0001;
  light.shadow.normalBias = 0.015;
}
