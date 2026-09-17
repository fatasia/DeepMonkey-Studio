import multipart from "@fastify/multipart";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import { loadConfig } from "./config.js";
import { ConversionQueue } from "./conversion.js";
import { JsonStore } from "./jsonStore.js";
import { LocalObjectStore } from "./objects.js";
import { registerRoutes } from "./routes.js";
import { createApiServer } from "./serverOptions.js";

const directories: string[] = [];
const fixturePath = fileURLToPath(new URL(
  "../../../data/external-assets/format-fixtures/jt/voyager-example-block-jt10.3.jt",
  import.meta.url,
));
const assemblyFixturePath = fileURLToPath(new URL(
  "../../../data/external-assets/format-fixtures/jt/voyager-coffee-maker-jt9.5.jt",
  import.meta.url,
));
const converterFixturePath = fileURLToPath(new URL("./fixtures/fakeCadConverter.mjs", import.meta.url));

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JT upload inspection closure", () => {
  it("converts a real JT LOD0 and preserves viewing, selection and property access", async () => {
    const { app, dataDir, objects, store } = await createHarness();
    const response = await uploadJt(app, await readFile(fixturePath));
    expect(response.statusCode).toBe(202);
    const uploaded = response.json() as ModelRecord;
    await vi.waitFor(() => {
      expect(store.getProject("default")?.models.find((item) => item.id === uploaded.id)?.status).toBe("ready");
    }, { timeout: 5_000, interval: 25 });

    const model = store.getProject("default")!.models.find((item) => item.id === uploaded.id)!;
    expect(model).toMatchObject({ status: "ready", progress: 100 });
    expect(model.message).toContain("12 个三角面");
    expect(model.manifest).toMatchObject({
      sourceFormat: "jt",
      viewerKind: "gltf",
      geometryUrl: expect.stringContaining("geometry.glb"),
      hierarchyUrl: expect.stringContaining("hierarchy.json"),
      propertiesUrl: expect.stringContaining("properties.json"),
      inspectionUrl: expect.stringContaining("inspection.json"),
    });
    const outputDir = path.join(dataDir, "projects", "default", "models", uploaded.id, "output");
    await expect(access(path.join(outputDir, "geometry.glb"))).resolves.toBeUndefined();
    expect(await objects.stat(`projects/default/models/${uploaded.id}/output/inspection.json`)).toBe(true);
    const geometryResponse = await app.inject({ method: "GET", url: model.manifest!.geometryUrl! });
    expect(geometryResponse.statusCode).toBe(200);
    expect(geometryResponse.headers["content-type"]).toContain("model/gltf-binary");
    const glb = await new NodeIO().readBinary(new Uint8Array(geometryResponse.rawPayload));
    const geometry = glbEvidence(glb);
    expect(geometry).toEqual({
      meshCount: 1,
      primitiveCount: 6,
      triangleCount: 12,
      bounds: { min: [0, 0, 0], max: [100, 80, 60] },
    });

    const meshNode = glb.getRoot().listNodes().find((node) => node.getExtras().NodeType === "Element");
    const elementId = meshNode?.getExtras().ElementId;
    expect(elementId).toMatch(/^jt-instance:.*:lod-0:path-0\//);
    const [propertiesResponse, hierarchyResponse] = await Promise.all([
      app.inject({ method: "GET", url: model.manifest!.propertiesUrl! }),
      app.inject({ method: "GET", url: model.manifest!.hierarchyUrl! }),
    ]);
    expect(propertiesResponse.statusCode).toBe(200);
    expect(hierarchyResponse.statusCode).toBe(200);
    expect(propertiesResponse.json().elements[elementId as string]).toMatchObject({
      elementId,
      displayProperties: { 类型: "JT 网格实例", 三角面数: "12" },
    });
    expect(hierarchyResponse.json().root.meshIds).toContain(elementId);

    const inspectionResponse = await app.inject({
      method: "GET",
      url: `/api/projects/default/models/${uploaded.id}/format-probe`,
    });
    expect(inspectionResponse.statusCode).toBe(200);
    expect(inspectionResponse.json()).toMatchObject({
      status: "geometry-supported",
      geometryParsed: true,
      toc: { entryCount: 9 },
      assembly: { nodeCount: 11 },
      properties: { atomCount: 67 },
      materials: expect.arrayContaining([expect.objectContaining({ objectId: 8 })]),
      geometry: { status: "decoded", meshCount: 3, lod0MeshCount: 1, lod0InstanceCount: 1, vertexCount: 8, triangleCount: 12 },
    });
    await app.close();
  });

  it("keeps a structurally valid JT without a supported LOD0 in waiting_converter", async () => {
    const { app, dataDir, store } = await createHarness();
    const bytes = withoutGeometrySegments(await readFile(fixturePath));
    const response = await uploadJt(app, bytes, "unsupported-lod.jt");
    const uploaded = response.json() as ModelRecord;
    await vi.waitFor(() => {
      expect(store.getProject("default")?.models.find((item) => item.id === uploaded.id)?.status).toBe("waiting_converter");
    }, { timeout: 5_000, interval: 25 });

    const model = store.getProject("default")!.models.find((item) => item.id === uploaded.id)!;
    expect(model).toMatchObject({ status: "waiting_converter", progress: 40 });
    expect(model.manifest).toMatchObject({
      sourceFormat: "jt",
      hierarchyUrl: expect.stringContaining("hierarchy.json"),
      propertiesUrl: expect.stringContaining("properties.json"),
      inspectionUrl: expect.stringContaining("inspection.json"),
    });
    expect(model.manifest?.geometryUrl).toBeUndefined();
    expect(model.manifest?.viewerKind).toBeUndefined();
    const outputDir = path.join(dataDir, "projects", "default", "models", uploaded.id, "output");
    await expect(access(path.join(outputDir, "geometry.glb"))).rejects.toThrow();
    expect(JSON.parse(await readFile(path.join(outputDir, "inspection.json"), "utf8"))).toMatchObject({
      status: "structure-read",
      geometryParsed: false,
      geometry: { status: "not-decoded", meshCount: 0, lod0MeshCount: 0, lod0InstanceCount: 0, triangleCount: 0 },
    });
    await app.close();
  });

  it("hands a valid unsupported JT to the configured industrial converter and preserves inspection evidence", async () => {
    const { app, dataDir, store } = await createHarness(true);
    const response = await uploadJt(app, withoutGeometrySegments(await readFile(fixturePath)), "external-lod.jt");
    const uploaded = response.json() as ModelRecord;
    await vi.waitFor(() => {
      expect(store.getProject("default")?.models.find((item) => item.id === uploaded.id)?.status).toBe("ready");
    }, { timeout: 5_000, interval: 25 });

    const model = store.getProject("default")!.models.find((item) => item.id === uploaded.id)!;
    expect(model).toMatchObject({ status: "ready", progress: 100 });
    expect(model.manifest).toMatchObject({
      sourceFormat: "jt",
      viewerKind: "gltf",
      geometryUrl: expect.stringContaining("geometry.glb"),
      inspectionUrl: expect.stringContaining("inspection.json"),
    });
    const outputDir = path.join(dataDir, "projects", "default", "models", uploaded.id, "output");
    expect(JSON.parse(await readFile(path.join(outputDir, "inspection.json"), "utf8"))).toMatchObject({
      status: "structure-read",
      geometryParsed: false,
      toc: { entryCount: 9 },
    });
    await app.close();
  });

  it("publishes JT 9.5 mesh instances with their accumulated assembly transforms", async () => {
    const { app, store } = await createHarness();
    const response = await uploadJt(app, await readFile(assemblyFixturePath), "coffee-maker.jt");
    const uploaded = response.json() as ModelRecord;
    await vi.waitFor(() => {
      expect(store.getProject("default")?.models.find((item) => item.id === uploaded.id)?.status).toBe("ready");
    }, { timeout: 5_000, interval: 25 });
    const model = store.getProject("default")!.models.find((item) => item.id === uploaded.id)!;
    expect(model.message).toContain("44 个网格、64 个装配实例");
    const geometryResponse = await app.inject({ method: "GET", url: model.manifest!.geometryUrl! });
    const glb = await new NodeIO().readBinary(new Uint8Array(geometryResponse.rawPayload));
    const nodes = glb.getRoot().listNodes().filter((node) => node.getMesh());
    expect(glb.getRoot().listMeshes()).toHaveLength(44);
    expect(nodes).toHaveLength(64);
    const transformed = nodes.find((node) => node.getMatrix().some((value, index) => value !== IDENTITY[index]));
    expect(transformed).toBeDefined();
    const properties = (await app.inject({ method: "GET", url: model.manifest!.propertiesUrl! })).json();
    expect(properties.model).toMatchObject({ meshCount: 44, instanceCount: 64, triangleCount: 47_962 });
    expect(properties.elements[transformed!.getExtras().ElementId as string]).toBeDefined();
    await app.close();
  });
});

