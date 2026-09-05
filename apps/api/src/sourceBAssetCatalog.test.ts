import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSourceBEntries } from "./sourceBAssetCatalog.js";
import { AssetLibraryCatalog } from "./assetLibraryCatalog.js";

const roots: string[] = [];
const uid = "a".repeat(32);
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("verified community catalog", () => {
  it("requires publication plus matching evidence and retains exact attribution", async () => {
    const fixture = await createFixture();
    const items = await loadSourceBEntries(fixture.root);
    expect(items).toHaveLength(1);
    expect(items[0]?.publicItem).toMatchObject({ name: "工业夹爪", license: "CC-BY-4.0", attribution: { author: "Maker", text: fixture.model.attribution } });
    fixture.model.publicationStatus = "review-required";
    await fixture.save();
    expect(await loadSourceBEntries(fixture.root)).toEqual([]);
  });

  it.each(["hash", "thumbnail", "license", "author", "path", "renderer", "metrics"])("excludes a %s mismatch", async kind => {
    const fixture = await createFixture();
    if (kind === "hash") fixture.review.contentHash = "0".repeat(64);
    if (kind === "thumbnail") fixture.review.thumbnail.modelHash = "0".repeat(64);
    if (kind === "license") fixture.model.licenseUrl = "https://creativecommons.org.attacker.invalid/licenses/by/4.0/";
    if (kind === "author") fixture.model.author = "";
    if (kind === "path") fixture.review.thumbnail.relativePath = "../outside.png";
    if (kind === "renderer") fixture.review.thumbnail.renderer = "source-promotion";
    if (kind === "metrics") fixture.model.modelAudit.externalUris = ["https://other.invalid/image.png"];
    await fixture.save();
    expect(await loadSourceBEntries(fixture.root)).toEqual([]);
  });

  it("checks actual bytes instead of trusting review metadata", async () => {
    const fixture = await createFixture();
    const file = path.join(fixture.root, `models/${uid}.glb`);
    const original = await readFile(file);
    await writeFile(file, "tampered");
    expect(await loadSourceBEntries(fixture.root)).toEqual([]);
    await writeFile(file, original);
    await writeFile(path.join(fixture.root, fixture.review.thumbnail.relativePath), "not a PNG");
    expect(await loadSourceBEntries(fixture.root)).toEqual([]);
  });

  it("reloads changed catalogs and recovers after malformed metadata is repaired", async () => {
    const fixture = await createFixture();
    const sourceA = path.join(fixture.root, "source-a");
    await mkdir(sourceA);
    await writeFile(path.join(sourceA, "catalog.json"), '{"models":[],"files":[]}');
    await writeFile(path.join(sourceA, "audit.json"), '{"items":[]}');
    const catalog = new AssetLibraryCatalog(sourceA, undefined, fixture.root);
    expect((await catalog.list()).total).toBe(1);
    fixture.review.displayName = "新名称：视觉复核后的工业夹爪";
    await fixture.save();
    expect((await catalog.list()).items[0]?.name).toBe(fixture.review.displayName);
    await writeFile(path.join(fixture.root, "audit.json"), "{broken");
    await expect(catalog.list()).rejects.toThrow();
    await fixture.save();
    expect((await catalog.list()).total).toBe(1);
  });

  it("does not misreport null metadata as an empty library", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.root, "audit.json"), "null");
    await expect(loadSourceBEntries(fixture.root)).rejects.toThrow("视觉复核记录格式无效");
    await writeFile(path.join(fixture.root, "catalog.json"), "null");
    await expect(loadSourceBEntries(fixture.root)).rejects.toThrow("素材目录格式无效");
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "bim-source-b-catalog-")); roots.push(root);
  await Promise.all([mkdir(path.join(root, "models")), mkdir(path.join(root, "reviewed-thumbnails"))]);
  // Metadata fixture only; actual model rendering has a separate browser gate.
  const modelBytes = Buffer.from("fixture model bytes");
  const png = Buffer.alloc(24); Buffer.from("89504e470d0a1a0a", "hex").copy(png); png.writeUInt32BE(320, 16); png.writeUInt32BE(240, 20);
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const model = {
    uid, name: "Original Gripper", fileName: `${uid}.glb`, bytes: modelBytes.length, sha256: hash(modelBytes),
    license: "CC-BY-4.0", author: "Maker", originUrl: `https://sketchfab.com/3d-models/${uid}`,
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/", attribution: "Original Gripper — Maker / Sketchfab · CC-BY-4.0", modifications: "GLB未修改；重新渲染预览图",
    publicationStatus: "published", modelAudit: { valid: true, sha256: hash(modelBytes), meshCount: 1, primitiveCount: 1, triangleCount: 3, materialCount: 1, textureCount: 0, animationCount: 0, externalUris: [] as string[] },
  };
  const review = { uid, contentHash: model.sha256, status: "approved", reviewedAt: new Date().toISOString(), displayName: "工业夹爪", category: "工位与机器人", tags: ["夹爪"],
    thumbnail: { relativePath: `reviewed-thumbnails/${uid}.png`, sha256: hash(png), modelHash: model.sha256, renderer: "studio-webgl", width: 320, height: 240 } };
  const save = async () => {
    await writeFile(path.join(root, "catalog.json"), JSON.stringify({ schemaVersion: 1, source: "sketchfab", models: [model] }));
    await writeFile(path.join(root, "audit.json"), JSON.stringify({ schemaVersion: 1, items: [review] }));
  };
  await writeFile(path.join(root, `models/${uid}.glb`), modelBytes);
  await writeFile(path.join(root, review.thumbnail.relativePath), png);
  await save();
  return { root, model, review, save };
}
