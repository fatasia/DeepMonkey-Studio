import { expect } from "vitest";
import type { PluginHostPolicy } from "./compatibility.js";
import type { PluginManifestV1, PluginManifestValidation } from "./manifest.js";

export function pluginManifest(overrides: Partial<PluginManifestV1> = {}): PluginManifestV1 {
  return {
    schemaVersion: 1,
    id: "acme.factory-tools",
    name: "Factory tools",
    version: "2.1.0",
    apiVersion: "1.0",
    hosts: ["browser", "tauri"],
    capabilities: ["studio.object", "converter.execute"],
    permissions: ["scene.read", "scene.write"],
    extensionPoints: [
      { kind: "editor.panel", id: "acme.factory-panel", title: "Factory", placement: "right", order: 20 },
      {
        kind: "scene.extension",
        id: "acme.factory-scene",
        manifest: {
          id: "acme.factory-scene",
          name: "Factory Scene",
          version: "2.1.0",
          apiVersion: "1.0",
          entry: "./factory-scene.js",
          execution: "worker-sandbox",
          capabilities: ["studio.object"],
          permissions: ["scene.read"],
          hosts: ["browser", "tauri"],
          renderers: ["webgl2", "webgpu"],
          lifecycle: ["onStart", "onUpdate", "onDispose"]
        }
      },
      {
        kind: "converter.plugin",
        id: "acme-model-converter",
        inputExtensions: ["obj", "dae"],
        inputMediaTypes: ["model/obj", "model/vnd.collada+xml"],
        outputFormat: "glb",
        outputMediaType: "model/gltf-binary",
        execution: "server-worker",
        limits: { timeoutMs: 600_000, maxInputBytes: 2_147_483_648, memoryMb: 4096 }
      }
    ],
    ...overrides
  };
}

export function hostPolicy(overrides: Partial<PluginHostPolicy> = {}): PluginHostPolicy {
  return {
    apiVersion: "1.1",
    sceneApiVersion: "1.0",
    host: "browser",
    renderer: "webgpu",
    capabilities: ["studio.object", "converter.execute"],
    permissions: ["scene.read", "scene.write"],
    extensionPoints: ["editor.panel", "scene.extension", "converter.plugin"],
    allowTrustedSceneExtensions: false,
    ...overrides
  };
}

export function expectIssue(result: PluginManifestValidation, path: string): void {
  expect(result.valid).toBe(false);
  if (!result.valid) expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
}
