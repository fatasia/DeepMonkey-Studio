import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateDeepAssetPackage } from "@bim-studio/deep-engine";
import type { ModelRecord } from "@bim-studio/contracts";
import {
  buildCadCompatibilityProfile, COLLIDER_SIDECAR_FILE, detectColliderDerivativeEvidence,
  determinePhysicsReadiness, publishModelDeepAssetPackage,
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

describe("D1 colliders facet 证据分级", () => {
  const evidence = {
    evidenceId: "physics:colliders",
    strategy: "convex-hull" as const,
    evidenceSha256: "b".repeat(64),
  };

  it("无 collider 证据：colliders facet 保持 unverified 且带 reason", () => {
    const profile = buildCadCompatibilityProfile("step", "opencascade-step", "1",
      { hierarchy: true, properties: true, colliderEvidence: null });
    expect(profile.facets.colliders.status).toBe("unverified");
    expect(profile.facets.colliders.evidenceIds).toHaveLength(0);
    expect(profile.facets.colliders.reason).toBeTruthy();
  });

  it("有 collider 证据：colliders facet 标 partial 并附证据 id，不虚标 verified", () => {
    const profile = buildCadCompatibilityProfile("step", "opencascade-step", "1",
      { hierarchy: true, properties: true, colliderEvidence: evidence });
    expect(profile.facets.colliders.status).toBe("partial");
    expect(profile.facets.colliders.evidenceIds).toEqual(["physics:colliders"]);
    expect(profile.facets.colliders.reason).toBeTruthy();
  });

  it("省略 collider 选项时行为与显式 null 一致（向后兼容）", () => {
    const profile = buildCadCompatibilityProfile("step", "opencascade-step", "1", { hierarchy: false, properties: false });
    expect(profile.facets.colliders.status).toBe("unverified");
  });
});

describe("D1 detectColliderDerivativeEvidence", () => {
  let colliderDir: string;

  beforeAll(async () => {
    colliderDir = await mkdtemp(path.join(tmpdir(), "collider-evidence-"));
  });

  afterAll(async () => {
    await rm(colliderDir, { recursive: true, force: true });
  });

  const write = (content: string): Promise<void> =>
    writeFile(path.join(colliderDir, COLLIDER_SIDECAR_FILE), content, "utf8");

  it("无 colliders.json → null", async () => {
    expect(await detectColliderDerivativeEvidence(colliderDir)).toBeNull();
  });

  it("损坏 JSON / schemaVersion 不符 / colliders 为空 → null", async () => {
    await write("{not-json");
    expect(await detectColliderDerivativeEvidence(colliderDir)).toBeNull();
    await write(JSON.stringify({ schemaVersion: 2, colliders: [{ strategy: "convex-hull", status: "ok" }] }));
    expect(await detectColliderDerivativeEvidence(colliderDir)).toBeNull();
    await write(JSON.stringify({ schemaVersion: 1, colliders: [] }));
    expect(await detectColliderDerivativeEvidence(colliderDir)).toBeNull();
  });

  it("条目全 failed → null（不存在可消费派生物）", async () => {
    await write(JSON.stringify({ schemaVersion: 1, colliders: [{ strategy: "convex-hull", status: "failed" }] }));
    expect(await detectColliderDerivativeEvidence(colliderDir)).toBeNull();
  });

  it("存在 ok 条目 → 证据携带内容哈希与策略", async () => {
    const content = JSON.stringify({ schemaVersion: 1, colliders: [
      { strategy: "convex-hull", status: "ok", approximate: false },
      { strategy: "convex-hull", status: "failed" },
    ] });
    await write(content);
    const found = await detectColliderDerivativeEvidence(colliderDir);
    expect(found).not.toBeNull();
    expect(found!.evidenceId).toBe("physics:colliders");
    expect(found!.strategy).toBe("convex-hull");
    expect(found!.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(found!.approximate).toBeUndefined();
  });

  it("任一 approximate → approximate=true；策略混合 → mixed", async () => {
    await write(JSON.stringify({ schemaVersion: 1, colliders: [
      { strategy: "convex-hull", status: "approximate" },
      { strategy: "simplified-mesh", status: "ok" },
    ] }));
    const found = await detectColliderDerivativeEvidence(colliderDir);
    expect(found!.approximate).toBe(true);
    expect(found!.strategy).toBe("mixed");
  });
});

describe("D1 determinePhysicsReadiness", () => {
  const evidence = {
    evidenceId: "physics:colliders",
    strategy: "convex-hull" as const,
    evidenceSha256: "b".repeat(64),
  };
  const profile = (colliderEvidence: typeof evidence | null) =>
    buildCadCompatibilityProfile("step", "opencascade-step", "1",
      { hierarchy: true, properties: true, colliderEvidence });

  it("inspect/preview 质量档直接 geometry-only，即使证据齐全（不冒充 ready）", () => {
    for (const tier of ["inspect", "preview"] as const) {
      const declaration = determinePhysicsReadiness({ profile: profile(evidence), colliderEvidence: evidence, qualityTier: tier });
      expect(declaration.tier).toBe("geometry-only");
      expect(declaration.reason).toContain("inspect/preview");
    }
  });

  it("colliders facet unverified（无证据）→ geometry-only", () => {
    const declaration = determinePhysicsReadiness({ profile: profile(null), colliderEvidence: null, qualityTier: "visual-complete" });
    expect(declaration.tier).toBe("geometry-only");
  });

  it("colliders facet 已标注但证据缺失 → geometry-only，不凭 facet 空声明 ready", () => {
    const annotated = {
      ...profile(evidence),
      facets: { ...profile(evidence).facets, colliders: { status: "partial" as const, evidenceIds: ["physics:colliders"], reason: "r" } },
    };
    const declaration = determinePhysicsReadiness({ profile: annotated, colliderEvidence: null, qualityTier: "visual-complete" });
    expect(declaration.tier).toBe("geometry-only");
  });

  it("证据与 profile 证据 id 脱钩 → 保守 geometry-only", () => {
    const declaration = determinePhysicsReadiness({
      profile: profile(evidence),
      colliderEvidence: { ...evidence, evidenceId: "physics:other" },
      qualityTier: "visual-complete",
    });
    expect(declaration.tier).toBe("geometry-only");
  });

  it("几何 verified + colliders partial + 证据一致 → physics-ready 并携带证据", () => {
    const declaration = determinePhysicsReadiness({ profile: profile(evidence), colliderEvidence: evidence, qualityTier: "visual-complete" });
    expect(declaration.tier).toBe("physics-ready");
    expect(declaration.colliderEvidence?.evidenceId).toBe("physics:colliders");
  });

  it("近似 collider 可 physics-ready，但必须带机器可读近似说明", () => {
    const approximate = { ...evidence, approximate: true as const };
    const declaration = determinePhysicsReadiness({ profile: profile(approximate), colliderEvidence: approximate, qualityTier: "visual-complete" });
    expect(declaration.tier).toBe("physics-ready");
    expect(declaration.reason).toContain("近似");
  });
});
