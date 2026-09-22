import { describe, expect, it } from "vitest";
import { validateScene } from "./sceneValidation.js";

const scene = { id: "scene", name: "Scene", camera: { mode: "orbit", position: { x: 0, y: 0, z: 5 }, target: { x: 0, y: 0, z: 0 } }, models: [], primitives: [], measurements: [] };
describe("root directory order contract", () => {
  it("accepts missing order and distinct typed references sharing an id", () => {
    expect(() => validateScene(scene, "scene")).not.toThrow();
    expect(() => validateScene({ ...scene, rootLayerOrder: [{ kind: "object", id: "same" }, { kind: "group", id: "same" }] }, "scene")).not.toThrow();
  });
  it.each([
    null, {}, ["object:pump"], [{ kind: "unknown", id: "pump" }], [{ kind: "object", id: " " }],
    [{ kind: "object", id: 12 }], [{ kind: "object", id: "pump", transform: {} }],
    [{ kind: "object", id: "pump" }, { kind: "object", id: "pump" }],
  ])("rejects malformed or duplicate references: %j", rootLayerOrder => {
    expect(() => validateScene({ ...scene, rootLayerOrder }, "scene")).toThrow();
  });
});
