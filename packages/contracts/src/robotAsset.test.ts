import { describe, expect, it } from "vitest";
import { assertRobotPose } from "./robotAsset.js";
import { supportedExtensions } from "./project.js";
import { validateScene } from "./sceneValidation.js";

describe("robot asset contracts", () => {
  it("accepts named finite SI poses without changing values", () => {
    const pose = { shoulder: Math.PI / 2, linear: .03 };
    assertRobotPose(pose);
    expect(pose).toEqual({ shoulder: Math.PI / 2, linear: .03 });
    expect(supportedExtensions).toEqual(expect.arrayContaining(["urdf", "zip"]));
  });
  it.each([null, [], { joint: Infinity }, { joint: "1" }, { "": 0 }, JSON.parse('{"__proto__":1}'), { constructor: 1 }, Object.create({ inherited: 1 })])("rejects invalid pose %j", pose => {
    expect(() => assertRobotPose(pose)).toThrow("robotPose");
  });
  it("rejects accessors without executing them, symbols, control names and over-budget joint sets", () => {
    const getter = { get joint() { throw new Error("getter executed"); } };
    expect(() => assertRobotPose(getter)).toThrow("普通关节数值");
    for (const pose of [{ [Symbol("hidden")]: 1 }, { "a\nb": 1 }, Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`joint-${i}`, 0]))]) expect(() => assertRobotPose(pose)).toThrow("robotPose");
  });
  it("validates scene persistence of URDF/ZIP models with SI pose and rejects unsafe poses", () => {
    const scene = { id: "robot-scene", name: "机器人", camera: { position: { x: 2, y: 2, z: 2 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
      models: [{ modelId: "instance", assetId: "asset", name: "arm", format: "urdf", visible: true, opacity: 1,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, robotPose: { shoulder: .5, slide: .02 } }], primitives: [], measurements: [] };
    expect(() => validateScene(scene, "scene")).not.toThrow();
    const restored = JSON.parse(JSON.stringify(scene)); restored.models[0].format = "zip";
    expect(() => validateScene(restored, "scene")).not.toThrow();
    expect(restored.models[0].robotPose).toEqual({ shoulder: .5, slide: .02 });
    restored.models[0].robotPose = JSON.parse('{"__proto__":1}');
    expect(() => validateScene(restored, "scene")).toThrow("robotPose");
  });
});
