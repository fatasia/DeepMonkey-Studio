import { describe, expect, it } from "vitest";
import { buildPluginCompatibilityMatrix } from "./compatibilityMatrix.js";
import type { PluginHostPolicy } from "./compatibility.js";
import { PLUGIN_MANIFEST_SCHEMA_VERSION } from "./manifest.js";

function host(overrides?: Partial<PluginHostPolicy>): PluginHostPolicy {
  return {
    apiVersion: "1.4", sceneApiVersion: "1.0", host: "browser", renderer: "webgpu",
    capabilities: ["scene.read", "scene.write"], permissions: ["scene.edit"],
    extensionPoints: ["editor.panel"], allowTrustedSceneExtensions: false, ...overrides,
  };
}

function manifest(overrides?: Record<string, unknown>): unknown {
  return {
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION, id: "plugin-a", name: "Plugin A",
    version: "0.1.0", apiVersion: "1.2", hosts: ["browser"], capabilities: ["scene.read"],
    permissions: ["scene.edit"],
    extensionPoints: [{ kind: "editor.panel", id: "panel-a", title: "Panel A", placement: "left" }],
    ...overrides,
  };
}

describe("plugin compatibility matrix", () => {
  it("scores every plugin-host pair and orders deterministically", () => {
    const matrix = buildPluginCompatibilityMatrix(
      [manifest(), manifest({ id: "plugin-b", apiVersion: "2.0" })],
      [host(), host({ host: "cloud", renderer: "webgl2" })]);
    expect(matrix.summary.pairs).toBe(4);
    expect(matrix.entries.map(entry => `${entry.pluginId}@${entry.host}`)).toEqual([
      "plugin-a@browser/webgpu", "plugin-a@cloud/webgl2",
      "plugin-b@browser/webgpu", "plugin-b@cloud/webgl2",
    ]);
    const pluginABrowser = matrix.entries[0]!;
    expect(pluginABrowser.compatible).toBe(true);
    const pluginACloud = matrix.entries[1]!;
    expect(pluginACloud.compatible).toBe(false);
    expect(pluginACloud.reasons.map(reason => reason.code)).toEqual(["host-unsupported"]);
  });

  it("aggregates reason codes and keeps unparseable manifests fail-closed", () => {
    const matrix = buildPluginCompatibilityMatrix(
      [manifest({ id: "plugin-b", apiVersion: "1.5" }), { id: "broken" }],
      [host()]);
    expect(matrix.summary.compatible).toBe(0);
    expect(matrix.summary.incompatible).toBe(2);
    expect(matrix.summary.byReasonCode).toMatchObject({ "plugin-api-minor-unsupported": 1, "invalid-manifest": 1 });
    expect(matrix.entries.find(entry => entry.pluginId === "(unparseable-manifest)")
      ?.reasons[0]?.code).toBe("invalid-manifest");
  });

  it("reports empty matrices without fabricating entries", () => {
    const matrix = buildPluginCompatibilityMatrix([], [host()]);
    expect(matrix.summary).toMatchObject({ manifests: 0, hosts: 1, pairs: 0, compatible: 0, incompatible: 0 });
    expect(matrix.entries).toEqual([]);
  });
});
