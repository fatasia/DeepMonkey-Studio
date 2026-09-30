import { describe, expect, it } from "vitest";
import { validateSceneReflectionProbes } from "./sceneReflectionProbes.js";
import { validateScene } from "./sceneValidation.js";

const probe = { id: "probe-1", name: "Room", enabled: true, center: { x: 0, y: 2, z: 0 },
  halfExtents: { x: 3, y: 2, z: 4 }, blendDistance: 1, influenceRadius: 2 };
describe("persistent local reflection probes", () => {
  it("accepts legacy omission, explicit empty and two independently authored probes in the real scene validator", () => {
    const scene = { id: "s", name: "Room", models: [], primitives: [], measurements: [],
      camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
      environment: { gridVisible: true, backgroundColor: "#112233", skybox: "studio" } };
    expect(() => validateScene(scene, "scene")).not.toThrow();
    for (const reflectionProbes of [[], [probe, { ...probe, id: "probe-2", environmentMapUrl: "/hdr/room.hdr" }]]) {
      expect(() => validateScene({ ...scene, environment: { ...scene.environment, reflectionProbes } }, "scene")).not.toThrow();
    }
  });
  it("rejects over-budget, duplicate identity, nonfinite coordinates and invalid geometry", () => {
    for (const value of [[probe, { ...probe, id: "p2" }, { ...probe, id: "p3" }], [probe, probe],
      [{ ...probe, halfExtents: { x: 0, y: 2, z: 2 } }], [{ ...probe, center: { x: NaN, y: 0, z: 0 } }],
      [{ ...probe, blendDistance: -1 }], [{ ...probe, influenceRadius: Infinity }]]) {
      expect(() => validateSceneReflectionProbes(value, "probes")).toThrow();
    }
  });
});
