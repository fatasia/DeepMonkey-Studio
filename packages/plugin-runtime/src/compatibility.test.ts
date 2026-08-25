import { describe, expect, it } from "vitest";
import { resolvePluginCompatibility } from "./compatibility.js";
import { hostPolicy, pluginManifest } from "./fixtures.js";

describe("resolvePluginCompatibility", () => {
  it("accepts a manifest when plugin API, host grants and nested scene extension agree", () => {
    expect(resolvePluginCompatibility(pluginManifest(), hostPolicy())).toMatchObject({ compatible: true, reasons: [] });
  });

  it("reports unsupported extension points, capabilities and permissions deterministically", () => {
    const result = resolvePluginCompatibility(pluginManifest({
      capabilities: ["z.capability", "a.capability"],
      permissions: ["z.permission", "a.permission"]
    }), hostPolicy({
      capabilities: ["studio.object"],
      permissions: ["scene.read"],
      extensionPoints: ["scene.extension"]
    }));
    expect(result.compatible).toBe(false);
    if (!result.compatible) expect(result.reasons.slice(0, 3)).toEqual([
      { code: "extension-point-unsupported", detail: "converter.plugin,editor.panel" },
      { code: "capability-unsupported", detail: "a.capability,z.capability" },
      { code: "permission-denied", detail: "a.permission,z.permission" }
    ]);
  });

  it("requires equal plugin API major and a sufficient host minor", () => {
    const major = resolvePluginCompatibility(pluginManifest({ apiVersion: "2.0" }), hostPolicy());
    const minor = resolvePluginCompatibility(pluginManifest({ apiVersion: "1.2" }), hostPolicy({ apiVersion: "1.1" }));
    expect(!major.compatible && major.reasons[0]).toEqual({ code: "plugin-api-major-mismatch", detail: "plugin 2.0, host 1.1" });
    expect(!minor.compatible && minor.reasons[0]).toEqual({ code: "plugin-api-minor-unsupported", detail: "plugin 1.2, host 1.1" });
  });

  it("negotiates platform plugin API independently from Scene SDK API", () => {
    const result = resolvePluginCompatibility(
      pluginManifest({ apiVersion: "2.0" }),
      hostPolicy({ apiVersion: "2.0", sceneApiVersion: "1.0" })
    );
    expect(result).toMatchObject({ compatible: true, reasons: [] });
  });

  it("surfaces nested Scene SDK compatibility failures with the extension id", () => {
    const input = pluginManifest();
    const scene = input.extensionPoints[1];
    if (scene?.kind !== "scene.extension") throw new Error("fixture mismatch");
    scene.manifest.execution = "trusted-main-thread";
    const result = resolvePluginCompatibility(input, hostPolicy({ allowTrustedSceneExtensions: false }));
    expect(!result.compatible && result.reasons).toContainEqual({
      code: "scene-extension-incompatible",
      detail: "acme.factory-scene:trusted-extension-disabled:host does not allow trusted-main-thread extensions"
    });
  });

  it("rejects malformed host policy before activation", () => {
    const result = resolvePluginCompatibility(pluginManifest(), hostPolicy({ apiVersion: "latest" }));
    expect(result).toMatchObject({ compatible: false, reasons: [{ code: "invalid-host-policy", detail: "apiVersion" }] });
  });
});
