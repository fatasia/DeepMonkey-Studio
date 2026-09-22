import { cameraFrustum } from "./pbrFrusta.js";
import type { RenderView } from "./pbrRendererTypes.js";
import type { PbrCameraProjection } from "./pbrFrameUniforms.js";
import type { PacketBuffers } from "./packetBuffers.js";

/** Frustum and LOD must use the same stable author camera and physical viewport. */
export function pbrVisibilityInput(view: RenderView, projection: PbrCameraProjection,
  width: number, height: number, cameraJump: boolean, lodDetailScale = 1) {
  if (!Number.isFinite(lodDetailScale) || lodDetailScale < 0.5 || lodDetailScale > 1) {
    throw new RangeError("LOD detail scale must be in [0.5,1].");
  }
  const frustum = cameraFrustum(view.eye, view.target, view.up, width / height, projection);
  const lodWidth = Math.max(1, Math.round(width * lodDetailScale));
  const lodHeight = Math.max(1, Math.round(height * lodDetailScale));
  const lod: Parameters<PacketBuffers["encodeLod"]>[1] = {
    camera: { projection: "perspective", position: view.eye,
      forward: [view.target[0] - view.eye[0], view.target[1] - view.eye[1], view.target[2] - view.eye[2]],
      verticalFovRadians: projection.verticalFovRadians, near: projection.near, far: projection.far },
    viewport: { width: lodWidth, height: lodHeight }, frustum, ...(view.lodBudget ? { budget: view.lodBudget } : {}), cameraJump,
  };
  return { frustum, lod };
}
