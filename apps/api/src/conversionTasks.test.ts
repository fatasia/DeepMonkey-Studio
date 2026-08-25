import type { ConverterPluginManifest } from "@bim-studio/contracts";
import { describe, expect, it, vi } from "vitest";
import { ConversionTaskError, ConversionTaskService, assertConversionTaskTransition, type ConverterExecutionContext } from "./conversionTasks.js";

const manifest: ConverterPluginManifest = {
  contractVersion: 1,
  id: "test.step",
  name: "Test STEP converter",
  version: "1.2.3",
  execution: "server-worker",
  inputFormats: ["step", "stp"],
  outputs: [{ kind: "geometry", format: "glb", required: true }],
  configurationSchema: { type: "object" },
  capabilities: ["filesystem.read-input", "filesystem.write-output"],
  limits: { timeoutMs: 10_000, maxInputBytes: 1_000_000, maxOutputBytes: 2_000_000, maxMemoryMb: 256, maxCpuPercent: 100 }
};

function request() {
  return {
    projectId: "project-1",
    pluginId: manifest.id,
    input: { objectKey: "projects/project-1/imports/part.step", fileName: "part.step", format: ".STEP", size: 100 }
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not reached");
}

describe("ConversionTaskService", () => {
  it("executes a registered plugin and publishes only declared task-scoped artifacts", async () => {
    const execute = vi.fn(async (context: ConverterExecutionContext) => {
      context.reportProgress(35, "解析几何");
      context.publishArtifact({ kind: "geometry", format: "glb", objectKey: `${context.outputPrefix}geometry.glb`, size: 800 });
    });
    const service = new ConversionTaskService([{ manifest, execute }], () => new Date("2026-08-25T00:00:00.000Z"), () => "task-1");

    const submitted = service.submit(request());
    expect(submitted.status).toBe("queued");
    expect(submitted.input.format).toBe("step");
    await until(() => service.get("project-1", "task-1")?.status === "succeeded");

    const result = service.get("project-1", "task-1");
    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "succeeded", progress: 100, pluginVersion: "1.2.3" });
    expect(result?.artifacts[0].objectKey).toBe("projects/project-1/conversions/task-1/output/geometry.glb");
  });

  it("cancels an active executor through AbortSignal", async () => {
    let started = false;
    const service = new ConversionTaskService([{
      manifest,
      execute: async ({ signal }) => {
        started = true;
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    }], undefined, () => "task-2");
    service.submit({ ...request(), input: { ...request().input, objectKey: "projects/project-1/imports/two.step" } });
    await until(() => started);

    expect(service.cancel("project-1", "task-2").status).toBe("cancelling");
    await until(() => service.get("project-1", "task-2")?.status === "cancelled");
    expect(service.get("project-1", "task-2")?.finishedAt).toBeDefined();
  });

  it("uses waiting_converter for declared plugins without an executable", () => {
    const service = new ConversionTaskService([{ manifest, unavailableReason: "等待许可证" }], undefined, () => "task-3");
    const task = service.submit(request());

    expect(service.listPlugins()[0]).toMatchObject({ available: false, unavailableReason: "等待许可证" });
    expect(task).toMatchObject({ status: "waiting_converter", message: "等待许可证" });
    expect(service.cancel("project-1", task.id).status).toBe("cancelled");
  });

  it("rejects cross-project object keys and illegal state transitions", () => {
    const service = new ConversionTaskService([{ manifest, unavailableReason: "未安装" }]);
    expect(() => service.submit({ ...request(), input: { ...request().input, objectKey: "projects/other/imports/part.step" } })).toThrow("当前项目");
    expect(() => assertConversionTaskTransition("succeeded", "running")).toThrow(ConversionTaskError);
  });
});
