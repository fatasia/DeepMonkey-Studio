import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import type { ModelRecord, ProjectRecord } from "@bim-studio/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAssetLibraryRoutes } from "./assetLibraryRoutes.js";
import type { ConversionQueue } from "./conversion.js";
import type { ObjectStore } from "./objects.js";
import type { MetadataStore } from "./store.js";

const directories: string[] = [];
const modelHash = createHash("sha256").update("model-binary").digest("hex");

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("asset library routes", () => {
  it("lists, previews and imports an offline asset into the existing model pipeline", async () => {
    const root = await createLibraryFixture();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "bim-asset-project-"));
    directories.push(dataDir);
    await createAppearanceFixture(dataDir);
    const project = projectFixture();
    const queued: Array<{ model: ModelRecord; sourcePath: string; modelDir: string }> = [];
    const app = Fastify();
    await registerAssetLibraryRoutes(app, {
      dataDir,
      libraryDir: root,
      store: storeFixture(project),
      queue: { enqueue: (context: (typeof queued)[number]) => queued.push(context) } as ConversionQueue,
      objects: { putFile: async () => undefined } as unknown as ObjectStore,
    });

    const list = await app.inject({ method: "GET", url: "/api/asset-library?q=机械臂&pageSize=1" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ total: 1, pageSize: 1, items: [{ id: "industrial-10", name: "六轴机械臂" }] });
    const linkedItem = await app.inject({ method: "GET", url: "/api/asset-library/items/industrial-10" });
    expect(linkedItem.statusCode).toBe(200);
    expect(linkedItem.json()).toMatchObject({ id: "industrial-10", name: "六轴机械臂" });
    expect(linkedItem.json()).not.toHaveProperty("modelPath");
    expect((await app.inject({ method: "GET", url: "/api/asset-library/items/missing" })).statusCode).toBe(404);

    const thumbnail = await app.inject({ method: "GET", url: "/api/public/asset-library/items/industrial-10/thumbnail" });
    expect(thumbnail.statusCode).toBe(200);
    expect(thumbnail.body).toBe("thumbnail");

    const imported = await app.inject({ method: "POST", url: "/api/projects/default/asset-library/industrial-10/import" });
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({ reused: false, model: { name: "六轴机械臂", format: "glb", status: "queued", libraryOrigin: { itemId: "industrial-10", contentHash: modelHash } } });
    expect(queued).toHaveLength(1);
    expect(await readFile(queued[0]!.sourcePath, "utf8")).toBe("model-binary");

    const repeated = await app.inject({ method: "POST", url: "/api/projects/default/asset-library/industrial-10/import" });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ reused: true, model: { id: imported.json().model.id } });
    expect(queued).toHaveLength(1);

    const nature = await app.inject({ method: "GET", url: "/api/asset-library?q=fence%20gate&dimension=3d&pageSize=5" });
    expect(nature.statusCode).toBe(200);
    expect(nature.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "kenney.nature-kit.fence_gate", category: "环境搭建", publicationStatus: "published" }),
    ]));
    const natureImport = await app.inject({ method: "POST", url: "/api/projects/default/asset-library/kenney.nature-kit.fence_gate/import" });
    expect(natureImport.statusCode).toBe(201);
    expect(natureImport.json()).toMatchObject({ reused: false, model: { format: "glb", libraryOrigin: { itemId: "kenney.nature-kit.fence_gate", attribution: { author: "Kenney" } } } });
    expect(queued).toHaveLength(2);
    const natureBytes = await readFile(queued[1]!.sourcePath);
    expect(natureBytes.readUInt32LE(0)).toBe(0x46546c67);
    expect(createHash("sha256").update(natureBytes).digest("hex")).toBe(natureImport.json().model.libraryOrigin.contentHash);
    const natureRepeat = await app.inject({ method: "POST", url: "/api/projects/default/asset-library/kenney.nature-kit.fence_gate/import" });
    expect(natureRepeat.statusCode).toBe(200);
    expect(natureRepeat.json()).toMatchObject({ reused: true, model: { id: natureImport.json().model.id } });
    expect(queued).toHaveLength(2);

    const materialList = await app.inject({ method: "GET", url: "/api/asset-library?dimension=material" });
    expect(materialList.json()).toMatchObject({ total: 1, items: [{ id: "material-steel", mapKinds: ["base-color", "normal", "roughness"] }] });
    const materialMaps = await app.inject({ method: "GET", url: "/api/asset-library/items/material-steel/maps" });
    expect(materialMaps.statusCode).toBe(200);
    expect(materialMaps.json()).toHaveLength(3);
    for (const map of materialMaps.json()) {
      const content = await app.inject({ method: "GET", url: map.url });
      expect(content.statusCode).toBe(200);
      expect(content.rawPayload.length).toBe(map.size);
    }
    expect((await app.inject({ method: "GET", url: "/api/asset-library/items/material-steel/maps/missing" })).statusCode).toBe(404);
    const material = await app.inject({ method: "POST", url: "/api/projects/default/asset-library/material-steel/import" });
    expect(material.statusCode).toBe(201);
    expect(material.json()).toMatchObject({
      kind: "resource",
      reused: false,
      asset: { kind: "pbr-material", libraryOrigin: { itemId: "material-steel", license: "CC0-1.0" }, maps: [{ kind: "base-color" }, { kind: "normal" }, { kind: "roughness" }] },
    });
    expect(project.assets).toHaveLength(1);
    const materialRepeat = await app.inject({ method: "POST", url: "/api/projects/default/asset-library/material-steel/import" });
    expect(materialRepeat.json()).toMatchObject({ kind: "resource", reused: true, asset: { id: material.json().asset.id } });

    const environment = await app.inject({ method: "POST", url: "/api/projects/default/asset-library/environment-workshop/import" });
    expect(environment.statusCode).toBe(201);
    expect(environment.json()).toMatchObject({
      kind: "resource",
      asset: { kind: "environment", url: expect.stringContaining("environment.hdr"), maps: [{ kind: "environment", mimeType: "image/vnd.radiance" }] },
    });
    expect(project.assets).toHaveLength(2);
    await app.close();
  });

  it("coalesces concurrent imports so only one model and conversion job are created", async () => {
    const root = await createLibraryFixture();
    const project = projectFixture();
    const putFile = vi.fn(async () => new Promise(resolve => setTimeout(resolve, 25)));
    const enqueue = vi.fn();
    const app = Fastify();
    await registerAssetLibraryRoutes(app, {
      dataDir: root, libraryDir: root, store: storeFixture(project),
      queue: { enqueue } as unknown as ConversionQueue,
      objects: { putFile } as unknown as ObjectStore,
    });
    const responses = await Promise.all(Array.from({ length: 6 }, () => app.inject({ method: "POST", url: "/api/projects/default/asset-library/industrial-10/import" })));
    expect(responses.filter(response => response.statusCode === 201)).toHaveLength(1);
    expect(new Set(responses.map(response => response.json().model.id)).size).toBe(1);
    expect(putFile).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(project.models).toHaveLength(1);
    await app.close();
  });

  it("rejects changed model bytes before object storage or conversion", async () => {
    const root = await createLibraryFixture();
    const project = projectFixture();
    const putFile = vi.fn();
    const enqueue = vi.fn();
    const app = Fastify();
    await registerAssetLibraryRoutes(app, {
      dataDir: root, libraryDir: root, store: storeFixture(project),
      queue: { enqueue } as unknown as ConversionQueue,
      objects: { putFile, removePrefix: vi.fn() } as unknown as ObjectStore,
    });
    await writeFile(path.join(root, "models/10.glb"), "changed-model");
    const response = await app.inject({ method: "POST", url: "/api/projects/default/asset-library/industrial-10/import" });
    expect(response.statusCode).toBe(500);
    expect(response.json().message).toContain("完整性校验失败");
    expect(putFile).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(project.models).toEqual([]);
    expect(await readFile(path.join(root, "models/10.glb"), "utf8")).toBe("changed-model");
    await app.close();
  });

  it("rejects review-required resources even when the UI guard is bypassed", async () => {
    const root = await createLibraryFixture();
    await createAppearanceFixture(root, "review-required");
    const project = projectFixture();
    const putFile = vi.fn();
    const app = Fastify();
    await registerAssetLibraryRoutes(app, {
      dataDir: root, libraryDir: root, store: storeFixture(project),
      queue: {} as ConversionQueue, objects: { putFile } as unknown as ObjectStore,
    });
    const response = await app.inject({ method: "POST", url: "/api/projects/default/asset-library/environment-workshop/import" });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("待质量复核");
    expect(putFile).not.toHaveBeenCalled();
    expect(project.assets).toEqual([]);
    await app.close();
  });
});

