import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DeepAssetPackage } from "@bim-studio/deep-engine";
import {
  createFileSystemDeepAssetPackageStore,
} from "./deepAssetPackageStore.js";
import {
  buildModelDeepAssetPackage,
} from "./deepAssetPackageBuilder.js";
import { buildCadCompatibilityProfile } from "./deepAssetPackagePipeline.js";

let rootDir: string;
let outputDir: string;
let store: ReturnType<typeof createFileSystemDeepAssetPackageStore>;
let latestOrigins: ReturnType<typeof buildModelDeepAssetPackage> extends Promise<infer B> ? B["blobOrigins"] : never = [];

beforeAll(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "deep-asset-store-"));
  outputDir = await mkdtemp(path.join(tmpdir(), "deep-asset-store-src-"));
  await writeFile(path.join(outputDir, "geometry.glb"), Buffer.from("glb-store-v1"));
  store = createFileSystemDeepAssetPackageStore(rootDir, (hash) =>
    Promise.resolve(latestOrigins.find((origin) => origin.hash === hash)));
});

afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true });
  await rm(outputDir, { recursive: true, force: true });
});

const source = () => ({
  kind: "model-file" as const, logicalName: "bracket.step", contentHash: "a".repeat(64), byteLength: 128,
});
const importer = () => ({
  kind: "open-converter" as const, id: "opencascade-step", version: "1",
  recipeHash: "b".repeat(64), deterministic: true as const,
});

async function builtPackage() {
  const built = await buildModelDeepAssetPackage({
    packageId: "pkg:0f0e0d0c-1111-2222-3333-444455556666",
    source: source(),
    importer: importer(),
    compatibility: buildCadCompatibilityProfile("step", "opencascade-step", "1", { hierarchy: false, properties: false }),
    files: [{ id: "geometry:main", kind: "mesh", logicalPath: "output/geometry.glb", fileName: "geometry.glb", mediaType: "model/gltf-binary" }],
    outputDir,
  });
  return trackOrigins(built);
}
function trackOrigins(built: Awaited<ReturnType<typeof buildModelDeepAssetPackage>>) {
  latestOrigins = built.blobOrigins;
  return { packageValue: built.packageValue, origins: built.blobOrigins };
}

