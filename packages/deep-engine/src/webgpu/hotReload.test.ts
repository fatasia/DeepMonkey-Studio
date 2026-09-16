import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShaderAuthoringSession } from "../shaderAuthoring/session.js";
import { compileDeepSlSurface } from "../shaderAuthoring/deepSlCompiler.js";
import { TEST_CAPABILITIES } from "../shaderAuthoring/testFixture.js";
import type { PreparedShaderPackage } from "./shaderPackageExecutor.js";
import { ShaderPackageExecutor } from "./shaderPackageExecutor.js";
import { ShaderHotReloadRuntime } from "./hotReload.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const OPAQUE = `shader deep.hot {
  surface standard;
  baseColor [0.2, 0.4, 0.8, 1];
  metallic 0.3;
  roughness 0.6;
  alpha opaque;
  doubleSided false;
  baseColorTexture off;
}`;

function document(source = OPAQUE) {
  return { schemaVersion: 1 as const, id: "deep.hot", mode: "text" as const, language: "deepsl" as const, source };
}

function session(source = OPAQUE) {
  const created = createShaderAuthoringSession(document(source), { capabilities: TEST_CAPABILITIES });
  expect(created.success).toBe(true); return created.session!;
}

const options = { capabilities: TEST_CAPABILITIES, packageVersion: "1.0.0", compilerVersion: "1.0.0", debounceMs: 10 } as const;

function fakeDevice() {
  const lost = deferred<GPUDeviceLostInfo>();
  let messages: readonly GPUCompilationMessage[] = [];
  const device = {
    lost: lost.promise,
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null as GPUError | null),
    createShaderModule: vi.fn(() => ({ getCompilationInfo: vi.fn(async () => ({ messages })) })),
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => ({ descriptor })),
    createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => ({ descriptor })),
    createRenderPipelineAsync: vi.fn(async (descriptor: GPURenderPipelineDescriptor) => ({ descriptor })),
  };
  return { device: device as unknown as GPUDevice, mock: device, lost,
    failCompilation(lineNum = 4, linePos = 2): void {
      messages = [{ type: "error", lineNum, linePos, message: "invalid hot shader" } as GPUCompilationMessage];
    } };
}

function prepared(id: string): PreparedShaderPackage {
  return Object.freeze({ packageId: id, packageVersion: "1.0.0", passes: Object.freeze([]) });
}

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
  vi.stubGlobal("GPUColorWrite", { ALL: 15 });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("shader hot reload runtime", () => {
  it("prewarms a candidate and only publishes atomically at a frame boundary", async () => {
    const authoring = session(), fake = fakeDevice(), executor = new ShaderPackageExecutor(fake.device);
    const runtime = new ShaderHotReloadRuntime(authoring, executor, options);
    const ready = await runtime.compileNow();
    expect(ready).toMatchObject({ status: "ready", diagnostics: [], artifactHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(runtime.current).toBeUndefined(); expect(runtime.candidate?.preparedPackage.passes).toHaveLength(4);
    const hook = runtime.createFrameBoundaryPublishHook(), published = hook();
    expect(published).toMatchObject({ published: true, current: { revision: ready.revision, artifactHash: ready.artifactHash,
      packageHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(published.current).not.toHaveProperty("artifact"); expect(published.current).not.toHaveProperty("document");
    expect(hook()).toMatchObject({ published: false, current: published.current });
    const pipelineCalls = fake.mock.createRenderPipelineAsync.mock.calls.length;
    expect(await runtime.compileNow()).toMatchObject({ status: "unchanged", artifactHash: ready.artifactHash });
    expect(fake.mock.createRenderPipelineAsync).toHaveBeenCalledTimes(pipelineCalls);
    authoring.replaceDocument(document(OPAQUE.replace("baseColorTexture off;", "baseColorTexture off;\n  normalTexture on;")));
    const fixedAbiChange = await runtime.compileNow();
    expect(fixedAbiChange).toMatchObject({ status: "ready", artifactHash: ready.artifactHash });
    expect(runtime.candidate?.packageHash).not.toBe(published.current?.packageHash);
    runtime.dispose();
  });

  it("prewarms the same complete material WGSL emitted by authoring", async () => {
    const source = OPAQUE.replace("baseColorTexture off", `baseColorTexture on;
  metallicRoughnessTexture on;
  normalTexture on;
  occlusionTexture on;
  emissiveTexture on;
  normalScale -0.75;
  occlusionStrength 0.35;
  emissiveFactor [0.1, 0.2, 0.3];
  emissiveStrength 8`);
    const authoring = session(source), fake = fakeDevice();
    const runtime = new ShaderHotReloadRuntime(authoring, new ShaderPackageExecutor(fake.device), options);
    await expect(runtime.compileNow()).resolves.toMatchObject({ status: "ready" });
    expect(runtime.candidate?.compatibility).toMatchObject({ materialTextureDefaults: {
      normal: { normalScale: -0.75 }, occlusion: { strength: 0.35 }, emissive: { emissiveStrength: 8 },
    } });
    const authored = authoring.view().lastKnownGood?.artifact.runtimePackage?.modules[0]?.source;
    const prepared = fake.mock.createShaderModule.mock.calls[0]?.[0].code;
    expect(prepared).toBe(authored);
    expect(prepared).toContain("deepMaterialTextures.mrRow0");
    runtime.dispose();
  });

  it("fails closed when an injected authoring compiler drifts from the runtime adapter", async () => {
    const current = OPAQUE.replace("baseColorTexture off", "baseColorTexture on");
    const wrong = compileDeepSlSurface({ document: document(OPAQUE), revision: "a".repeat(64), candidateId: 1 },
      { capabilities: TEST_CAPABILITIES });
    expect(wrong.success && wrong.artifact).toBeTruthy();
    const authoring = createShaderAuthoringSession(document(current), {
      capabilities: TEST_CAPABILITIES,
      textCompiler: () => ({ success: true, diagnostics: [], artifact: wrong.artifact! }),
    }).session!;
    const fake = fakeDevice(), runtime = new ShaderHotReloadRuntime(
      authoring, new ShaderPackageExecutor(fake.device), options);
    await expect(runtime.compileNow()).resolves.toMatchObject({ status: "failed",
      diagnostics: [expect.objectContaining({ code: "runtime-semantic-drift" })] });
    expect(fake.mock.createShaderModule).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("preserves the active shader across authoring and GPU compilation failures with precise diagnostics", async () => {
    const authoring = session(), fake = fakeDevice(), runtime = new ShaderHotReloadRuntime(authoring, new ShaderPackageExecutor(fake.device), options);
    await runtime.compileNow(); const active = runtime.publishAtFrameBoundary().current!;
    authoring.replaceDocument(document("shader broken {\n  surface standard;\n  unknown nope;\n}"));
    const syntax = await runtime.compileNow();
    expect(syntax.status).toBe("failed"); expect(syntax.diagnostics[0]).toMatchObject({ stage: "authoring", code: "unknown-statement",
      range: { start: { line: 3 } } });
    expect(runtime.current).toBe(active); expect(runtime.publishAtFrameBoundary()).toMatchObject({ published: false, current: active });
    fake.failCompilation(4, 2);
    authoring.replaceDocument(document(OPAQUE.replace("alpha opaque", "alpha blend")));
    const gpu = await runtime.compileNow();
    expect(gpu.status).toBe("failed"); expect(gpu.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "gpu", code: "wgsl-compilation-error", generatedLine: 4, generatedColumn: 2,
        message: expect.stringContaining("invalid hot shader") }),
    ]));
    expect(runtime.current).toBe(active); expect(runtime.candidate).toBeUndefined(); runtime.dispose();
  });

  it("debounces editor requests and resolves replaced schedules as superseded", async () => {
    vi.useFakeTimers();
    const fake = fakeDevice(), runtime = new ShaderHotReloadRuntime(session(), new ShaderPackageExecutor(fake.device), options);
    const first = runtime.request(), second = runtime.request();
    await expect(first).resolves.toMatchObject({ status: "superseded" });
    expect(fake.mock.createShaderModule).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    await expect(second).resolves.toMatchObject({ status: "ready" });
    expect(fake.mock.createShaderModule).toHaveBeenCalledOnce(); runtime.dispose();
  });

  it("invalidates in-flight GPU candidates and only retains the newest request", async () => {
    const authoring = session(), lost = deferred<GPUDeviceLostInfo>(), firstGate = deferred<PreparedShaderPackage>(), secondGate = deferred<PreparedShaderPackage>();
    const executor = { state: "ready", device: { lost: lost.promise }, prepare: vi.fn()
      .mockReturnValueOnce(firstGate.promise).mockReturnValueOnce(secondGate.promise), clear: vi.fn(), dispose: vi.fn(function(this: {state: string}) { this.state = "disposed"; }) };
    const runtime = new ShaderHotReloadRuntime(authoring, executor as unknown as ShaderPackageExecutor, options);
    const first = runtime.compileNow(); await vi.waitFor(() => expect(executor.prepare).toHaveBeenCalledTimes(1));
    authoring.replaceDocument(document(OPAQUE.replace("alpha opaque", "alpha blend")));
    const second = runtime.compileNow(); await vi.waitFor(() => expect(executor.prepare).toHaveBeenCalledTimes(2));
    expect(executor.clear).toHaveBeenCalled();
    secondGate.resolve(prepared("new")); await expect(second).resolves.toMatchObject({ status: "ready" });
    firstGate.resolve(prepared("old")); await expect(first).resolves.toMatchObject({ status: "superseded" });
    const published = runtime.publishAtFrameBoundary(); expect(published.current?.preparedPackage.packageId).toBe("new");
    runtime.dispose(); expect(executor.dispose).toHaveBeenCalledOnce();
  });

  it("invalidates published state on device loss and disposes idempotently", async () => {
    const fake = fakeDevice(), executor = new ShaderPackageExecutor(fake.device), runtime = new ShaderHotReloadRuntime(session(), executor, options);
    await runtime.compileNow(); runtime.publishAtFrameBoundary(); expect(runtime.current).toBeDefined();
    fake.lost.resolve({ reason: "unknown", message: "device reset" } as GPUDeviceLostInfo);
    await Promise.resolve(); await Promise.resolve();
    expect(runtime.state).toBe("lost"); expect(runtime.current).toBeUndefined();
    await expect(runtime.compileNow()).resolves.toMatchObject({ status: "failed", diagnostics: [{ code: "device-lost" }] });
    runtime.dispose(); runtime.dispose(); expect(runtime.state).toBe("disposed");
  });

  it("fails unsupported authoring modes without invoking the GPU executor", async () => {
    const graph = createShaderAuthoringSession({ schemaVersion: 1, id: "graph", mode: "graph",
      asset: (await import("../shaderAuthoring/testFixture.js")).testAsset(), techniqueId: "webgpu", passId: "forward" },
    { capabilities: TEST_CAPABILITIES }).session!;
    const fake = fakeDevice(), executor = new ShaderPackageExecutor(fake.device), runtime = new ShaderHotReloadRuntime(graph, executor, options);
    await expect(runtime.compileNow()).resolves.toMatchObject({ status: "failed",
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "unsupported-authoring-mode" })]) });
    expect(fake.mock.createShaderModule).not.toHaveBeenCalled(); runtime.dispose();
  });
});
