import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ObjectStore } from "./objects.js";
import { createExternalConverterRegistrations } from "./externalConverterCatalog.js";
import { ConversionTaskService } from "./conversionTasks.js";

const objects = {} as ObjectStore;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("external converter catalog", () => {
  it("exposes only the retained RVT converter", () => {
    const registrations = createExternalConverterRegistrations({
      industrialCad: { args: [], cwd: process.cwd() },
      rvt: { args: [], cwd: process.cwd() },
    }, objects);

    expect(registrations.map((item) => item.manifest.id)).toEqual([
      "bim.revit-native",
    ]);
    expect(registrations.every((item) => item.execute === undefined)).toBe(true);
    expect(registrations.map((item) => item.provider?.status)).toEqual([
      "not_configured",
    ]);
    expect(registrations[0]?.manifest.outputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "geometry", format: "glb", required: true }),
      expect.objectContaining({ kind: "hierarchy", format: "json", required: true }),
      expect.objectContaining({ kind: "pmi", format: "json", required: false }),
    ]));
  });

  it("marks only the configured and discoverable provider as executable", () => {
    const registrations = createExternalConverterRegistrations({
      rvt: { command: process.execPath, args: [], cwd: process.cwd() },
      industrialCad: { args: [], cwd: process.cwd() },
    }, objects);

    expect(registrations[0]).toMatchObject({ provider: { status: "detected" } });
    expect(registrations[0]?.execute).toBeTypeOf("function");
    expect(registrations[1]?.execute).toBeUndefined();
  });

  it("executes a configured adapter and publishes fingerprinted industrial artifacts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bim-converter-test-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, "assembly.rvt");
    await writeFile(sourcePath, "deterministic-jt-fixture");
    const stored = new Map<string, string>();
    const objectStore = {
      read: async () => ({ stream: createReadStream(sourcePath), completed: Promise.resolve() }),
      putFile: async (key: string, filePath: string) => {
        const target = path.join(root, "objects", key.replaceAll("/", path.sep));
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(filePath, target);
        stored.set(key, target);
      },
    } as ObjectStore;
    const fixture = fileURLToPath(new URL("./fixtures/fakeCadConverter.mjs", import.meta.url));
    const registrations = createExternalConverterRegistrations({
      industrialCad: { args: [], cwd: process.cwd() },
      rvt: {
        command: process.execPath,
        args: [fixture, "--input", "{input}", "--output", "{output}", "--format", "{format}", "--include-pmi", "{includePmi}"],
        cwd: process.cwd(),
      },
    }, objectStore);
    const service = new ConversionTaskService(registrations, undefined, () => "task-jt-1");

    service.submit({
      projectId: "project-1",
      pluginId: "bim.revit-native",
      input: {
        objectKey: "projects/project-1/imports/assembly.rvt",
        fileName: "assembly.rvt",
        format: "rvt",
        size: 24,
      },
    });

    await vi.waitFor(() => expect(service.get("project-1", "task-jt-1")?.status).toBe("succeeded"));
    const task = service.get("project-1", "task-jt-1");
    expect(task?.artifacts.map((artifact) => artifact.kind)).toEqual(["geometry", "hierarchy", "properties", "pmi"]);
    expect(task?.artifacts.every((artifact) => artifact.sha256?.length === 64)).toBe(true);
    expect(task?.artifacts[0]?.metadata).toEqual({ meshCount: 1, primitiveCount: 1, vertexCount: 3, triangleCount: 1 });
    expect(stored.size).toBe(4);
  });

  it("rejects a converter that only renames source bytes to geometry.glb", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bim-converter-invalid-glb-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, "assembly.rvt");
    await writeFile(sourcePath, "not-a-glb");
    const stored: string[] = [];
    const objectStore = {
      read: async () => ({ stream: createReadStream(sourcePath), completed: Promise.resolve() }),
      putFile: async (key: string) => { stored.push(key); },
    } as ObjectStore;
    const fixture = fileURLToPath(new URL("./fixtures/fakeCadConverter.mjs", import.meta.url));
    const registrations = createExternalConverterRegistrations({
      industrialCad: { args: [], cwd: process.cwd() },
      rvt: {
        command: process.execPath,
        args: [fixture, "--input", "{input}", "--output", "{output}", "--format", "{format}", "--invalid-geometry", "true"],
        cwd: process.cwd(),
      },
    }, objectStore);
    const service = new ConversionTaskService(registrations, undefined, () => "task-invalid-glb");

    service.submit({
      projectId: "project-1",
      pluginId: "bim.revit-native",
      input: { objectKey: "projects/project-1/imports/assembly.rvt", fileName: "assembly.rvt", format: "rvt", size: 9 },
    });

    await vi.waitFor(() => expect(service.get("project-1", "task-invalid-glb")?.status).toBe("failed"));
    expect(service.get("project-1", "task-invalid-glb")?.message).toContain("geometry.glb 几何审计失败");
    expect(stored).toEqual([]);
  });
});