describe("createFileSystemDeepAssetPackageStore", () => {
  it("首次发布提交修订 1，blob 内容寻址落盘", async () => {
    const { packageValue, origins } = await builtPackage();
    const result = await store.createExecutor(origins).publish(packageValue);
    expect(result.status).toBe("committed");
    expect(result.commit?.nextRevision).toBe(1);
    const snapshot = await store.readSnapshot();
    expect(snapshot.revision).toBe(1);
    expect(snapshot.active?.packageId).toBe(packageValue.manifest.packageId);
    expect(snapshot.blobHashes).toEqual(packageValue.blobs.map((blob) => blob.hash));
    for (const blob of packageValue.blobs) {
      const stored = await readFile(path.join(rootDir, "blobs", blob.hash));
      expect(stored.byteLength).toBe(blob.byteLength);
    }
    const active = await store.readActivePackage();
    expect(active?.revision).toBe(1);
    expect(active?.packageValue.manifest.packageId).toBe(packageValue.manifest.packageId);
  });

  it("同包重发布判定 unchanged 且不推进修订", async () => {
    const { packageValue, origins } = await builtPackage();
    const result = await store.createExecutor(origins).publish(packageValue);
    expect(result.status).toBe("unchanged");
    expect(result.commit?.expectedRevision).toBe(1);
    expect((await store.readSnapshot()).revision).toBe(1);
  });

  it("几何字节变化发布修订 2 并复用未变 blob（依赖最小失效的存储面）", async () => {
    await writeFile(path.join(outputDir, "geometry.glb"), Buffer.from("glb-store-v2"));
    const { packageValue, origins } = await builtPackage();
    const result = await store.createExecutor(origins).publish(packageValue);
    expect(result.status).toBe("committed");
    expect(result.commit?.nextRevision).toBe(2);
    expect(result.reusedBlobs).toBeGreaterThan(0);
    expect(result.committedBlobs).toBeGreaterThan(0);
    expect((await store.readSnapshot()).revision).toBe(2);
    await writeFile(path.join(outputDir, "geometry.glb"), Buffer.from("glb-store-v1"));
  });

  it("快照修订被外部改动时 adapter CAS 拒绝发布并清理 staged 文件", async () => {
    await writeFile(path.join(outputDir, "geometry.glb"), Buffer.from("glb-store-v3"));
    const { packageValue, origins } = await builtPackage();
    const snapshot = await store.readSnapshot();
    const stagedBlobs = await Promise.all(
      packageValue.blobs.map((blob) => store.adapter.stageBlob(blob, packageValue, new AbortController().signal)),
    );
    // 模拟 readSnapshot 之后第三方抢先提交：快照修订被推进，本次请求携带过期 expectedRevision。
    const snapshotPath = path.join(rootDir, "snapshot.json");
    const original = await readFile(snapshotPath, "utf8");
    await writeFile(snapshotPath, JSON.stringify({ ...JSON.parse(original), revision: snapshot.revision + 5 }), "utf8");
    const stale = store.adapter.commit({
      generation: 1,
      packageValue,
      commit: {
        expectedRevision: snapshot.revision,
        nextRevision: snapshot.revision + 1,
        nextActive: { packageId: packageValue.manifest.packageId, sourceHash: source().contentHash, recipeHash: importer().recipeHash },
        entryScene: packageValue.manifest.entryScene,
        resourceOrder: [],
        addBlobHashes: packageValue.blobs.map((blob) => blob.hash),
        reuseBlobHashes: [],
      },
      stagedBlobs,
      isCurrent: () => true,
    });
    await writeFile(snapshotPath, original, "utf8");
    expect(stale).toBe("revision-conflict");
    expect((await store.readSnapshot()).revision).toBe(snapshot.revision);
    expect((await readdir(path.join(rootDir, "tmp"))).filter((name) => name.endsWith(".part"))).toEqual([]);
    await writeFile(path.join(outputDir, "geometry.glb"), Buffer.from("glb-store-v1"));
  });

  it("世代过期时 adapter 返回 superseded 且不落任何内容", async () => {
    const { packageValue, origins } = await builtPackage();
    const stagedBlobs = await Promise.all(
      packageValue.blobs.map((blob) => store.adapter.stageBlob(blob, packageValue, new AbortController().signal)),
    );
    const snapshot = await store.readSnapshot();
    const superseded = store.adapter.commit({
      generation: 1,
      packageValue,
      commit: {
        expectedRevision: snapshot.revision,
        nextRevision: snapshot.revision + 1,
        nextActive: { packageId: packageValue.manifest.packageId, sourceHash: source().contentHash, recipeHash: importer().recipeHash },
        entryScene: packageValue.manifest.entryScene,
        resourceOrder: [],
        addBlobHashes: packageValue.blobs.map((blob) => blob.hash),
        reuseBlobHashes: [],
      },
      stagedBlobs,
      isCurrent: () => false,
    });
    expect(superseded).toBe("superseded");
    expect((await store.readSnapshot()).revision).toBe(snapshot.revision);
  });

  it("来源字节与声明不符时 staging 失败且不暴露任何内容", async () => {
    // 先让包声明一个未发布的新哈希，再把磁盘字节篡改成别的：plan 无法判 unchanged，必须进入 staging。
    await writeFile(path.join(outputDir, "geometry.glb"), Buffer.from("glb-store-unpublished"));
    const { packageValue, origins } = await builtPackage();
    await writeFile(path.join(outputDir, "geometry.glb"), Buffer.from("tampered-bytes"));
    const result = await store.createExecutor(origins).publish(packageValue);
    expect(result.status).toBe("failed");
    expect(result.failure).toContain("SHA-256");
    expect((await store.readSnapshot()).revision).toBe(2);
    expect((await readdir(path.join(rootDir, "tmp"))).filter((name) => name.endsWith(".part"))).toEqual([]);
    await writeFile(path.join(outputDir, "geometry.glb"), Buffer.from("glb-store-v1"));
  });

  it("来源缺失时发布失败", async () => {
    await writeFile(path.join(outputDir, "geometry.glb"), Buffer.from("glb-store-missing-source"));
    const { packageValue } = await builtPackage();
    const result = await store.createExecutor([]).publish(packageValue);
    expect(result.status).toBe("failed");
    expect(result.failure).toContain("找不到 blob");
    await writeFile(path.join(outputDir, "geometry.glb"), Buffer.from("glb-store-v1"));
  });
});
