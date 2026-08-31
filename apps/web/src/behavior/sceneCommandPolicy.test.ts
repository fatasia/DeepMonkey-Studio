import type { SceneBehaviorModule, SceneCommand } from "@bim-studio/scene-sdk";
import { describe, expect, it } from "vitest";
import { authorizeSceneCommands } from "./sceneCommandPolicy";

describe("authorizeSceneCommands", () => {
  const camera: SceneCommand = { id: "camera", type: "camera.set", sceneId: "scene-1", position: [1, 2, 3], target: [0, 0, 0] };
  const visibility: SceneCommand = { id: "hide", type: "object.set-visibility", target: { kind: "object", sceneId: "scene-1", objectId: "robot" }, visible: false };
  const component: SceneCommand = { id: "component", type: "component.update", componentId: "widget-1", patch: { visible: true } };
  const unity: SceneCommand = { id: "unity", type: "unity.properties.set", componentId: "unity-1", values: { lightIntensity: 3 } };
  const material: SceneCommand = { id: "material", type: "material.set", target: { kind: "object", sceneId: "scene-1", objectId: "robot" }, patch: { roughness: 0.4 } };

  it("requires scene.write and command-specific capabilities", () => {
    expect(authorizeSceneCommands(module(["studio.camera"], []), [camera])).toMatchObject({ allowed: [], rejected: [{ message: expect.stringContaining("scene.write") }] });
    expect(authorizeSceneCommands(module(["studio.object"], ["scene.write"]), [camera])).toMatchObject({ allowed: [], rejected: [{ message: expect.stringContaining("studio.camera") }] });
    expect(authorizeSceneCommands(module(["studio.camera"], ["scene.write"]), [camera]).allowed).toEqual([camera]);
  });

  it("requires the cross-editor component capability", () => {
    expect(authorizeSceneCommands(module(["studio.object"], ["scene.write"]), [component]).rejected[0]?.message).toContain("studio.component");
    expect(authorizeSceneCommands(module(["studio.component"], ["scene.write"]), [component]).allowed).toEqual([component]);
  });

  it("keeps Unity control behind its dedicated capability", () => {
    expect(authorizeSceneCommands(module(["studio.component"], ["scene.write"]), [unity]).rejected[0]?.message).toContain("studio.unity");
    expect(authorizeSceneCommands(module(["studio.unity"], ["scene.write"]), [unity]).allowed).toEqual([unity]);
  });

  it("requires the dedicated material capability for material writes", () => {
    expect(authorizeSceneCommands(module(["studio.object"], ["scene.write"]), [material]).rejected[0]?.message).toContain("studio.material");
    expect(authorizeSceneCommands(module(["studio.object", "studio.material"], ["scene.write"]), [material]).allowed).toEqual([material]);
  });

  it("isolates rejected commands while preserving authorized order", () => {
    const result = authorizeSceneCommands(module(["studio.object"], ["scene.write"]), [visibility, camera, visibility]);
    expect(result.allowed).toEqual([visibility, visibility]);
    expect(result.rejected.map((item) => item.command.id)).toEqual(["camera"]);
  });
});

function module(capabilities: SceneBehaviorModule["capabilities"], permissions: SceneBehaviorModule["permissions"]): SceneBehaviorModule {
  return { id: "test", name: "test", apiVersion: "1.0", code: "", lifecycle: [], capabilities, permissions };
}
