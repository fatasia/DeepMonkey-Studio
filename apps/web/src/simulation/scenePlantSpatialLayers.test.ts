import { describe, expect, it, vi } from "vitest";
import { Color, Scene, type LineSegments, type Mesh } from "three";
import type { PlantLiteModel } from "@bim-studio/contracts";
import type { PlantLitePlaybackFrame } from "../components/plantLitePlaybackModel";
import { createScenePlantSpatialLayers } from "../viewer/scenePlantSpatialLayers";

describe("scene waiting heat and recorded transport trail", () => {
  it("shows snapshot counts at real anchors, hides absent evidence, and clears/disposes all helpers", () => {
    const scene = new Scene();
    const model = { sceneBinding: { sceneId: "s", nodes: [{ nodeId: "q", objectId: "box", position: [2, 1, 3] }, { nodeId: "end", objectId: "sink", position: [10, 3, 7] }] } } as PlantLiteModel;
    const palette = { waiting: new Color("orange"), moving: new Color("gold"), completed: new Color("green") };
    const overlay = createScenePlantSpatialLayers(scene, model, palette);
    const heat = scene.getObjectByName("helper:simulation-waiting:q") as Mesh;
    const trail = scene.getObjectByName("helper:simulation-transport-trails") as LineSegments;
    const dispose = vi.spyOn(heat.geometry, "dispose");
    const frame = { items: [{ itemId: "one", nodeId: "q", transport: { toNodeId: "end", progress: .5 } }], waitingByNode: { q: 4, missing: 20 }, sceneLayers: { heatmap: true, trails: true } } as unknown as PlantLitePlaybackFrame;
    overlay.update(frame);
    expect(heat.visible).toBe(true); expect(heat.userData.waitingSampleCount).toBe(4);
    expect(heat.position.toArray()).toEqual([2, 1.05, 3]);
    expect(scene.getObjectByName("helper:simulation-waiting:missing")).toBeUndefined();
    expect([...trail.geometry.getAttribute("position").array].slice(0, 6)).toEqual([2, 1.25, 3, 6, 2.25, 5]);
    const attribute = trail.geometry.getAttribute("position"), radius = heat.scale.x;
    overlay.update({ ...frame, waitingByNode: { q: 1 } }); expect(heat.scale.x).toBeLessThan(radius);
    overlay.update(frame); expect(heat.scale.x).toBe(radius);
    expect(trail.geometry.getAttribute("position")).toBe(attribute);
    overlay.update({ ...frame, sceneLayers: { heatmap: false, trails: false } });
    expect(heat.visible).toBe(false); expect(trail.geometry.drawRange.count).toBe(0);
    overlay.update(null); expect(scene.children[0]?.visible).toBe(false);
    overlay.dispose(); expect(scene.children).toHaveLength(0); expect(dispose).toHaveBeenCalledOnce();
  });
});
