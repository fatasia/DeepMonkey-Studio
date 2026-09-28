import { describe, expect, it, vi } from "vitest";
import { minimalOnnxLinearModel } from "./fixtures/minimalOnnxLinearModel.js";
import {
  bundledExecutionProviders,
  createCpuOnnxSession,
  createOnnxSession,
  resolveExecutionProviders,
} from "./onnxSessionProviders.js";

const tinyModel = { bytes: minimalOnnxLinearModel() };

describe("onnx execution provider strategy", () => {
  it("keeps cpu as the guaranteed baseline", () => {
    expect(resolveExecutionProviders(["cpu"], ["cpu", "dml", "webgpu"]).providers).toEqual(["cpu"]);
    expect(resolveExecutionProviders([], ["cpu", "dml"]).providers).toEqual(["cpu"]);
    expect(resolveExecutionProviders(["dml"], ["cpu"]).providers).toEqual(["cpu"]);
  });

  it("records unsupported providers instead of silently dropping them", () => {
    const plan = resolveExecutionProviders(["webgpu", "dml"], ["cpu", "webgpu"]);
    expect(plan.providers).toEqual(["webgpu", "cpu"]);
    expect(plan.unavailable).toEqual(["dml"]);
  });

  it("does not duplicate cpu and rejects illegal names", () => {
    expect(resolveExecutionProviders(["cpu", "cpu"], ["cpu"]).providers).toEqual(["cpu"]);
    expect(() => resolveExecutionProviders(["Web GPU"], ["cpu"])).toThrow("名称非法");
  });

  it("probes the runtime bundled providers on this platform", () => {
    const providers = bundledExecutionProviders();
    expect(providers).toContain("cpu");
    expect(providers.length).toBeGreaterThan(0);
  });

  it("loads a real session from in-memory bytes on cpu", async () => {
    const created = await createOnnxSession({ artifact: tinyModel, preferredProviders: ["cpu"] });
    expect(created.executionProvider).toBe("cpu");
    expect(created.fallbackReason).toBeUndefined();
    expect(created.session.inputNames).toEqual(["x"]);
    const outputs = await created.session.run({ x: new (await import("onnxruntime-node")).Tensor("float32", Float32Array.of(1, 2, 3), [3]) });
    expect(outputs.y?.dims).toEqual([1]);
  });

  it("falls back to cpu with an actionable reason when the gpu session fails", async () => {
    const factory = vi.fn(async (_artifact, providers: string[]) => {
      if (providers.includes("webgpu")) throw new Error("no gpu adapter");
      return fakeSession();
    });
    const created = await createOnnxSession({
      artifact: tinyModel,
      preferredProviders: ["webgpu"],
      supported: ["cpu", "webgpu"],
      createSession: factory,
    });
    expect(created.executionProvider).toBe("cpu");
    expect(created.fallbackReason).toContain("webgpu");
    expect(created.fallbackReason).toContain("no gpu adapter");
    expect(factory).toHaveBeenNthCalledWith(2, tinyModel, ["cpu"]);
  });

  it("never pretends success when the pure cpu creation fails", async () => {
    await expect(createOnnxSession({
      artifact: tinyModel,
      preferredProviders: ["cpu"],
      createSession: async () => { throw new Error("native crash"); },
    })).rejects.toThrow("native crash");
  });

  it("rejects an artifact with neither path nor bytes", async () => {
    await expect(createOnnxSession({ artifact: {}, createSession: async () => fakeSession() })).rejects.toThrow("制品缺失");
  });

  it("exposes a cpu session factory that matches the legacy battery options", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "t32-cpu-factory-"));
    const path = join(root, "tiny.onnx");
    await writeFile(path, tinyModel.bytes);
    const session = await createCpuOnnxSession(path);
    expect(session.inputNames).toEqual(["x"]);
    expect(session.outputNames).toEqual(["y"]);
  });

  it("loads a real session from an artifact path", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "t32-providers-"));
    const path = join(root, "tiny.onnx");
    await writeFile(path, tinyModel.bytes);
    const created = await createOnnxSession({ artifact: { path } });
    expect(created.executionProvider).toBe("cpu");
    expect(created.session.outputNames).toEqual(["y"]);
  });
});

function fakeSession() {
  return {
    inputNames: ["x"],
    outputNames: ["y"],
    run: async () => ({ y: { data: Float32Array.of(1), dims: [1], type: "float32" } }),
  };
}
