import * as THREE from "three";
import type { SceneMaterialState } from "@bim-studio/contracts";

const VIDEO_EVENTS = ["playing", "pause", "ended", "seeked", "loadeddata"];

/** 材质变化时收集，静态调度只检查少量动态材质，不逐帧遍历整场景。 */
export class ViewerMaterialActivity {
  private videos = new Set<HTMLVideoElement>();
  private uvMaterials: THREE.Material[] = [];
  private unknownDynamic = false;
  constructor(private readonly invalidate: () => void) {}

  refresh(scene: THREE.Scene): void {
    this.dispose();
    scene.traverseVisible(object => {
      if (object.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) this.unknownDynamic = true;
      const mesh = object as THREE.Mesh;
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) {
        if (material.userData.studioUvAnimation?.enabled) this.uvMaterials.push(material);
        // 未声明活动生命周期的自定义 Shader 保守连续运行。
        if ((material as THREE.ShaderMaterial).isShaderMaterial) this.unknownDynamic = true;
        for (const value of Object.values(material)) {
          if (!(value as THREE.VideoTexture | undefined)?.isVideoTexture) continue;
          const video = (value as THREE.VideoTexture).image as HTMLVideoElement | undefined;
          if (video?.addEventListener) this.videos.add(video);
        }
      }
    });
    for (const video of this.videos) for (const event of VIDEO_EVENTS) video.addEventListener(event, this.invalidate);
  }

  active(): boolean {
    if (this.unknownDynamic) return true;
    for (const video of this.videos) if (!video.paused && !video.ended) return true;
    return this.uvMaterials.some(material => {
      const animation = material.userData.studioUvAnimation as SceneMaterialState["uvAnimation"];
      return Boolean(animation?.enabled && (animation.loopMode !== "once" || Number(material.userData.studioUvAnimationElapsed ?? 0) < Math.max(.05, animation.durationSeconds ?? 5)));
    });
  }

  dispose(): void {
    for (const video of this.videos) for (const event of VIDEO_EVENTS) video.removeEventListener(event, this.invalidate);
    this.videos.clear(); this.uvMaterials = []; this.unknownDynamic = false;
  }
}