async function createHarness(withIndustrialConverter = false) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bim-jt-acceptance-"));
  directories.push(dataDir);
  const store = new JsonStore(dataDir);
  await store.init();
  const objects = new LocalObjectStore(dataDir);
  const config = loadConfig();
  config.dataDir = dataDir;
  config.industrialCad = withIndustrialConverter
    ? {
        command: process.execPath,
        args: [
          converterFixturePath,
          "--input", "{input}",
          "--output", "{output}",
          "--format", "{format}",
          "--include-pmi", "{includePmi}",
        ],
        cwd: process.cwd(),
      }
    : { args: [], cwd: process.cwd() };
  const queue = new ConversionQueue(store, config, objects);
  const app = createApiServer();
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
  await registerRoutes(app, { store, queue, objects, dataDir, config });
  return { app, dataDir, objects, store };
}

async function uploadJt(app: ReturnType<typeof createApiServer>, bytes: Uint8Array, fileName = "example.jt") {
  const form = new FormData();
  form.append("file", new Blob([bytes]), fileName);
  const encoded = new Response(form);
  return app.inject({
    method: "POST",
    url: "/api/projects/default/models",
    headers: { "content-type": encoded.headers.get("content-type")! },
    payload: Buffer.from(await encoded.arrayBuffer()),
  });
}

