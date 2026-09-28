import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateDeepAssetPackage } from "@bim-studio/deep-engine";
import {
  buildModelDeepAssetPackage, deepAssetSceneBlobBytes, DeepAssetPackageBuildError,
} from "./deepAssetPackageBuilder.js";
import { buildCadCompatibilityProfile } from "./deepAssetPackagePipeline.js";

let outputDir: string;

beforeAll(async () => {
  outputDir = await mkdtemp(path.join(tmpdir(), "deep-asset-builder-"));
  await writeFile(path.join(outputDir, "geometry.glb"), Buffer.from("glb-bytes-v1"));
  await writeFile(path.join(outputDir, "hierarchy.json"), JSON.stringify({ nodes: 3 }));
  await writeFile(path.join(outputDir, "properties.json"), JSON.stringify({ props: 7 }));
});

afterAll(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

const compatibility = () => buildCadCompatibilityProfile("step", "opencascade-step", "1", { hierarchy: true, properties: true });

function baseInput() {
  return {
    packageId: "pkg:0f0e0d0c-1111-2222-3333-444455556666",
    source: { kind: "model-file" as const, logicalName: "bracket.step", contentHash: "a".repeat(64), byteLength: 128 },
    importer: { kind: "open-converter" as const, id: "opencascade-step", version: "1", recipeHash: "b".repeat(64), deterministic: true as const },
    compatibility: compatibility(),
    files: [
      { id: "geometry:main", kind: "mesh" as const, logicalPath: "output/geometry.glb", fileName: "geometry.glb", mediaType: "model/gltf-binary" },
      { id: "metadata:hierarchy", kind: "metadata" as const, logicalPath: "output/hierarchy.json", fileName: "hierarchy.json", mediaType: "application/json" },
      { id: "metadata:properties", kind: "metadata" as const, logicalPath: "output/properties.json", fileName: "properties.json", mediaType: "application/json" },
    ],
    outputDir,
  };
}

describe("buildModelDeepAssetPackage", () => {
  it("组装的包通过 Deep Asset Package v1 校验，入口 scene 依赖全部文件资源", async () => {
    const built = await buildModelDeepAssetPackage(baseInput());
    const validation = validateDeepAssetPackage(built.packageValue);
    expect(validation.issues).toEqual([]);
    expect(validation.valid).toBe(true);
    const resources = built.packageValue.manifest.resources;
    expect(resources.map((resource) => resource.id)).toEqual([
      "geometry:main", "metadata:hierarchy", "metadata:properties", "scene:main",
    ]);
    const scene = resources.at(-1)!;
    expect(scene.kind).toBe("scene");
    expect(scene.dependencies).toEqual(["geometry:main", "metadata:hierarchy", "metadata:properties"]);
    expect(built.packageValue.manifest.entryScene).toBe("scene:main");
    expect(built.packageValue.blobs.map((blob) => blob.hash))
      .toEqual([...built.packageValue.blobs.map((blob) => blob.hash)].sort());
    expect(built.blobOrigins).toHaveLength(built.packageValue.blobs.length);
  });

  it("scene blob 字节稳定且由资源 id 派生", async () => {
    const bytes = deepAssetSceneBlobBytes(["metadata:properties", "geometry:main"]);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual({ resources: ["geometry:main", "metadata:properties"] });
  });

  it("几何字节变化只换几何 blob；scene 与 sidecar blob 哈希保持（最小失效存储面）", async () => {
    const before = await buildModelDeepAssetPackage(baseInput());
    await writeFile(path.join(outputDir, "geometry.glb"), Buffer.from("glb-bytes-v2"));
    const after = await buildModelDeepAssetPackage(baseInput());
    const geometryBefore = before.packageValue.manifest.resources[0]!.blobHash;
    const geometryAfter = after.packageValue.manifest.resources[0]!.blobHash;
    expect(geometryAfter).not.toBe(geometryBefore);
    // scene 资源只描述组合关系（资源 id 列表），资源 id 未变则其 blob 复用，不随内容重发。
    expect(after.packageValue.manifest.resources.at(-1)!.blobHash)
      .toBe(before.packageValue.manifest.resources.at(-1)!.blobHash);
    // sidecar 未变：其 blob 哈希保持，发布计划将复用而不是重传。
    expect(after.packageValue.manifest.resources[1]!.blobHash)
      .toBe(before.packageValue.manifest.resources[1]!.blobHash);
    await writeFile(path.join(outputDir, "geometry.glb"), Buffer.from("glb-bytes-v1"));
  });

  it("拒绝空文件清单、非法 packageId 与重复资源 id", async () => {
    await expect(buildModelDeepAssetPackage({ ...baseInput(), files: [] }))
      .rejects.toBeInstanceOf(DeepAssetPackageBuildError);
    await expect(buildModelDeepAssetPackage({ ...baseInput(), packageId: "PKG:BAD" }))
      .rejects.toBeInstanceOf(DeepAssetPackageBuildError);
    await expect(buildModelDeepAssetPackage({
      ...baseInput(),
      files: [
        ...baseInput().files.slice(0, 2),
        { ...baseInput().files[0]! },
      ],
    })).rejects.toBeInstanceOf(DeepAssetPackageBuildError);
  });

  it("拒绝目录穿越的产物文件名", async () => {
    await expect(buildModelDeepAssetPackage({
      ...baseInput(),
      files: [{ id: "geometry:main", kind: "mesh", logicalPath: "output/geometry.glb", fileName: "../escape.glb", mediaType: "model/gltf-binary" }],
    })).rejects.toBeInstanceOf(DeepAssetPackageBuildError);
  });
});
