import { describe, expect, it, vi } from "vitest";
import type { ConverterPluginManifest } from "@bim-studio/contracts";
import { ConversionTaskService } from "./conversionTasks.js";
const sha = "a".repeat(64);
const manifest: ConverterPluginManifest = { contractVersion: 1, id: "test.quality", name: "Quality", version: "1", execution: "server-worker",
  inputFormats: ["jt"], outputs: [{ kind: "log", format: "json", required: false }], capabilities: [], configurationSchema: {},
  limits: { timeoutMs: 1000, maxInputBytes: 100, maxOutputBytes: 100, maxMemoryMb: 100, maxCpuPercent: 100 } };
describe("quality gate at model publication", () => {
  it.each(["inspect", "preview"] as const)("blocks %s from activating ready", async tier => {
    const service = new ConversionTaskService([{ manifest, execute: async context => {
      context.reportSourceBundle({ schemaVersion: 1, sourceName: "a.jt", sourceFormat: "jt", contentHash: sha, bundledPath: "a.jt", licenseReference: "local-only" });
      context.reportQuality({ schemaVersion: 1, sourceHash: sha, profileId: "limited-jt-v1", tier,
        checks: [{ dimension: "geometry", passed: false, reason: "missing-face" }], losses: ["missing-face"], approximations: [] });
      context.stageModelUpdate({ status: "ready" });
    } }]);
    const task = service.submit({ projectId: "project-1", modelId: "model-1", pluginId: manifest.id,
      input: { fileName: "a.jt", format: "jt", size: 1, objectKey: "projects/project-1/a.jt", sha256: sha } });
    await vi.waitFor(() => expect(service.get("project-1", task.id)?.status).toBe("failed"));
    expect(service.get("project-1", task.id)).toMatchObject({ artifacts: [], message: expect.stringContaining("不能激活 ready"),
      sourceBundle: { contentHash: sha }, quality: { tier, sourceHash: sha, losses: ["missing-face"] } });
  });
  it("rejects client hashes that do not match the executor source identity", async () => {
    const service = new ConversionTaskService([{ manifest, execute: async context => context.reportSourceBundle({
      schemaVersion: 1, sourceName: "a.jt", sourceFormat: "jt", contentHash: "b".repeat(64), bundledPath: "a.jt", licenseReference: "local-only",
    }) }]);
    const task = service.submit({ projectId: "project-1", pluginId: manifest.id,
      input: { fileName: "a.jt", format: "jt", size: 1, objectKey: "projects/project-1/a.jt", sha256: sha } });
    await vi.waitFor(() => expect(service.get("project-1", task.id)?.status).toBe("failed"));
    expect(service.get("project-1", task.id)?.sourceBundle).toBeUndefined();
  });
});