/** 仅改写 TOC 的 LOD 类型，保留同一真实文件的 LSG、属性和材质证据。 */
function withoutGeometrySegments(source: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(source);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tocOffset = Number(view.getBigUint64(85, true));
  const entryCount = view.getUint32(tocOffset, true);
  for (let index = 0; index < entryCount; index += 1) {
    const attributesOffset = tocOffset + 4 + index * 32 + 28;
    const attributes = view.getUint32(attributesOffset, true);
    const type = attributes >>> 24;
    if (type >= 7 && type <= 16) view.setUint32(attributesOffset, (17 << 24) | (attributes & 0x00ff_ffff), true);
  }
  return bytes;
}

function glbEvidence(document: Awaited<ReturnType<NodeIO["readBinary"]>>) {
  const meshes = document.getRoot().listMeshes();
  let primitiveCount = 0;
  let triangleCount = 0;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    for (const primitive of mesh.listPrimitives()) {
      primitiveCount += 1;
      triangleCount += (primitive.getIndices()?.getCount() ?? 0) / 3;
      const positions = primitive.getAttribute("POSITION")?.getArray();
      if (!positions) continue;
      for (let offset = 0; offset < positions.length; offset += 3) {
        for (let axis = 0; axis < 3; axis += 1) {
          minimum[axis] = Math.min(minimum[axis]!, positions[offset + axis]!);
          maximum[axis] = Math.max(maximum[axis]!, positions[offset + axis]!);
        }
      }
    }
  }
  return { meshCount: meshes.length, primitiveCount, triangleCount, bounds: { min: minimum, max: maximum } };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
