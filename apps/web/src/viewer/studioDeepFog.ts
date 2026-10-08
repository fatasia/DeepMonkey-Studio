import * as THREE from "three";
import { snapshotPbrFog, type PbrFog } from "@bim-studio/deep-engine/webgpu";

/** Snapshot author parameters; RenderView selects Composer or direct display-domain mixing. */
export function readStudioDeepFog(scene: THREE.Scene, _composerActive: boolean): PbrFog | null {
  const fog = scene.fog;
  if (!fog) return null;
  // RenderView.authorDirectDisplay selects the matching shader/output domain.
  const color = [fog.color.r, fog.color.g, fog.color.b] as const;
  if (fog instanceof THREE.FogExp2) return snapshotPbrFog({ kind: "exp2", color, density: fog.density });
  if (fog instanceof THREE.Fog) return snapshotPbrFog({ kind: "linear", color, near: fog.near, far: fog.far });
  throw new Error("Deep 尚未接入此作者雾类型。");
}
