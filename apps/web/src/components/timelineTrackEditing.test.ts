import { describe, expect, it } from "vitest";
import { DEFAULT_ANIMATION } from "../appDefaults";
import { removeTimelineTrack } from "./timelineTrackEditing";

describe("timeline track deletion", () => {
  const camera = { id: "camera-1", time: 0, camera: { position: { x: 0, y: 1, z: 2 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" as const } };
  const transform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
  const animation = { ...DEFAULT_ANIMATION, camera: [camera], models: [
    { id: "a-1", modelId: "a", time: 0, transform },
    { id: "a-2", modelId: "a", time: 2, transform },
    { id: "b-1", modelId: "b", time: 0, transform },
  ] };

  it("removes the camera track without touching object tracks", () => {
    const next = removeTimelineTrack(animation, "camera");
    expect(next.camera).toEqual([]);
    expect(next.models).toHaveLength(3);
  });

  it("removes every frame from one object track only", () => {
    const next = removeTimelineTrack(animation, "model:a");
    expect(next.models.map(frame => frame.id)).toEqual(["b-1"]);
    expect(next.camera).toEqual([camera]);
  });
});
