import { describe, expect, it } from "vitest";
import { normalizeSceneCoordinates, projectToWorld, worldToProject } from "./sceneCoordinates";

describe("scene coordinates", () => {
  it("round trips Z-up left-handed millimetres through canonical Y-up metres", () => {
    const system = normalizeSceneCoordinates({ unit: "mm", upAxis: "z", handedness: "left", origin: { x: 10, y: 2, z: -3 }, epsg: "EPSG:4547" });
    const project = { x: 1_200, y: -800, z: 3_500 };
    const world = projectToWorld(project, system);
    const restored = worldToProject(world, system);
    expect(restored.x).toBeCloseTo(project.x);
    expect(restored.y).toBeCloseTo(project.y);
    expect(restored.z).toBeCloseTo(project.z);
  });
});
