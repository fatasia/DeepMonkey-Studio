import { describe, expect, it } from "vitest";
import { validateScene } from "./sceneValidation";

const scene = (type: "spot" | "point", softness: number) => ({ id: "shadow", name: "Shadow",
  camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } },
  models: [], primitives: [], measurements: [], lighting: { enabled: true, intensity: 1, lights: [{ id: "local",
    name: "Local", type, enabled: true, color: "#ffffff", intensity: 1, castShadow: true,
    position: { x: 0, y: 4, z: 0 }, target: { x: 0, y: 0, z: 0 }, shadowSoftness: softness }] } });

describe("scene local shadow author contract", () => {
  it("accepts bounded spot PCSS softness and rejects unsupported lights or values", () => {
    expect(() => validateScene(scene("spot", 0.75), "scene")).not.toThrow();
    expect(() => validateScene(scene("spot", 1.1), "scene")).toThrow(/shadowSoftness/);
    expect(() => validateScene(scene("point", 0.5), "scene")).toThrow(/仅支持聚光灯/);
  });
});
