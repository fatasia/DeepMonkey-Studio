import { describe, expect, it } from "vitest";
import { validateScene } from "./sceneValidation.js";

const scene = { id: "s", name: "Room", models: [], primitives: [], measurements: [],
  camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
  environment: { gridVisible: true, backgroundColor: "#112233", skybox: "studio" } };
describe("saved Deep environment mip policy", () => {
  it("accepts omission and every saved chain-tail count", () => {
    expect(() => validateScene(scene, "scene")).not.toThrow();
    for (let environmentSpecularMips = 1; environmentSpecularMips <= 8; environmentSpecularMips++) {
      expect(() => validateScene({ ...scene, environment: { ...scene.environment, environmentSpecularMips } }, "scene")).not.toThrow();
    }
  });
  it.each([0, 9, -1, 1.5, NaN, Infinity, "4", null])("rejects count %s", environmentSpecularMips => {
    expect(() => validateScene({ ...scene, environment: { ...scene.environment, environmentSpecularMips } }, "scene")).toThrow("environmentSpecularMips");
  });
});
