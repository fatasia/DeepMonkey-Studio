import type { SceneBehaviorModule, SceneCommand } from "@bim-studio/scene-sdk";
import { describe, expect, it } from "vitest";
import { authorizeSceneCommands } from "./sceneCommandPolicy";

describe("authorizeSceneCommands", () => {
  const camera: SceneCommand = { id: "camera", type: "camera.set", sceneId: "scene-1", position: [1, 2, 3], target: [0, 0, 0] };
  const visibility: SceneCommand = { id: "hide", type: "object.set-visibility", target: { kind: "object", sceneId: "scene-1", objectId: "robot" }, visible: false };
  const component: SceneCommand = { id: "component", type: "component.update", componentId: "widget-1", patch: { visible: true } };

  it("requires scene.write and command-specific capabilities", () => {
    expect(authorizeSceneCommands(module(["studio.camera"], []), [camera])).toMatchObject({ allowed: [], rejected: [{ message: expect.stringContaining("scene.write") }] });
    expect(authorizeSceneCommands(module(["studio.object"], ["scene.write"]), [camera])).toMatchObject({ allowed: [], rejected: [{ message: expect.stringContaining("studio.camera") }] });
    expect(authorizeSceneCommands(module(["studio.camera"], ["scene.write"]), [camera]).allowed).toEqual([camera]);
  });

  it("requires the cross-editor component capability", () => {
    expect(authorizeSceneCommands(module(["studio.object"], ["scene.write"]), [component]).rejected[0]?.message).toContain("studio.component");
    expect(authorizeSceneCommands(module(["studio.component"], ["scene.write"]), [component]).allowed).toEqual([component]);
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