function storeFixture(project: ProjectRecord): MetadataStore {
  return {
    getProject: (projectId: string) => projectId === project.id ? project : undefined,
    addModel: async (_projectId: string, model: ModelRecord) => { project.models.push(model); },
    saveAsset: async (_projectId: string, asset) => { project.assets ??= []; project.assets.push(asset); return asset; },
  } as unknown as MetadataStore;
}

async function createAppearanceFixture(dataDir: string, publicationStatus = "published"): Promise<void> {
  const root = path.join(dataDir, "external-assets", "environment-materials");
  const files = [appearanceFile("base-color.jpg", "base"), appearanceFile("normal.jpg", "normal"), appearanceFile("roughness.jpg", "rough"), appearanceFile("thumbnail.png", "thumb")];
  const environmentFiles = [appearanceFile("environment.hdr", "radiance"), appearanceFile("thumbnail.png", "environment-thumb")];
  const directory = path.join(root, "material", "steel");
  const environmentDirectory = path.join(root, "environment", "workshop");
  await Promise.all([mkdir(directory, { recursive: true }), mkdir(environmentDirectory, { recursive: true })]);
  await Promise.all(files.map((file) => writeFile(path.join(directory, file.fileName), file.content)));
  await Promise.all(environmentFiles.map((file) => writeFile(path.join(environmentDirectory, file.fileName), file.content)));
  await writeFile(path.join(root, "catalog.json"), JSON.stringify({
    schemaVersion: 1,
    assets: [
      {
        id: "steel", category: "material", name: "工业钢板", tags: ["metal"], license: "CC0-1.0", publicationStatus: "published",
        maps: [{ kind: "base-color", fileName: "base-color.jpg" }, { kind: "normal", fileName: "normal.jpg" }, { kind: "roughness", fileName: "roughness.jpg" }],
        files: files.map(({ content, ...file }) => file), totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      },
      {
        id: "workshop", category: "environment", name: "车间环境", tags: ["industrial"], license: "CC0-1.0", publicationStatus,
        maps: [{ kind: "environment", fileName: "environment.hdr" }],
        files: environmentFiles.map(({ content, ...file }) => file), totalBytes: environmentFiles.reduce((sum, file) => sum + file.bytes, 0),
      },
    ],
  }));
}

