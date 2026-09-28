import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { ModelManifest } from "@bim-studio/contracts";
import { assertDeepAssetPackageReference, assertModelReplacementCompatible } from "./modelReplacementCompatibility";

function model(parts: Array<{ id: string; name: string }>): THREE.Group {
  const root = new THREE.Group();
  for (const part of parts) {
    const node = new THREE.Mesh();
    node.name = part.name;
    node.userData = { NodeType: "Element", ElementId: part.id };
    root.add(node);
  }
  return root;
}

describe("model replacement source identity diagnostics", () => {
  it("reports the deleted stable element and preserves the rejection boundary", () => {
    const previous = model([{ id: "jt-instance:5:lod-0:path-0/2", name: "Valve" }]);
    expect(() => assertModelReplacementCompatible(previous, model([])))
      .toThrow(/jt-instance:5:lod-0:path-0\/2 已删除/);
  });

  it("accepts added elements and reports a changed name at a stable id", () => {
    const previous = model([{ id: "part-1", name: "Pump" }]);
    expect(() => assertModelReplacementCompatible(previous, model([
      { id: "part-1", name: "Pump" }, { id: "part-2", name: "Pipe" },
    ]))).not.toThrow();
    expect(() => assertModelReplacementCompatible(previous, model([{ id: "part-1", name: "Motor" }])))
      .toThrow(/element:part-1 已重命名/);
  });
});

describe("deep asset package reference gate", () => {
  const reference = {
    packageId: "pkg:0f0e0d0c-1111-2222-3333-444455556666",
    revision: 3,
    sourceHash: "a".repeat(64),
    entryScene: "scene:main",
    packageUrl: "/assets/projects/p/models/m/output/deep-package.json",
  };
  const manifest = (overrides: Partial<NonNullable<ModelManifest["deepAssetPackage"]>> = {}, options: { noReference?: true } = {}): ModelManifest => ({
    schemaVersion: 1,
    modelId: "m",
    sourceName: "bracket.step",
    sourceFormat: "step",
    createdAt: "2026-09-27T00:00:00Z",
    ...(options.noReference ? {} : { deepAssetPackage: { ...reference, ...overrides } }),
  });

  it("无引用的素材直接放行（旧素材不经过资产包链）", () => {
    expect(() => assertDeepAssetPackageReference(manifest({}, { noReference: true }))).not.toThrow();
  });

  it("完整引用放行", () => {
    expect(() => assertDeepAssetPackageReference(manifest())).not.toThrow();
  });

  it("引用字段缺失或非法时明确报错且原实例不动", () => {
    const missingRevision = manifest();
    delete (missingRevision.deepAssetPackage as { revision?: unknown }).revision;
    expect(() => assertDeepAssetPackageReference(missingRevision))
      .toThrow(/revision/);
    expect(() => assertDeepAssetPackageReference(manifest({ revision: 1.5 })))
      .toThrow(/revision/);
    expect(() => assertDeepAssetPackageReference(manifest({ sourceHash: "xyz" })))
      .toThrow(/sourceHash/);
    expect(() => assertDeepAssetPackageReference(manifest({ packageUrl: "" })))
      .toThrow(/packageUrl/);
    expect(() => assertDeepAssetPackageReference(manifest({ packageId: "" })))
      .toThrow(/packageId/);
  });
});
