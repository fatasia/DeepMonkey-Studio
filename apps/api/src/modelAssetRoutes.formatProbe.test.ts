import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import type { AppConfig } from "./config.js";
import type { ConversionQueue } from "./conversion.js";
import { minimalXtRevolvedSubsetFixture } from "./fixtures/minimalXtRevolvedSubset.js";
import { registerModelAssetRoutes } from "./modelAssetRoutes.js";
import type { ObjectStore } from "./objects.js";
import type { MetadataStore } from "./store.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("model format-probe route", () => {
  it("returns X_T header metadata and the exact verified geometry capability", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-format-route-"));
    directories.push(dataDir);
    const model = modelFixture("x_t");
    const sourcePath = path.join(dataDir, "projects", model.projectId, "models", model.id, "source", model.name);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, minimalXtRevolvedSubsetFixture());

    const app = Fastify();
    await registerModelAssetRoutes(app, {
      dataDir,
      store: { getProject: () => ({ id: model.projectId, models: [model] }) } as unknown as MetadataStore,
      queue: {} as ConversionQueue,
      objects: {} as ObjectStore,
      config: {} as AppConfig,
    });
    const response = await app.inject({ method: "GET", url: `/api/projects/${model.projectId}/models/${model.id}/format-probe` });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "geometry-supported",
      geometryParsed: true,
      schema: "SCH_2401231_20000_1300",
      topology: { bodies: { status: "decoded", count: 1 }, shells: { status: "not-decoded" } },
      metadata: { properties: "header-only", colors: "not-decoded" },
    });
  });

  it("将 X_B 分发到同一安全结构探测入口", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-format-route-"));
    directories.push(dataDir);
    const model = modelFixture();
    const sourcePath = path.join(dataDir, "projects", model.projectId, "models", model.id, "source", "part.x_b");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, neutralBinaryFixture());

    const app = Fastify();
    await registerModelAssetRoutes(app, {
      dataDir,
      store: { getProject: () => ({ id: model.projectId, models: [model] }) } as unknown as MetadataStore,
      queue: {} as ConversionQueue,
      objects: {} as ObjectStore,
      config: {} as AppConfig,
    });
    const response = await app.inject({ method: "GET", url: `/api/projects/${model.projectId}/models/${model.id}/format-probe` });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      recognizedFormat: "parasolid-x_b",
      encoding: "neutral-binary",
      probeScope: "structure-only",
      geometryParsed: false,
      version: { raw: "SCH_3100154_31001" },
    });
  });
});

function modelFixture(format: "x_t" | "x_b" = "x_b"): ModelRecord {
  const name = format === "x_t" ? "part.x_t" : "part.x_b";
  return {
    id: "model-1", projectId: "project-1", name, format, size: 1, status: "queued", progress: 0,
    message: "等待转换", sourceUrl: `/assets/projects/project-1/models/model-1/source/${name}`, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
}

function neutralBinaryFixture(): Uint8Array {
  const modeller = ": TRANSMIT FILE created by modeller version 3100154";
  const schema = "SCH_3100154_31001";
  const header = [
    "**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz*****************",
    "***********PARASOLID!\"#$%&'()*+,-./:;<=>?@[\\\\]^_`{|}~0123456789*********",
    "*******************PART1;", "APPL=Test; FORMAT=binary;", "**PART2;", "SCH=SCH_3100154_31001; USFLD_SIZE=0;", "**PART3;",
    "**END_OF_HEADER********************************************************",
  ].join("\n") + "\n";
  const prefix = new TextEncoder().encode(header);
  const payload = new Uint8Array(4 + 2 + modeller.length + 4 + schema.length + 4);
  payload.set([0x50, 0x53, 0, 0]);
  const view = new DataView(payload.buffer);
  view.setUint16(4, modeller.length, false);
  payload.set(new TextEncoder().encode(modeller), 6);
  const schemaOffset = 6 + modeller.length;
  view.setUint32(schemaOffset, schema.length, false);
  payload.set(new TextEncoder().encode(schema), schemaOffset + 4);
  view.setUint32(schemaOffset + 4 + schema.length, 0, false);
  const result = new Uint8Array(prefix.length + payload.length);
  result.set(prefix);
  result.set(payload, prefix.length);
  return result;
}
