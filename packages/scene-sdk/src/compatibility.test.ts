import { describe, expect, it } from "vitest";
import { resolveSceneExtensionCompatibility, type SceneHostCapabilities } from "./compatibility.js";
import {
  SCENE_CAPABILITIES,
  SCENE_PERMISSIONS,
  type SceneCommand,
  type SceneEvent,
  type SceneExtensionManifest,
  type SceneQuery
} from "./protocol.js";

const extension: SceneExtensionManifest = {
  id: "com.example.behavior",
  name: "Example behavior",
  version: "1.0.0",
  apiVersion: "1.0",
  entry: "dist/behavior.js",
  execution: "worker-sandbox",
  capabilities: ["studio.scene", "studio.object", "studio.camera"],
  permissions: ["scene.read"],
  hosts: ["browser"],
  renderers: ["webgl2", "webgpu"],
  lifecycle: ["onStart", "onEvent", "onDispose"]
};

const host: SceneHostCapabilities = {
  apiVersion: "1.0",
  host: "browser",
  renderer: "webgl2",
  capabilities: [...SCENE_CAPABILITIES],
  permissions: [...SCENE_PERMISSIONS],
  allowTrustedExtensions: false
};

describe("resolveSceneExtensionCompatibility", () => {
  it("accepts a worker behavior extension supported by the browser and both render backends", () => {
    expect(resolveSceneExtensionCompatibility(extension, host)).toEqual({ compatible: true, reasons: [] });
  });

  it("rejects an API major mismatch", () => {
    const result = resolveSceneExtensionCompatibility({ ...extension, apiVersion: "2.0" }, host);

    expect(result.compatible).toBe(false);
    expect(result.reasons.map(({ code }) => code)).toEqual(["api-major-mismatch"]);
  });

  it("requires the host minor version to cover the extension minor version", () => {
    expect(resolveSceneExtensionCompatibility({ ...extension, apiVersion: "1.2" }, host).reasons)
      .toEqual([{ code: "api-minor-unsupported", detail: "extension 1.2 requires a newer minor than host 1.0" }]);
  });

  it("distinguishes malformed API versions from compatibility mismatches", () => {
    const result = resolveSceneExtensionCompatibility(
      { ...extension, apiVersion: "1.0.0" },
      { ...host, apiVersion: "latest" }
    );

    expect(result.reasons).toEqual([{
      code: "invalid-api-version",
      detail: "extension apiVersion \"1.0.0\", host apiVersion \"latest\""
    }]);
  });

  it("reports missing capabilities and permissions once, sorted deterministically", () => {
    const result = resolveSceneExtensionCompatibility({
      ...extension,
      capabilities: ["studio.mesh", "studio.animation", "studio.mesh"],
      permissions: ["network.connect", "data.write", "network.connect"]
    }, {
      ...host,
      capabilities: ["studio.scene"],
      permissions: ["scene.read"]
    });

    expect(result.reasons).toEqual([
      { code: "capability-unsupported", detail: "studio.animation,studio.mesh" },
      { code: "permission-denied", detail: "data.write,network.connect" }
    ]);
  });

  it("rejects a trusted main-thread extension when the host disables trusted extensions", () => {
    const result = resolveSceneExtensionCompatibility({ ...extension, execution: "trusted-main-thread" }, host);

    expect(result.reasons.map(({ code }) => code)).toContain("trusted-extension-disabled");
  });

  it.each([
    ["missing", undefined],
    ["unknown", "iframe-sandbox"]
  ])("rejects %s extension execution before trusted-extension evaluation", (_name, execution) => {
    const manifest = { ...extension } as Record<string, unknown>;
    if (execution === undefined) Reflect.deleteProperty(manifest, "execution");
    else manifest.execution = execution;

    const result = resolveSceneExtensionCompatibility(manifest, host);

    expect(result.reasons.map(({ code }) => code)).toEqual(["invalid-execution"]);
  });

  it("rejects a WebGPU-only extension on a WebGL 2 host", () => {
    const result = resolveSceneExtensionCompatibility({ ...extension, renderers: ["webgpu"] }, host);

    expect(result.reasons.map(({ code }) => code)).toContain("renderer-unsupported");
  });

  it("accumulates reasons in the fixed protocol order", () => {
    const result = resolveSceneExtensionCompatibility({
      ...extension,
      apiVersion: "2.0",
      execution: "trusted-main-thread",
      capabilities: ["studio.mesh"],
      permissions: ["data.write"],
      hosts: ["cloud"],
      renderers: ["webgpu"]
    }, {
      ...host,
      capabilities: [],
      permissions: []
    });

    expect(result.reasons.map(({ code }) => code)).toEqual([
      "api-major-mismatch",
      "host-unsupported",
      "renderer-unsupported",
      "trusted-extension-disabled",
      "capability-unsupported",
      "permission-denied"
    ]);
  });

  it("does not crash on malformed, sparse, custom-property, symbol, or duplicate arrays", () => {
    const malformedCapabilities = new Array(3) as unknown[] & Record<PropertyKey, unknown>;
    malformedCapabilities[1] = "studio.mesh";
    malformedCapabilities.extra = "ignored";
    malformedCapabilities[Symbol("ignored")] = "ignored";

    expect(() => resolveSceneExtensionCompatibility({
      ...extension,
      capabilities: malformedCapabilities,
      permissions: null,
      hosts: "browser",
      renderers: { webgl2: true }
    } as unknown, {
      ...host,
      capabilities: ["studio.mesh", "studio.mesh"] as unknown,
      permissions: undefined
    } as unknown)).not.toThrow();
  });

  it.each([null, undefined, true, 1, "manifest", {}, []])("does not crash for untrusted manifest input %#", (value) => {
    expect(() => resolveSceneExtensionCompatibility(value, host)).not.toThrow();
  });

  it("does not crash when hostile external objects throw during property or array inspection", () => {
    const throwingManifest = new Proxy({}, { get: () => { throw new Error("hostile getter"); } });
    const revokedArray = Proxy.revocable([], {});
    revokedArray.revoke();

    expect(() => resolveSceneExtensionCompatibility(throwingManifest, host)).not.toThrow();
    expect(() => resolveSceneExtensionCompatibility({ ...extension, capabilities: revokedArray.proxy }, host)).not.toThrow();
  });
});

