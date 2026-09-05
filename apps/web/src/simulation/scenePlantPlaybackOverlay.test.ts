import { describe, expect, it, vi } from "vitest";
import { Scene, type Points } from "three";
import type { PlantLiteModel } from "@bim-studio/contracts";
import type { PlantLitePlaybackFrame } from "../components/plantLitePlaybackModel";
import { createScenePlantPlaybackOverlay } from "../viewer/scenePlantPlaybackOverlay";

describe("scene DES event overlay", () => {
  it("uses recorded scene anchors, reuses fixed buffers, clears empty frames and disposes without changing scene objects", () => {
    const scene = new Scene();
    const model = { sceneBinding: { sceneId: "scene", nodes: [{ nodeId: "q", objectId: "box", position: [2, 0, 3] }] } } as PlantLiteModel;
    const overlay = createScenePlantPlaybackOverlay(scene, model);
    const points = scene.children[0] as Points;
    const dispose = vi.spyOn(points.geometry, "dispose");
    const frame = { items: [{ itemId: "one", nodeId: "q", state: "queued", lane: 0 }] } as PlantLitePlaybackFrame;
    overlay.update(frame);
    expect(points.name).toBe("helper:simulation-playback");
    expect([...points.geometry.getAttribute("position").array].slice(0, 3)).toEqual([2, .25, 3]);
    expect(points.geometry.drawRange.count).toBe(1);
    overlay.update(null); expect(points.geometry.drawRange.count).toBe(0);
    overlay.dispose(); expect(scene.children).toHaveLength(0); expect(dispose).toHaveBeenCalledOnce();
  });
});
