import { describe, expect, it, vi } from "vitest";
import type { PublishedSceneRecord, SceneSnapshot } from "@bim-studio/contracts";
import { createSceneArtifactRecord } from "../controllers/scenePublicationArtifactRecord";
import { sceneCompilationSource } from "./sceneCompilationSource";
import { compileSceneRuntimePackage } from "./compileSceneRuntimePackage";
import { assessCompiledScenePublication } from "./scenePublicationCompatibility";

function scene(): SceneSnapshot {
  return { schemaVersion: 1, id: "source", projectId: "project", name: "fixture", models: [], measurements: [],
    primitives: [{ modelId: "box", kind: "box", name: "方块", visible: true, opacity: 1, color: "#ffffff",
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }],
    camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } },
    createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z", publishedAt: "2026-09-15T01:00:00.000Z" };
}
const options = { packageId: "source", packageVersion: "1.0.0", loadModel: vi.fn() };

describe("scene compilation source projection", () => {
  it("rejects evidence from the previous full-snapshot compilation recipe", async () => {
    const input = scene(), compiled = await compileSceneRuntimePackage(input, options);
    const compilation = { ...compiled.evidence, recipe: "deep-scene-static-compile-v2" } as unknown as typeof compiled.evidence;
    const report = assessCompiledScenePublication(input, { compilation, fixtureId: "fixture", platform: "windows-x64" });
    expect(report.items).toContainEqual(expect.objectContaining({ path: "$compiler", status: "blocked" }));
  });
  it("ignores only root publication/save timestamps and leaves the original untouched", () => {
    const input = Object.assign(scene(), { metadata: { updatedAt: "nested", publishedAt: "nested-publication", optional: undefined }, optional: undefined });
    const projected = sceneCompilationSource(input);
    expect(projected).not.toHaveProperty("updatedAt"); expect(projected).not.toHaveProperty("publishedAt");
    expect(projected).not.toHaveProperty("optional"); expect(projected.createdAt).toBe(input.createdAt);
    expect(projected.metadata).toEqual({ updatedAt: "nested", publishedAt: "nested-publication" });
    expect(input.updatedAt).toBe("2026-09-15T00:00:00.000Z"); expect(projected.camera).not.toBe(input.camera);
  });

  it.each([NaN, Infinity, -Infinity, 1n, Symbol("invalid"), () => undefined])("retains strict invalid JSON checks for %s", value => {
    expect(() => sceneCompilationSource(Object.assign(scene(), { metadata: { value } }))).toThrow(/非有限|非 JSON/);
    expect(() => sceneCompilationSource(Object.assign(scene(), { updatedAt: value }))).toThrow(/非有限|非 JSON/);
  });

  it("keeps source, graph and actual artifact stable after save/publication timestamp updates", async () => {
    const input = scene(), original = await compileSceneRuntimePackage(input, options);
    input.updatedAt = "2026-09-16T00:00:00.000Z"; input.publishedAt = "2026-09-16T01:00:00.000Z";
    const changed = await compileSceneRuntimePackage(input, options);
    expect(changed.evidence.recipe).toBe("deep-scene-static-compile-v5");
    expect(changed.evidence.sourceSemanticHash).toBe(original.evidence.sourceSemanticHash);
    expect(changed.evidence.compileGraphHash).toBe(original.evidence.compileGraphHash);
    expect(changed.evidence.targetArtifactHash).toBe(original.evidence.targetArtifactHash);
    expect(changed.packageJson).toBe(original.packageJson);
    const report = assessCompiledScenePublication(input, { compilation: original.evidence, fixtureId: "fixture", platform: "windows-x64" });
    expect(report.items.some(item => item.path === "$source")).toBe(false);
  });

  it.each(["name", "camera", "metadata", "nestedUpdatedAt", "createdAt"])("preserves %s changes in source and graph identity", async field => {
    const input = Object.assign(scene(), { metadata: { updatedAt: "nested-original" } });
    const original = await compileSceneRuntimePackage(input, options);
    if (field === "name") input.name = "renamed";
    else if (field === "camera") input.camera.position.x = 7;
    else if (field === "metadata") Object.assign(input, { unknownMetadata: "changed" });
    else if (field === "nestedUpdatedAt") input.metadata.updatedAt = "nested-changed";
    else input.createdAt = "2026-09-13T00:00:00.000Z";
    const changed = await compileSceneRuntimePackage(input, options);
    expect(changed.evidence.sourceSemanticHash).not.toBe(original.evidence.sourceSemanticHash);
    expect(changed.evidence.compileGraphHash).not.toBe(original.evidence.compileGraphHash);
    if (field === "camera") expect(changed.evidence.targetArtifactHash).not.toBe(original.evidence.targetArtifactHash);
    const report = assessCompiledScenePublication(input, { compilation: original.evidence, fixtureId: "fixture", platform: "windows-x64" });
    expect(report.items.some(item => item.path === "$source")).toBe(true);
  });

  it.each(["updatedAt", "publishedAt"] as const)("preserves full historical artifact fingerprint sensitivity to %s", field => {
    const publication: PublishedSceneRecord = { projectId: "project", sceneId: "source", version: 1, name: "fixture",
      publishedAt: "2026-09-15T01:00:00.000Z", snapshot: scene() };
    const target = { target: "three-webview", renderer: "webgl", toolbarVisible: false } as const;
    const original = createSceneArtifactRecord(publication, target);
    publication.snapshot[field] = "2026-09-16T01:00:00.000Z";
    expect(createSceneArtifactRecord(publication, target).snapshotFingerprint).not.toBe(original.snapshotFingerprint);
  });
});
