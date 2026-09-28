import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateDeepAssetPackage } from "@bim-studio/deep-engine";
import type { ModelRecord } from "@bim-studio/contracts";
import {
  buildCadCompatibilityProfile, publishModelDeepAssetPackage,
} from "./deepAssetPackagePipeline.js";
import { createFileSystemDeepAssetPackageStore } from "./deepAssetPackageStore.js";

let rootDir: string;
let modelDir: string;
let sourcePath: string;
let store: ReturnType<typeof createFileSystemDeepAssetPackageStore>;

const model = (): Pick<ModelRecord, "id" | "projectId" | "name" | "format"> => ({
  id: "0f0e0d0c-1111-2222-3333-444455556666",
  projectId: "proj-1",
  name: "bracket",
  format: "step",
});

beforeAll(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "deep-asset-pipeline-root-"));
  modelDir = await mkdtemp(path.join(tmpdir(), "deep-asset-pipeline-model-"));
  sourcePath = path.join(modelDir, "bracket.step");
  await mkdir(path.join(modelDir, "output"), { recursive: true });
  await writeFile(sourcePath, Buffer.from("step-source-v1"));
  await writeFile(path.join(modelDir, "output", "geometry.glb"), Buffer.from("glb-pipeline-v1"));
  await writeFile(path.join(modelDir, "output", "hierarchy.json"), JSON.stringify({ nodes: 2 }));
  await writeFile(path.join(modelDir, "output", "properties.json"), JSON.stringify({ mass: 12 }));
  store = createFileSystemDeepAssetPackageStore(rootDir, () => Promise.resolve(undefined));
});

afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true });
  await rm(modelDir, { recursive: true, force: true });
});

const publish = () => publishModelDeepAssetPackage({
  store,
  model: model(),
  sourcePath,
  modelDir,
  importer: { id: "opencascade-step", version: "1" },
  compatibility: buildCadCompatibilityProfile("step", "opencascade-step", "1", { hierarchy: true, properties: true }),
});

describe("publishModelDeepAssetPackage", () => {
  let firstSourceHash = "";

  it("生产并持久化合法资产包，manifest 引用携带存储身份与修订号", async () => {
    const published = await publish();
    expect(published?.status).toBe("committed");
    expect(published?.revision).toBe(1);
    const reference = published!.reference;
    expect(reference.packageId).toBe(`pkg:${model().id}`);
    expect(reference.entryScene).toBe("scene:main");
    expect(reference.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(reference.packageUrl).toContain("/output/deep-package.json");
    const stored = JSON.parse(await readFile(path.join(modelDir, "output", "deep-package.json"), "utf8"));
    expect(stored.revision).toBe(1);
    const validation = validateDeepAssetPackage(stored.package);
    expect(validation.valid).toBe(true);
    expect(stored.package.manifest.packageId).toBe(reference.packageId);
    firstSourceHash = reference.sourceHash;
  });

  it("同源重跑判定 unchanged，修订号保持", async () => {
    const second = await publish();
    expect(second?.status).toBe("unchanged");
    expect(second?.revision).toBe(1);
  });

  it("模型文件变更 → 新修订发布，未变 sidecar 复用（依赖最小失效）", async () => {
    await writeFile(sourcePath, Buffer.from("step-source-v2"));
    await writeFile(path.join(modelDir, "output", "geometry.glb"), Buffer.from("glb-pipeline-v2"));
    const third = await publish();
    expect(third?.status).toBe("committed");
    expect(third?.revision).toBe(2);
    expect(third?.addedBlobs).toBeGreaterThan(0);
    expect(third?.reusedBlobs).toBeGreaterThan(0);
    const stored = JSON.parse(await readFile(path.join(modelDir, "output", "deep-package.json"), "utf8"));
    expect(stored.revision).toBe(2);
    expect(stored.sourceHash).not.toBe(firstSourceHash);
  });

  it("兼容性 profile 声明与实际证据一致：几何/层级/属性 verified，其余 unverified", () => {
    const profile = buildCadCompatibilityProfile("step", "opencascade-step", "1", { hierarchy: true, properties: false });
    expect(profile.facets.geometry.status).toBe("verified");
    expect(profile.facets.hierarchy.status).toBe("verified");
    expect(profile.facets.metadata.status).toBe("unverified");
    expect(profile.facets.animation.status).toBe("unverified");
    expect(profile.facets.animation.reason).toBeTruthy();
    expect(profile.runtimeArtifact).toBe("deep-asset-package");
  });
});