function appearanceFile(fileName: string, content: string) {
  return { fileName, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex"), content };
}

function projectFixture(): ProjectRecord {
  const now = new Date(0).toISOString();
  return { id: "default", name: "默认项目", description: "", models: [], assets: [], createdAt: now, updatedAt: now };
}

async function createLibraryFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bim-asset-library-"));
  directories.push(root);
  await Promise.all([mkdir(path.join(root, "models")), mkdir(path.join(root, "thumbnails"))]);
  const models = [{ id: 10, name: "六轴机械臂", downloadTotal: 8, haveAnimation: true, type: { name: "工业场景" }, element: { name: "机器人" } }];
  const files = [
    { modelId: 10, kind: "model", relativePath: "models/10.glb", bytes: 12, sha256: modelHash },
    { modelId: 10, kind: "thumbnail", relativePath: "thumbnails/10.png", bytes: 9, sha256: "thumb-hash" },
  ];
  const items = [{ sourceModelId: "10", valid: true, triangleCount: 1200, meshCount: 2, materialCount: 1, textureCount: 0, animationCount: 1, qualityTier: "light" }];
  await Promise.all([
    writeFile(path.join(root, "catalog.json"), JSON.stringify({ models, files })),
    writeFile(path.join(root, "audit.json"), JSON.stringify({ items })),
    writeFile(path.join(root, "models", "10.glb"), "model-binary"),
    writeFile(path.join(root, "thumbnails", "10.png"), "thumbnail"),
  ]);
  return root;
}
