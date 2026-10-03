import { describe, expect, it, vi } from "vitest";
import type { GlobalLightingState, SceneEnvironmentState, WeatherMode } from "@bim-studio/contracts";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { SceneCommandExecutor, SCENE_COMMAND_APPLIED, type SceneCommandPort } from "../behavior/SceneCommandExecutor";
import { runEditorSceneTransaction } from "./editorSceneWriteDriver";

function fixture() {
  let revision = 0;
  let lighting: GlobalLightingState = { enabled: true, intensity: 1, shadowsEnabled: true };
  let environment: SceneEnvironmentState = { backgroundColor: "#112233", environmentIntensity: 1, gridVisible: false, skybox: "none" };
  let weather: WeatherMode = "sunny";
  const viewer = {
    listModels: () => [], getSelected: () => undefined, getSelectedLayerId: () => undefined,
    getModelTransform: () => undefined, getModelMaterialState: () => undefined, getLayerStates: () => [],
    getCameraState: () => ({ position: { x: 0, y: 0, z: 3 }, target: { x: 0, y: 0, z: 0 } }),
    getGlobalLighting: () => structuredClone(lighting), getSceneEnvironment: () => structuredClone(environment),
    getWeather: () => weather,
    setGlobalLighting: (next: GlobalLightingState) => { lighting = structuredClone(next); },
    setSceneEnvironment: (next: SceneEnvironmentState) => { environment = structuredClone(next); },
    setWeather: (next: WeatherMode) => { weather = next; },
  };
  const applied = () => SCENE_COMMAND_APPLIED;
  const port: SceneCommandPort = {
    setObjectVisibility: applied, setObjectTransform: () => ({ status: "unsupported", message: "injected failure" }),
    setObjectMaterial: applied, setSelection: applied, setCamera: applied, flyCamera: applied,
    controlAnimation: applied, applyData: applied, updateComponent: applied,
    setLighting: (_scene, patch) => { lighting = { ...lighting, ...patch }; return SCENE_COMMAND_APPLIED; },
    setEnvironment: (_scene, patch) => {
      const { weather: requestedWeather, ...rest } = patch;
      environment = { ...environment, ...rest }; if (requestedWeather) weather = requestedWeather;
      return SCENE_COMMAND_APPLIED;
    },
  };
  const run = (commands: readonly unknown[]) => runEditorSceneTransaction({
    sceneId: "scene", viewer: () => viewer as unknown as ViewerEngine, port,
    readRevision: () => revision, bumpRevision: () => { revision += 1; },
  }, { requestId: "req", transaction: { id: "atomic-scene", sceneId: "scene", baseRevision: 0,
    module: { id: "script", capabilities: ["studio.scene", "studio.object"], permissions: ["scene.write"] }, commands } });
  return { viewer, port, run, state: () => ({ lighting, environment, weather }) };
}
const fail = { id: "fail", type: "object.set-transform", target: { kind: "object", sceneId: "scene", objectId: "gone" }, position: [1, 0, 0] };

describe("scene metadata transaction atomicity", () => {
  it("restores lighting after a later command fails", async () => {
    const f = fixture(), before = structuredClone(f.state());
    const result = await f.run([{ id: "light", type: "lighting.set", sceneId: "scene", patch: { intensity: 0.2 } }, fail]);
    expect(result.status).toBe("rolled-back");
    expect(f.state()).toEqual(before);
  });

  it("restores environment and weather after a later command fails", async () => {
    const f = fixture(), before = structuredClone(f.state());
    const result = await f.run([{ id: "env", type: "environment.set", sceneId: "scene", patch: { backgroundColor: "#abcdef", environmentIntensity: 2, weather: "fog" } }, fail]);
    expect(result.status).toBe("rolled-back");
    expect(f.state()).toEqual(before);
  });

  it("拒绝缺少场景读回的宿主，不能先修改再声称可回滚", async () => {
    const f = fixture();
    const before = structuredClone(f.state());
    Object.defineProperty(f.viewer, "getGlobalLighting", { value: undefined });
    const write = vi.spyOn(f.port, "setLighting");
    const result = await f.run([{ id: "light", type: "lighting.set", sceneId: "scene", patch: { intensity: 0.2 } }]);
    expect(result.status).toBe("rolled-back");
    expect(write).not.toHaveBeenCalled();
    expect(f.state()).toEqual(before);
  });

  it("restores state even when a setter changes it before throwing", async () => {
    const f = fixture(), before = structuredClone(f.state());
    const original = f.port.setEnvironment!;
    f.port.setEnvironment = (scene, patch) => { original(scene, patch); throw new Error("injected after mutation"); };
    const result = await f.run([{ id: "env", type: "environment.set", sceneId: "scene", patch: { weather: "rain", environmentIntensity: 3 } }]);
    expect(result.status).toBe("rolled-back");
    expect(f.state()).toEqual(before);
  });

  it("rejects direct executor lighting and environment commands from a different scene", async () => {
    const f = fixture();
    const light = vi.spyOn(f.port, "setLighting");
    const environment = vi.spyOn(f.port, "setEnvironment");
    const results = await new SceneCommandExecutor("scene", f.port).execute([
      { id: "light", type: "lighting.set", sceneId: "other", patch: { intensity: 0.2 } },
      { id: "env", type: "environment.set", sceneId: "other", patch: { weather: "fog" } },
    ]);
    expect(results.every(result => !result.success && result.code === "scene-mismatch")).toBe(true);
    expect(light).not.toHaveBeenCalled(); expect(environment).not.toHaveBeenCalled();
  });
});
