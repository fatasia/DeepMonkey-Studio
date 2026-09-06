import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import { RobotSourceProvider, assertLosslessRobotPackage } from "./RobotSourceProvider.js";
import { prepareRobotSource } from "./prepareRobotSource.js";
import { JsonStore } from "./store.js";
import { ConversionQueue } from "./conversion.js";
import { loadConfig } from "./config.js";

const xml = '<robot name="fixture"><link name="base"/><link name="tip"/><joint name="spin" type="continuous"><parent link="base"/><child link="tip"/><axis xyz="1 1 0"/></joint></robot>';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) {
  if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("bim-robot-provider-")) throw new Error("invalid test directory");
  await rm(directory, { recursive: true, force: true });
} });
async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bim-robot-provider-")); directories.push(dataDir);
  const store = new JsonStore(dataDir); await store.init();
  const objects = { putFile: vi.fn(async () => undefined) };
  const provider = new RobotSourceProvider(store, objects as never);
  async function model(id: string, bytes: Buffer | string, format: "urdf" | "zip" = "urdf", extra: Partial<ModelRecord> = {}) {
    const modelDir = path.join(dataDir, id); await mkdir(modelDir);
    const sourcePath = path.join(modelDir, format === "urdf" ? "robot.urdf" : "robot.zip"); await writeFile(sourcePath, bytes);
    const model: ModelRecord = { id, projectId: "default", name: path.basename(sourcePath), format, status: "queued", progress: 0,
      message: "queued", size: Buffer.byteLength(bytes), sourceUrl: `/assets/${id}/${path.basename(sourcePath)}`, createdAt: "2026-09-06", updatedAt: "2026-09-06", ...extra };
    await store.addModel("default", model); return { model, modelDir, sourcePath };
  }
  return { store, provider, objects, model };
}
async function zip(bytes: string, second = false) {
  const packageFile = new JSZip().file("robot.urdf", bytes);
  if (second) packageFile.file("other.urdf", bytes);
  return packageFile.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("original robot source provider", () => {
  it("writes a native robot manifest and keeps the raw geometry URL and joint semantics", async () => {
    const f = await fixture(); const job = await f.model("source", xml);
    await f.provider.convert(job);
    const result = f.store.getProject("default")!.models[0]!;
    expect(result.status).toBe("ready"); expect(result.manifest).toMatchObject({ viewerKind: "urdf", geometryUrl: job.model.sourceUrl });
    expect(result.manifest!.robot!.joints[0]).toMatchObject({ type: "continuous", axis: { x: 1, y: 1, z: 0 } });
    expect(JSON.parse(await readFile(path.join(job.modelDir, "manifest.json"), "utf8"))).toEqual(result.manifest);
    expect(await readFile(job.sourcePath, "utf8")).toBe(xml);
    expect(f.objects.putFile).toHaveBeenCalledOnce();
  });
  it("accepts only byte-identical optimized packages and inherits the original selected entry", async () => {
    const f = await fixture(); const original = await f.model("source", await zip(xml, true), "zip", { robotEntryPath: "robot.urdf" });
    await f.provider.convert(original); const source = f.store.getProject("default")!.models[0]!;
    const optimization = { sourceModelId: source.id, sourceModelName: source.name, sourceUpdatedAt: source.updatedAt };
    const compressed = await f.model("optimized", await zip(xml, true), "zip", { optimization }); await f.provider.convert(compressed);
    expect(f.store.getProject("default")!.models[1]!.robotEntryPath).toBe("robot.urdf");
    const changed = await f.model("changed", await zip(xml.replace('xyz="1 1 0"', 'xyz="0 0 1"'), true), "zip", { optimization });
    await expect(f.provider.convert(changed)).rejects.toThrow("资源内容");
    expect(f.objects.putFile).toHaveBeenCalledTimes(2);
  });
  it("rejects missing/stale optimization sources and altered entry or resource lists", async () => {
    const f = await fixture(); const source = await f.model("source", xml); const definition = await prepareRobotSource(source.sourcePath);
    expect(() => assertLosslessRobotPackage(definition, { ...definition, entryPath: "other.urdf" })).toThrow();
    expect(() => assertLosslessRobotPackage(definition, { ...definition, resources: [] })).toThrow();
    const job = await f.model("optimized", await zip(xml), "zip", { optimization: { sourceModelId: "missing", sourceModelName: "missing", sourceUpdatedAt: "old" } });
    await expect(f.provider.convert(job)).rejects.toThrow("来源");
  });
  it("routes robot imports through the existing queue and reports invalid archives as failed", async () => {
    const f = await fixture(); const queue = new ConversionQueue(f.store, loadConfig(), f.objects as never);
    const valid = await f.model("valid", xml); const invalid = await f.model("invalid", "not zip", "zip");
    queue.enqueue(valid); queue.enqueue(invalid);
    await vi.waitFor(() => expect(f.store.getProject("default")!.models.find(item => item.id === "valid")!.status).toBe("ready"));
    await vi.waitFor(() => expect(f.store.getProject("default")!.models.find(item => item.id === "invalid")!.status).toBe("failed"));
    expect(f.store.getProject("default")!.models.find(item => item.id === "invalid")!.message).toContain("ZIP");
  });
});
