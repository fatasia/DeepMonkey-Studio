import type { SceneSnapshot } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { preferredUsableScene, sceneOptionLabel } from "./sceneOptionPresentation";

describe("visionSceneOptionLabel", () => {
  it("disambiguates duplicate scene names with object count and a short id", () => {
    const scene = {
      id: "scene-12345678-duplicate",
      name: "智造园区总览",
      models: [{}, {}],
      primitives: [{}],
    } as SceneSnapshot;

    expect(sceneOptionLabel(scene, "zh-CN")).toBe("智造园区总览 · 3 个对象 · #78-duplicate");
  });

  it("prefers the scene with the most operable content", () => {
    const empty = { id: "empty", name: "空场景", models: [], primitives: [] } as unknown as SceneSnapshot;
    const usable = { id: "usable", name: "可用场景", models: [{}], primitives: [] } as unknown as SceneSnapshot;
    const richer = { id: "richer", name: "主场景", models: [{}, {}], primitives: [{}] } as unknown as SceneSnapshot;
    expect(preferredUsableScene([empty, usable, richer])).toBe(richer);
  });
});
