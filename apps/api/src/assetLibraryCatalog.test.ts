import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssetLibraryCatalog } from "./assetLibraryCatalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AssetLibraryCatalog", () => {
  it("lists normalized assets with search, filters and stable pagination", async () => {
    const root = await createFixture();
    const catalog = new AssetLibraryCatalog(root);

    const firstPage = await catalog.list({ pageSize: 1 });
    expect(firstPage.total).toBe(2);
    expect(firstPage.totalPages).toBe(2);
    expect(firstPage.items[0]).toMatchObject({ id: "industrial-10", name: "六轴机械臂", dimension: "3d" });
    expect(firstPage.categories).toContainEqual({ id: "工业场景", name: "工业场景", count: 2 });

    const searched = await catalog.list({ search: "输送", animated: false });
    expect(searched.items.map((item) => item.id)).toEqual(["industrial-11"]);
  });

  it("removes external product names from customer-facing metadata", async () => {
    const root = await createFixture({ brandedName: true });
    const item = (await new AssetLibraryCatalog(root).list({ search: "机械臂" })).items[0];
    expect(item?.name).toBe("六轴机械臂");
    expect(JSON.stringify(item)).not.toMatch(/帆软|ThingJS/i);
  });

  it("rejects catalog paths that escape the configured offline directory", async () => {
    const root = await createFixture({ escapedPath: true });
    await expect(new AssetLibraryCatalog(root).list()).rejects.toThrow("越界路径");
  });

  it("merges verified HDRI and expanded PBR maps into the same searchable catalog", async () => {
    const root = await createFixture();
    const resources = await createEnvironmentMaterialFixture();
    const catalog = new AssetLibraryCatalog(root, resources);

    const materials = await catalog.list({ dimension: "material", search: "钢板" });
    expect(materials.items).toEqual([
      expect.objectContaining({
        id: "material-steel_plate",
        name: "工业钢板",
        format: "pbr",
        version: "1.0.0",
        license: "CC0-1.0",
        publicationStatus: "published",
        mapKinds: ["base-color", "normal", "roughness", "metalness"],
      }),
    ]);
    expect(materials.categories).toEqual([{ id: "金属表面", name: "金属表面", count: 1 }]);
    expect((await catalog.list({ dimension: "environment" })).items[0]).toMatchObject({ id: "environment-workshop", format: "hdr" });
    expect((await catalog.list()).dimensions).toEqual(expect.arrayContaining([
      { id: "3d", name: "3d", count: 2 },
      { id: "material", name: "material", count: 1 },
      { id: "environment", name: "environment", count: 1 },
    ]));
  });

  it("rejects traversal and never accepts a zip as an expanded PBR map", async () => {
    const root = await createFixture();
    const resources = await createEnvironmentMaterialFixture({ unsafeMap: "escaped" });
    await expect(new AssetLibraryCatalog(root, resources).list()).rejects.toThrow("非法文件名");

    const zipResources = await createEnvironmentMaterialFixture({ unsafeMap: "zip" });
    expect((await new AssetLibraryCatalog(root, zipResources).list({ dimension: "material" })).items).toEqual([]);
  });
});

async function createFixture(options: { brandedName?: boolean; escapedPath?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bim-assets-"));
  temporaryDirectories.push(root);
  await Promise.all([mkdir(path.join(root, "models")), mkdir(path.join(root, "thumbnails"))]);
  const models = [
    { id: 10, name: `${options.brandedName ? "帆软 " : ""}六轴机械臂`, downloadTotal: 20, haveAnimation: true, type: { name: "工业场景" }, element: { name: "机器人" }, style: { name: "写实" } },
    { id: 11, name: "皮带输送线", downloadTotal: 10, haveAnimation: false, type: { name: "工业场景" }, element: { name: "输送设备" }, style: { name: "写实" } },
  ];
  const files = models.flatMap((model) => [
    { modelId: model.id, kind: "model", relativePath: options.escapedPath && model.id === 10 ? "../outside.glb" : `models/${model.id}.glb`, bytes: 32, sha256: `hash-${model.id}` },
    { modelId: model.id, kind: "thumbnail", relativePath: `thumbnails/${model.id}.png`, bytes: 16, sha256: `thumb-${model.id}` },
  ]);
  const auditItems = models.map((model) => ({ sourceModelId: String(model.id), valid: true, triangleCount: model.id * 10, meshCount: 2, materialCount: 1, textureCount: 1, animationCount: model.haveAnimation ? 1 : 0, qualityTier: "light" }));
  await Promise.all([
    writeFile(path.join(root, "catalog.json"), JSON.stringify({ models, files })),
    writeFile(path.join(root, "audit.json"), JSON.stringify({ items: auditItems })),
    ...models.flatMap((model) => [writeFile(path.join(root, "models", `${model.id}.glb`), "glb"), writeFile(path.join(root, "thumbnails", `${model.id}.png`), "png")]),
  ]);
  return root;
}

async function createEnvironmentMaterialFixture(options: { unsafeMap?: "escaped" | "zip" } = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bim-appearance-assets-"));
  temporaryDirectories.push(root);
  const assets = [
    {
      id: "workshop", category: "environment", name: "车间环境", tags: ["industrial"],
      maps: [{ kind: "environment", fileName: "environment.hdr" }], license: "CC0-1.0", publicationStatus: "review-required",
      files: [file("environment.hdr", "hdr"), file("thumbnail.png", "thumb")], totalBytes: 8,
    },
    {
      id: "steel_plate", category: "material", name: "工业钢板", tags: ["metal"],
      maps: [
        { kind: "base-color", fileName: options.unsafeMap === "escaped" ? "../outside.jpg" : options.unsafeMap === "zip" ? "base-color.zip" : "base-color.jpg" },
        { kind: "normal", fileName: "normal.jpg" }, { kind: "roughness", fileName: "roughness.jpg" }, { kind: "metalness", fileName: "metalness.jpg" },
      ], license: "CC0-1.0", publicationStatus: "published",
      files: [
        file(options.unsafeMap === "escaped" ? "../outside.jpg" : options.unsafeMap === "zip" ? "base-color.zip" : "base-color.jpg", "base"), file("normal.jpg", "normal"),
        file("roughness.jpg", "rough"), file("metalness.jpg", "metal"), file("thumbnail.png", "thumb"),
      ], totalBytes: 24,
    },
  ];
  for (const asset of assets) {
    await mkdir(path.join(root, asset.category, asset.id), { recursive: true });
    for (const item of asset.files) {
      if (item.fileName.includes("..")) continue;
      await writeFile(path.join(root, asset.category, asset.id, item.fileName), item.content);
    }
  }
  await writeFile(path.join(root, "catalog.json"), JSON.stringify({ schemaVersion: 1, assets: assets.map((asset) => ({ ...asset, files: asset.files.map(({ content, ...item }) => item) })) }));
  return root;
}

function file(fileName: string, content: string) {
  return { fileName, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex"), content };
}
