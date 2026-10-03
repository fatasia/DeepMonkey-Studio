import { describe, expect, it } from "vitest";
import { validateScene } from "./sceneValidation.js";
const scene = { id: "rays", name: "Room", models: [], primitives: [], measurements: [],
  camera: { position: { x: 0, y: 0, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
  postProcessing: { enabled: true, smaa: false, ssao: false, ssaoIntensity: 1, bloom: false, bloomStrength: .3, bloomThreshold: .9 } };
describe("persistent volumetric light author values", () => {
  it("accepts old scenes, zero and inclusive strength cap with the existing fog profile", () => {
    expect(() => validateScene(scene, "scene")).not.toThrow();
    for (const strength of [0, 1, 8]) expect(() => validateScene({ ...scene, postProcessing: { ...scene.postProcessing,
      volumetricFog: true, volumetricGodRays: true, volumetricGodRaysStrength: strength } }, "scene")).not.toThrow();
  });
  it("bounds the fog scatter albedo to [0,1] and keeps old scenes valid", () => {
    for (const albedo of [0, 0.82, 1]) expect(() => validateScene({ ...scene, postProcessing: { ...scene.postProcessing,
      volumetricFog: true, volumetricFogAlbedo: albedo } }, "scene")).not.toThrow();
    for (const albedo of [-0.1, 1.1, Infinity, NaN]) expect(() => validateScene({ ...scene,
      postProcessing: { ...scene.postProcessing, volumetricFogAlbedo: albedo } }, "scene")).toThrow();
  });
  it("rejects nonfinite/out-of-budget strength and nonboolean activation", () => {
    for (const strength of [-1, 8.1, Infinity, NaN]) expect(() => validateScene({ ...scene,
      postProcessing: { ...scene.postProcessing, volumetricGodRaysStrength: strength } }, "scene")).toThrow();
    expect(() => validateScene({ ...scene, postProcessing: { ...scene.postProcessing, volumetricGodRays: 1 } }, "scene")).toThrow();
  });
});
