import { describe, expect, it } from "vitest";
import { validateScene } from "./sceneValidation";

const scene = (patch: Record<string, unknown> = {}) => ({ id: "ssr", name: "SSR",
  camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } },
  models: [], primitives: [], measurements: [], postProcessing: { enabled: true, smaa: false,
    ssao: false, ssaoIntensity: 1, bloom: false, bloomStrength: .35, bloomThreshold: .9,
    screenSpaceReflection: true, ssrSteps: 64, ssrThickness: .02, ssrMaxDistance: 3, ...patch } });

describe("scene SSR author contract", () => {
  it("accepts bounded Deep SSR quality and rejects values outside the GPU contract", () => {
    expect(() => validateScene(scene(), "scene")).not.toThrow();
    expect(() => validateScene(scene({ ssrSteps: 64.5 }), "scene")).toThrow(/ssrSteps/);
    expect(() => validateScene(scene({ ssrThickness: 0.0009 }), "scene")).toThrow(/ssrThickness/);
    expect(() => validateScene(scene({ ssrMaxDistance: 4.1 }), "scene")).toThrow(/ssrMaxDistance/);
  });
});
