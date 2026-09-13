import type { SceneAnimationState } from "@bim-studio/contracts";

export type TimelineTrackId = "camera" | `model:${string}`;

export function removeTimelineTrack(animation: SceneAnimationState, trackId: TimelineTrackId): SceneAnimationState {
  return trackId === "camera"
    ? { ...animation, camera: [] }
    : { ...animation, models: animation.models.filter(frame => frame.modelId !== trackId.slice(6)) };
}
