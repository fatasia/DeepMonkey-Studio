import { describe, expect, it } from "vitest";
import { expectIssue, pluginManifest } from "./fixtures.js";
import { validatePluginManifest } from "./manifest.js";

describe("validatePluginManifest", () => {
  it("accepts editor, scene and converter extension points in one versioned manifest", () => {
    const result = validatePluginManifest(pluginManifest());
    expect(result).toMatchObject({ valid: true, manifest: { id: "acme.factory-tools", version: "2.1.0", schemaVersion: 1 } });
  });

  it("accepts a capability provider declaration with explicit execution budgets", () => {
    const input = pluginManifest();
    input.extensionPoints.push({
      kind: "capability.provider",
      id: "acme.predictive-maintenance",
      capabilityIds: ["asset.health.score"],
      execution: "worker",
      limits: { timeoutMs: 2_000, maxInputBytes: 1_048_576, memoryMb: 256 }
    });
    const result = validatePluginManifest(input);
    expect(result).toMatchObject({ valid: true, manifest: { id: "acme.factory-tools" } });
  });

  it("accepts a replaceable AI provider without embedding credentials", () => {
    const input = pluginManifest();
    input.extensionPoints.push({
      kind: "ai.provider",
      id: "acme.ai-runtime",
      providerIds: ["ai.openai-compatible"],
      execution: "in-process",
      limits: { timeoutMs: 90_000, maxInputBytes: 1_048_576, memoryMb: 256 }
    });
    expect(validatePluginManifest(input)).toMatchObject({ valid: true });
  });

  it("rejects duplicate capability ids and non-positive provider budgets", () => {
    const input = pluginManifest();
    input.extensionPoints.push({
      kind: "capability.provider",
      id: "acme.predictive-maintenance",
      capabilityIds: ["asset.health.score", "asset.health.score"],
      execution: "worker",
      limits: { timeoutMs: 0, maxInputBytes: 1_048_576, memoryMb: 256 }
    });
    const result = validatePluginManifest(input);
    expectIssue(result, "$.extensionPoints[3].capabilityIds[1]");
    expectIssue(result, "$.extensionPoints[3].limits.timeoutMs");
  });

  it("rejects unknown delivery fields instead of treating a URL as executable plugin code", () => {
    const input = { ...pluginManifest(), downloadUrl: "https://plugins.example/acme.js" };
    expectIssue(validatePluginManifest(input), "$.downloadUrl");
  });

  it("rejects remote scene entries and duplicate extension ids", () => {
    const input = pluginManifest();
    const scene = input.extensionPoints[1];
    if (scene?.kind !== "scene.extension") throw new Error("fixture mismatch");
    scene.manifest.entry = "https://plugins.example/scene.js";
    input.extensionPoints[2]!.id = input.extensionPoints[0]!.id;
    const result = validatePluginManifest(input);
    expectIssue(result, "$.extensionPoints[1].manifest.entry");
    expectIssue(result, "$.extensionPoints[2].id");
  });

  it("requires explicit converter budgets and unique inputs", () => {
    const input = pluginManifest();
    const converter = input.extensionPoints[2];
    if (converter?.kind !== "converter.plugin") throw new Error("fixture mismatch");
    converter.inputExtensions = ["obj", "obj"];
    converter.limits.timeoutMs = 0;
    const result = validatePluginManifest(input);
    expectIssue(result, "$.extensionPoints[2].inputExtensions[1]");
    expectIssue(result, "$.extensionPoints[2].limits.timeoutMs");
  });

  it("reports malformed top-level contracts without throwing", () => {
    expect(() => validatePluginManifest(null)).not.toThrow();
    expect(validatePluginManifest(null)).toEqual({
      valid: false,
      issues: [{ path: "$", code: "invalid-type", message: "manifest must be an object" }]
    });
  });
});
