import * as THREE from "three";
import { snapshotPbrFog, type PbrFog } from "@bim-studio/deep-engine/webgpu";

/** Composer renders author fog into linear HDR before the final tone/display conversion. */
export function readStudioDeepFog(scene: THREE.Scene, composerActive: boolean): PbrFog | null {
  const fog = scene.fog;
  if (!fog) return null;
  if (!composerActive) throw new Error("Deep 尚未接入无后处理场景的显示域雾合成。");
  const color = [fog.color.r, fog.color.g, fog.color.b] as const;
  if (fog instanceof THREE.FogExp2) return snapshotPbrFog({ kind: "exp2", color, density: fog.density });
  if (fog instanceof THREE.Fog) return snapshotPbrFog({ kind: "linear", color, near: fog.near, far: fog.far });
  throw new Error("Deep 尚未接入此作者雾类型。");
}
