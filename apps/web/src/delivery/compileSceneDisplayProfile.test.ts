import { expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { parseDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { compileSceneRuntimePackage } from "./compileSceneRuntimePackage";

const scene: SceneSnapshot = { schemaVersion: 1, id: "profile-source", projectId: "project", name: "fixture",
  primitives: [], models: [], measurements: [], createdAt: "", updatedAt: "",
  camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } },
  environment: { gridVisible: false, backgroundColor: "#2050a0", skybox: "none" } };
const options = { packageId: "profile.fixture", packageVersion: "1.0.0", loadModel: async () => new Uint8Array() };

it("publishes the requested profile through the actual compiler and package hash", async () => {
  const legacy = await compileSceneRuntimePackage(scene, options);
  const omitted = await compileSceneRuntimePackage(scene, { ...options });
  expect(omitted).toEqual(legacy);
  expect(legacy.runtimePackage.payloads["scene.environment"]).not.toHaveProperty("displayProfile");
  const selected = await compileSceneRuntimePackage(scene, { ...options, displayProfile: "three-aces-r185" });
  expect(selected.runtimePackage.payloads["scene.environment"]).toMatchObject({ displayProfile: "three-aces-r185",
    schemaVersion: 1, outputTransform: "native-aces-v1" });
  expect(parseDeepRuntimePackage(selected.packageJson).valid).toBe(true);
  expect(selected.runtimePackage.packageHash).not.toEqual(legacy.runtimePackage.packageHash);
  expect(scene.environment).toEqual({ gridVisible: false, backgroundColor: "#2050a0", skybox: "none" });
});

it("rejects invalid selections and uncompiled environment consumers", async () => {
  await expect(compileSceneRuntimePackage(scene, { ...options, displayProfile: "invalid" as never }))
    .rejects.toThrow("Unsupported display profile");
  const withoutEnvironment = { ...scene };
  delete withoutEnvironment.environment;
  await expect(compileSceneRuntimePackage(withoutEnvironment, { ...options, displayProfile: "deep-aces" }))
    .rejects.toThrow("displayProfile requires a compiled solid environment");
});
