import { cameraFrustum } from "./pbrFrusta.js";
import type { RenderView } from "./pbrRendererTypes.js";
import type { PbrCameraProjection } from "./pbrFrameUniforms.js";
import type { PacketBuffers } from "./packetBuffers.js";

/** Frustum and LOD must use the same stable author camera and physical viewport. */
export function pbrVisibilityInput(view: RenderView, projection: PbrCameraProjection,
  width: number, height: number, cameraJump: boolean) {
  const frustum = cameraFrustum(view.eye, view.target, view.up, width / height, projection);
  const lod: Parameters<PacketBuffers["encodeLod"]>[1] = {
    camera: { projection: "perspective", position: view.eye,
      forward: [view.target[0] - view.eye[0], view.target[1] - view.eye[1], view.target[2] - view.eye[2]],
      verticalFovRadians: projection.verticalFovRadians, near: projection.near, far: projection.far },
    viewport: { width, height }, frustum, ...(view.lodBudget ? { budget: view.lodBudget } : {}), cameraJump,
  };
  return { frustum, lod };
}
