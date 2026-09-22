import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runBuiltinJtWorker } from "./builtinJtWorkerExecutor.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseDocument, ModelManifest, ModelRecord } from "@bim-studio/contracts";
import { JsonStore } from "./jsonStore.js";
import { loadConfig } from "./config.js";
import { LocalObjectStore } from "./objects.js";
import { ConversionQueue } from "./conversion.js";
import { ConversionTaskService } from "./conversionTasks.js";
import { createModelConversionRegistration, submitModelConversion } from "./modelConversionAdapter.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
class FailureStore extends JsonStore {
  failPublication = false;
  protected override async persistDocument(document: DatabaseDocument): Promise<void> {
    if (this.failPublication && document.conversionTasks?.some(task => task.status === "succeeded" && task.id === document.projects[0]?.models[0]?.conversionTaskId)) {
      throw new Error("injected database publication failure");
    }
    return super.persistDocument(document);
  }
}
async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bim-conversion-durable-")); directories.push(dataDir);
  const store = new FailureStore(dataDir); await store.init();
  const objects = new LocalObjectStore(dataDir);
  const config = { ...loadConfig(), dataDir };
  const tasks = new ConversionTaskService([], undefined, undefined, store); await tasks.initialize();
  const queue = new ConversionQueue(store, config, objects, tasks);
  const modelDir = path.join(dataDir, "projects", "default", "models", "model-1");
  await mkdir(path.join(modelDir, "source"), { recursive: true });
  const sourcePath = path.join(modelDir, "source", "part.obj");
  await writeFile(sourcePath, "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
  const model: ModelRecord = { id: "model-1", projectId: "default", name: "part.obj", format: "obj", size: 36,
    sourceUrl: "/assets/projects/default/models/model-1/source/part.obj", status: "queued", progress: 0,
    message: "等待转换", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await store.addModel("default", model);
  return { dataDir, store, objects, config, tasks, queue, context: { model, modelDir, sourcePath }, getModel: () => store.getProject("default")!.models[0]! };
}
async function terminal(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  await vi.waitFor(() => expect(["succeeded", "failed", "cancelled"]).toContain(f.tasks.get("default", id)?.status));
  return f.tasks.get("default", id)!;
}

describe("durable model conversion attempts", () => {
  it("rejects a duplicate successful callback with different publication bytes or task evidence", async () => {
    const f = await fixture(); const id = await f.queue.enqueue(f.context);
    const completed = await terminal(f, id); const ready = structuredClone(f.getModel());
    await expect(f.store.saveConversionTask(completed, { manifestUrl: "/assets/replaced.json", status: "ready" })).rejects.toThrow("终态");
    await expect(f.store.saveConversionTask({ ...completed, artifacts: [] })).rejects.toThrow("终态");
    expect(f.getModel()).toEqual(ready);
    expect(f.store.listConversionTasks().find(task => task.id === id)).toEqual(completed);
    const reopened = new JsonStore(f.dataDir); await reopened.init();
    expect(reopened.getProject("default")!.models[0]).toEqual(ready);
  });

  it("treats an identical terminal retry as a no-op even after a newer attempt succeeds", async () => {
    const f = await fixture(); const first = await terminal(f, await f.queue.enqueue(f.context));
    const firstReady = structuredClone(f.getModel());
    await expect(f.store.saveConversionTask(first, { manifestUrl: firstReady.manifestUrl, status: "ready" })).resolves.toBeUndefined();
    await terminal(f, await f.queue.enqueue({ ...f.context, model: f.getModel() }));
    const current = structuredClone(f.getModel());
    await expect(f.store.saveConversionTask(first)).resolves.toBeUndefined();
    await expect(f.store.saveConversionTask(first, { manifestUrl: firstReady.manifestUrl })).rejects.toThrow("终态");
    expect(f.getModel()).toEqual(current);
  });

  it.each(["failed", "cancelled"] as const)("keeps %s task evidence immutable and preserves the previous ready model", async status => {
    const f = await fixture(); const first = await terminal(f, await f.queue.enqueue(f.context));
    const ended = { ...first, id: `retry-${status}`, status, artifacts: [], message: status };
    await f.store.saveConversionTask(ended);
    const ready = structuredClone(f.getModel());
    await expect(f.store.saveConversionTask(ended)).resolves.toBeUndefined();
    await expect(f.store.saveConversionTask({ ...ended, message: "rewritten" })).rejects.toThrow("终态");
    await expect(f.store.saveConversionTask(ended, { status: "failed" })).rejects.toThrow("终态");
    expect(f.getModel()).toEqual(ready);
    expect(f.getModel().status).toBe("ready");
    const reopened = new JsonStore(f.dataDir); await reopened.init();
    expect(reopened.listConversionTasks().find(task => task.id === ended.id)).toEqual(ended);
  });

  it.each(["cancel", "crash"])("preserves the old ready publication after real worker %s", async mode => {
    const f = await fixture(); await terminal(f, await f.queue.enqueue(f.context));
    const ready = f.getModel();
    let pid: number | undefined;
    let started = false;
    const service = new ConversionTaskService([createModelConversionRegistration("obj", f.store, f.objects, f.config, () => ({
      convert: async context => {
        await runBuiltinJtWorker({ sourcePath: context.sourcePath, outputDir: context.modelDir, sourceName: mode === "crash" ? "crash" : "busy" }, {
          signal: context.signal, registerResourceExit: context.registerResourceExit,
          createChild: () => {
            const child = fork(fileURLToPath(new URL("./fixtures/builtinJtWorkerFailure.mjs", import.meta.url)), [], {
              execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"],
            });
            pid = child.pid;
            const emit = child.emit.bind(child);
            child.emit = ((event: string, ...args: unknown[]) => {
              if (event === "message" && (args[0] as { type?: string })?.type === "started") { started = true; return true; }
              return emit(event, ...args);
            }) as typeof child.emit;
            return child;
          },
        });
      },
    }))], undefined, undefined, f.store);
    const id = await submitModelConversion(service, { ...f.context, model: ready });
    if (mode === "cancel") {
      await vi.waitFor(() => expect(started).toBe(true));
      await service.cancelDurable("default", id);
    }
    await vi.waitFor(() => expect(service.get("default", id)?.status).toBe(mode === "cancel" ? "cancelled" : "failed"));
    expect(() => process.kill(pid!, 0)).toThrow();
    expect(service.get("default", id)?.artifacts).toEqual([]);
    expect(f.getModel()).toMatchObject({ status: "ready", manifest: ready.manifest, manifestUrl: ready.manifestUrl });
    const reopened = new JsonStore(f.dataDir); await reopened.init();
    expect(reopened.getProject("default")!.models[0]).toMatchObject({ status: "ready", manifestUrl: ready.manifestUrl });
  });
  it.each(["missing", "mismatch"])("refuses a %s manifest file before publishing a ready model", async failure => {
    const f = await fixture();
    const service = new ConversionTaskService([createModelConversionRegistration("obj", f.store, f.objects, f.config, staged => ({
      convert: async context => {
        const manifest: ModelManifest = { schemaVersion: 1, modelId: context.model.id, sourceName: context.model.name,
          sourceFormat: "obj", geometryUrl: context.model.sourceUrl, createdAt: context.model.createdAt };
        if (failure === "mismatch") await writeFile(path.join(context.modelDir, "manifest.json"), JSON.stringify({ ...manifest, geometryUrl: "/wrong.glb" }));
        await staged.updateModel("default", "model-1", { status: "ready", manifest });
      },
    }))], undefined, undefined, f.store);
    const id = await submitModelConversion(service, f.context);
    await vi.waitFor(() => expect(service.get("default", id)?.status).toBe("failed"));
    expect(service.get("default", id)?.artifacts).toEqual([]);
    expect(f.getModel().status).toBe("failed");
    expect(f.getModel().manifest).toBeUndefined();
  });
  it("shares upload identity, persists task and publishes an immutable model manifest atomically", async () => {
    const f = await fixture(); const uploads = vi.spyOn(f.objects, "putFile");
    const id = await f.queue.enqueue(f.context);
    expect(f.getModel().conversionTaskId).toBe(id);
    expect(await terminal(f, id)).toMatchObject({ status: "succeeded", modelId: "model-1", input: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(f.getModel().manifestUrl).toBe(`/assets/projects/default/models/model-1/attempts/${id}/manifest.json`);
    expect(f.getModel().manifest!.geometryUrl).toBe(f.context.model.sourceUrl);
    const stored = JSON.parse(await readFile(path.join(f.context.modelDir, "attempts", id, "manifest.json"), "utf8"));
    expect(stored).toEqual(f.getModel().manifest);
    for (const artifact of f.tasks.get("default", id)!.artifacts) {
      expect(uploads).toHaveBeenCalledWith(artifact.objectKey, expect.any(String));
      const bytes = await readFile(path.join(f.dataDir, ...artifact.objectKey.split("/")));
      expect(bytes.length).toBe(artifact.size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
      expect(await f.objects.stat(artifact.objectKey)).toBe(true);
    }
    const reopened = new JsonStore(f.dataDir); await reopened.init();
    const restored = new ConversionTaskService([], undefined, undefined, reopened); await restored.initialize();
    expect(restored.get("default", id)?.status).toBe("succeeded");
    expect(reopened.getProject("default")!.models[0]!.manifestUrl).toBe(f.getModel().manifestUrl);
  });

  it("retains the prior ready manifest when object storage fails during reconversion", async () => {
    const f = await fixture(); await terminal(f, await f.queue.enqueue(f.context));
    const ready = f.getModel();
    vi.spyOn(f.objects, "putFile").mockRejectedValue(new Error("injected object storage failure"));
    const id = await f.queue.enqueue({ ...f.context, model: ready });
    expect(await terminal(f, id)).toMatchObject({ status: "failed", artifacts: [], message: "injected object storage failure" });
    expect(f.getModel()).toMatchObject({ status: "ready", manifest: ready.manifest, manifestUrl: ready.manifestUrl });
    expect(JSON.parse(await readFile(path.join(f.dataDir, ready.manifestUrl!.slice("/assets/".length)), "utf8"))).toEqual(ready.manifest);
  });

  it("does not expose a new pointer when the database rejects the publication transaction", async () => {
    const f = await fixture(); await terminal(f, await f.queue.enqueue(f.context));
    const ready = f.getModel(); f.store.failPublication = true;
    const id = await f.queue.enqueue({ ...f.context, model: ready });
    expect(await terminal(f, id)).toMatchObject({ status: "failed", artifacts: [], message: "injected database publication failure" });
    expect(f.getModel()).toMatchObject({ status: "ready", manifestUrl: ready.manifestUrl, manifest: ready.manifest });
    expect(f.store.listConversionTasks().find(task => task.id === id)?.status).toBe("failed");
  });

  it("cancels during object I/O, rejects a competing attempt and ignores late completion", async () => {
    const f = await fixture(); await terminal(f, await f.queue.enqueue(f.context));
    const ready = f.getModel(); let release!: () => void;
    vi.spyOn(f.objects, "putFile").mockImplementation(async () => new Promise<void>(resolve => { release = resolve; }));
    const id = await f.queue.enqueue({ ...f.context, model: ready });
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(f.queue.enqueue({ ...f.context, model: ready })).rejects.toThrow("活动转换任务");
    await f.tasks.cancelDurable("default", id);
    expect(await terminal(f, id)).toMatchObject({ status: "cancelled", artifacts: [] });
    release(); await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.getModel()).toMatchObject({ status: "ready", manifestUrl: ready.manifestUrl, manifest: ready.manifest });
    expect(f.tasks.get("default", id)?.status).toBe("cancelled");
  });

  it("recovers a crashed task explicitly without reusing its partially written attempt", async () => {
    const f = await fixture(); const id = await f.queue.enqueue(f.context); await terminal(f, id);
    const ready = f.getModel();
    const interrupted = { ...f.tasks.get("default", id)!, id: "crashed-attempt", status: "running" as const, artifacts: [], finishedAt: undefined };
    await f.store.saveConversionTask(interrupted);
    const resumed = new ConversionTaskService([], undefined, undefined, f.store); await resumed.initialize();
    expect(resumed.get("default", interrupted.id)).toMatchObject({ status: "failed", artifacts: [], message: expect.stringContaining("服务重启") });
    expect(f.getModel()).toMatchObject({ status: "ready", manifestUrl: ready.manifestUrl });
    const queue = new ConversionQueue(f.store, f.config, f.objects, resumed);
    const retried = await queue.enqueue({ ...f.context, model: f.getModel() });
    expect(retried).not.toBe(interrupted.id);
    await vi.waitFor(() => expect(resumed.get("default", retried)?.status).toBe("succeeded"));
    expect(f.getModel().manifestUrl).toContain(`/attempts/${retried}/`);
  });
});