describe("serializable protocol fixtures", () => {
  const fixtures: Array<SceneCommand | SceneQuery | SceneEvent> = [
    { id: "command:visibility", type: "object.set-visibility", target: { kind: "object", sceneId: "scene:1", objectId: "object:1" }, visible: false },
    { id: "command:transform", type: "object.set-transform", target: { kind: "mesh", sceneId: "scene:1", objectId: "object:1", meshId: "mesh:1" }, position: [1, 2, 3], rotation: [0, 1, 0], scale: [1, 1, 1] },
    { id: "command:selection", type: "selection.set", targets: [{ kind: "scene", sceneId: "scene:1" }] },
    { id: "command:camera", type: "camera.set", sceneId: "scene:1", position: [1, 2, 3], target: [0, 0, 0], near: 0.1, far: 1000, fov: 45 },
    { id: "command:fly", type: "camera.fly-to", sceneId: "scene:1", target: { position: [1, 2, 3] }, durationMs: 500 },
    { id: "command:animation", type: "animation.control", target: { kind: "object", sceneId: "scene:1", objectId: "object:1" }, action: "seek", clipId: "clip:1", time: 1.5 },
    { id: "command:data", type: "data.apply", target: { kind: "object", sceneId: "scene:1", objectId: "object:1" }, values: { temperature: 21, metadata: [true, null] }, timestamp: "2026-08-25T00:00:00.000Z" },
    { id: "query:object", type: "object.get", target: { kind: "object", sceneId: "scene:1", objectId: "object:1" } },
    { id: "query:search", type: "object.search", sceneId: "scene:1", text: "pump", tags: ["critical"] },
    { id: "query:camera", type: "camera.get", sceneId: "scene:1" },
    { id: "query:capabilities", type: "capabilities.get" },
    { type: "scene.ready", sceneId: "scene:1", timestamp: "2026-08-25T00:00:00.000Z" },
    { type: "selection.changed", sceneId: "scene:1", targets: [], timestamp: "2026-08-25T00:00:00.000Z" },
    { type: "object.event", name: "alarm", target: { kind: "object", sceneId: "scene:1", objectId: "object:1" }, timestamp: "2026-08-25T00:00:00.000Z", data: { severity: "high" } },
    { type: "data.received", sceneId: "scene:1", timestamp: "2026-08-25T00:00:00.000Z", data: [1, 2, 3] }
  ];

  it.each(fixtures)("round-trips $type without executable or host values", (fixture) => {
    expect(structuredClone(fixture)).toEqual(fixture);
    expect(JSON.parse(JSON.stringify(fixture))).toEqual(fixture);
    expect(containsFunction(fixture)).toBe(false);
  });
});

function containsFunction(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "function") return true;
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).some((key) => containsFunction(Reflect.get(value, key), seen));
}
