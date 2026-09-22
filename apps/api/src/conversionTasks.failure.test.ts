import type { ConverterPluginManifest } from "@bim-studio/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversionTaskService, type ConverterExecutionContext } from "./conversionTasks.js";

const manifest: ConverterPluginManifest = {
  contractVersion: 1, id: "test.failure", name: "Failure converter", version: "1.0.0",
  execution: "server-worker", inputFormats: ["step"],
  outputs: [{ kind: "geometry", format: "glb", required: true, multiple: true }],
  configurationSchema: { type: "object" }, capabilities: [],
  limits: { timeoutMs: 100, maxInputBytes: 1000, maxOutputBytes: 1000, maxMemoryMb: 256, maxCpuPercent: 100 },
};
const request = {
  projectId: "project-1", pluginId: manifest.id,
  input: { objectKey: "projects/project-1/imports/part.step", fileName: "part.step", format: "step", size: 100 },
};
const artifact = (context: ConverterExecutionContext) => ({
  kind: "geometry" as const, format: "glb", objectKey: `${context.outputPrefix}geometry.glb`, size: 100,
});
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function setup(execute: (context: ConverterExecutionContext) => Promise<void>) {
  const service = new ConversionTaskService([{ manifest, execute }], undefined, () => "task-1");
  service.submit(request);
  return { service, get: () => service.get(request.projectId, "task-1")! };
}

afterEach(() => vi.useRealTimers());

describe("conversion task failure isolation", () => {
  it("keeps cancellation and the next queue slot pending until resource exit", async () => {
    let release!: () => void;
    let runs = 0;
    let sequence = 0;
    const service = new ConversionTaskService([{ manifest, execute: async context => {
      runs++;
      if (runs === 1) {
        context.registerResourceExit?.(new Promise<void>(resolve => { release = resolve; }));
        await new Promise<void>(() => {});
      } else context.publishArtifact(artifact(context));
    } }], undefined, () => `resource-${++sequence}`);
    const first = service.submit(request);
    const second = service.submit(request);
    await flush();
    service.cancel(request.projectId, first.id);
    await flush();
    expect(service.get(request.projectId, first.id)?.status).toBe("cancelling");
    expect(service.get(request.projectId, second.id)?.status).toBe("queued");
    expect(runs).toBe(1);
    release();
    await vi.waitFor(() => expect(service.get(request.projectId, second.id)?.status).toBe("succeeded"));
    expect(service.get(request.projectId, first.id)?.status).toBe("cancelled");
  });
  it("does not expose staged artifacts before all required work succeeds", async () => {
    let complete!: () => void;
    const { get } = setup(async (context) => {
      context.publishArtifact(artifact(context));
      await new Promise<void>((resolve) => { complete = resolve; });
    });
    await flush();
    expect(get()).toMatchObject({ status: "running", artifacts: [] });
    complete();
    await flush();
    expect(get()).toMatchObject({ status: "succeeded", artifacts: [expect.objectContaining({ format: "glb" })] });
  });

  it("discards staged artifacts when later work fails", async () => {
    const { get } = setup(async (context) => {
      context.publishArtifact(artifact(context));
      throw new Error("object store failed");
    });
    await flush();
    expect(get()).toMatchObject({ status: "failed", message: "object store failed", artifacts: [] });
  });

  it("finishes cancellation even if the executor ignores AbortSignal and rejects late writes", async () => {
    let context!: ConverterExecutionContext;
    let complete!: () => void;
    const { service, get } = setup(async (value) => {
      context = value;
      context.publishArtifact(artifact(context));
      await new Promise<void>((resolve) => { complete = resolve; });
    });
    await flush();
    expect(service.cancel(request.projectId, "task-1").status).toBe("cancelling");
    await flush();
    expect(get()).toMatchObject({ status: "cancelled", artifacts: [] });
    expect(context.signal.aborted).toBe(true);
    expect(() => context.publishArtifact(artifact(context))).toThrow("不在运行中");
    context.reportProgress(95, "late");
    complete();
    await flush();
    expect(get()).toMatchObject({ status: "cancelled", message: "已取消", artifacts: [] });
  });

  it("enforces the manifest deadline, marks timeout failed and absorbs late rejection", async () => {
    vi.useFakeTimers();
    let context!: ConverterExecutionContext;
    let reject!: (error: Error) => void;
    const { get } = setup(async (value) => {
      context = value;
      value.publishArtifact(artifact(value));
      await new Promise<void>((_, fail) => { reject = fail; });
    });
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(get()).toMatchObject({ status: "failed", artifacts: [], message: expect.stringContaining("超时") });
    expect(context.signal.aborted).toBe(true);
    reject(new Error("late rejection"));
    await flush();
    expect(get().status).toBe("failed");
  });

  it.each([Number.NaN, Infinity, -Infinity])("rejects non-finite progress %s", async (progress) => {
    const { get } = setup(async (context) => context.reportProgress(progress, "invalid"));
    await flush();
    expect(get()).toMatchObject({ status: "failed", progress: 0, message: expect.stringContaining("有限") });
  });

  it("rejects duplicate output keys even for multiple outputs", async () => {
    const { get } = setup(async (context) => {
      context.publishArtifact(artifact(context));
      context.publishArtifact(artifact(context));
    });
    await flush();
    expect(get()).toMatchObject({ status: "failed", artifacts: [], message: expect.stringContaining("路径重复") });
  });

  it.each(["./part.step", "a//part.step", "part\u0000.step", "a/../part.step"])("rejects noncanonical input path %s", (suffix) => {
    const service = new ConversionTaskService([{ manifest }]);
    expect(() => service.submit({ ...request, input: { ...request.input, objectKey: `projects/project-1/${suffix}` } })).toThrow("当前项目");
  });

  it("does not overwrite an existing task on ID collision", async () => {
    const { service, get } = setup(async (context) => context.publishArtifact(artifact(context)));
    await flush();
    expect(() => service.submit(request)).toThrow("ID 已存在");
    expect(get().status).toBe("succeeded");
  });

  it("freezes registered output and resource policy against caller mutation", async () => {
    const mutable = structuredClone(manifest);
    const service = new ConversionTaskService([{ manifest: mutable, execute: async (context) => context.publishArtifact(artifact(context)) }], undefined, () => "task-1");
    mutable.limits.maxOutputBytes = 1;
    mutable.outputs.length = 0;
    service.submit(request);
    await flush();
    expect(service.get(request.projectId, "task-1")?.status).toBe("succeeded");
  });
});
