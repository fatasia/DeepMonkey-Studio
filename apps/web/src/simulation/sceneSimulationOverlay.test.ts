import { describe, expect, it, vi } from "vitest";
import { Scene, type Line, type Group } from "three";
import { simulationOverlayPaths } from "./sceneSimulationOverlay";
import { createSimulationOverlayAdapter } from "../viewer/simulationOverlayAdapter";

describe("simulation overlay", () => {
  it("resolves primitive/model links, closes loop paths and skips broken/invalid input without mutation", () => {
    const points: Array<[number, number, number]> = [[0, 0, 0], [2, 0, 0]];
    const result = simulationOverlayPaths([
      { id: "flow", kind: "flowLink", fromModelId: "a", toModelId: "b" },
      { id: "path", kind: "path", targetModelId: "a", name: "路径", speed: 1, loopMode: "loop", points },
      { id: "broken", kind: "flowLink", fromModelId: "a", toModelId: "missing" },
      { id: "invalid", kind: "path", targetModelId: "a", name: "路径", speed: 1, loopMode: "once", points: [[NaN, 0, 0], [0, 1, 0]] },
    ], (id) => id === "missing" ? undefined : { x: id === "a" ? 0 : 2, y: 0, z: 0 });
    expect(result.map((item) => item.id)).toEqual(["flow", "path"]);
    expect(result[1]?.points).toEqual([...points, points[0]]);
    expect(points).toHaveLength(2);
  });

  it("replaces rather than accumulates lines and disposes all owned resources on close", () => {
    const scene = new Scene();
    const overlay = createSimulationOverlayAdapter(scene);
    overlay.replacePaths([{ id: "path", kind: "path", points: [[0, 0, 0], [1, 0, 0]] }]);
    const root = scene.children[0] as Group;
    const line = root.children[0] as Line;
    const geometryDispose = vi.spyOn(line.geometry, "dispose");
    const materialDispose = vi.spyOn(line.material as import("three").Material, "dispose");
    expect(root.name).toBe("helper:simulation-paths");
    overlay.replacePaths([]);
    expect(scene.children).toHaveLength(0);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    overlay.clear();
    expect(geometryDispose).toHaveBeenCalledOnce();
  });
});
