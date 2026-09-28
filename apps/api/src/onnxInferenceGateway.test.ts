import { describe, expect, it, vi } from "vitest";
import { minimalOnnxLinearModel } from "./fixtures/minimalOnnxLinearModel.js";
import {
  OnnxInferenceGateway,
  OnnxInferenceTimeoutError,
  type OnnxGatewayTensor,
  type RegisteredOnnxModel,
} from "./onnxInferenceGateway.js";
import type { ProviderSession } from "./onnxSessionProviders.js";

const tinyModelBytes = minimalOnnxLinearModel();
/** ORT CPU 对 0.7·1+0.2·2+0.1·3 的 float32 结果。 */
const TINY_EXPECTED_Y = 1.4000000953674316;

function tinyModelDescriptor(overrides: Partial<RegisteredOnnxModel> = {}): RegisteredOnnxModel {
  return {
    modelId: "t32.tiny-linear",
    version: "fixture-v1",
    contract: {
      inputs: [{ name: "x", elementType: "float32", dims: [3] }],
      outputs: [{ name: "y", elementType: "float32", dims: [1] }],
    },
    modelBytes: tinyModelBytes,
    timeoutMs: 10_000,
    ...overrides,
  };
}

function tensor(data: number[], dims: number[]): OnnxGatewayTensor {
  return { data: Float32Array.from(data), dims };
}

/** 逐位比较浮点张量:必须走内存字节视图;Buffer.from(Float32Array) 会按数值截断成字节,比较无效。 */
function bitwiseEqual(left: Float32Array, right: Float32Array): boolean {
  const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
  return leftBytes.length === rightBytes.length && leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function fakeSession(overrides: Partial<ProviderSession> = {}): ProviderSession {
  return {
    inputNames: ["x"],
    outputNames: ["y"],
    run: async () => ({ y: { data: Float32Array.of(1), dims: [1], type: "float32" } }),
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("onnx inference gateway — deterministic execution (real model)", () => {
  it("returns the exact float32 result of the real linear graph", async () => {
    const gateway = new OnnxInferenceGateway();
    gateway.register(tinyModelDescriptor());
    const result = await gateway.infer({ modelId: "t32.tiny-linear", inputs: { x: tensor([1, 2, 3], [3]) } });
    expect(result.executionProvider).toBe("cpu");
    expect(result.version).toBe("fixture-v1");
    expect(result.outputs.y?.dims).toEqual([1]);
    expect((result.outputs.y?.data as Float32Array)[0]).toBe(TINY_EXPECTED_Y);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("is bitwise identical across two runs on the same session", async () => {
    // 负对照:比较器必须能区分不同位型(CPU 与 WebGPU 在本机的真实差异)。
    expect(bitwiseEqual(Float32Array.of(TINY_EXPECTED_Y), Float32Array.of(1.399999976158142))).toBe(false);
    const gateway = new OnnxInferenceGateway();
    gateway.register(tinyModelDescriptor());
    const first = await gateway.infer({ modelId: "t32.tiny-linear", inputs: { x: tensor([1, 2, 3], [3]) } });
    const second = await gateway.infer({ modelId: "t32.tiny-linear", inputs: { x: tensor([1, 2, 3], [3]) } });
    expect(bitwiseEqual(first.outputs.y!.data as Float32Array, second.outputs.y!.data as Float32Array)).toBe(true);
  });

  it("is bitwise identical across two independently loaded sessions", async () => {
    const left = new OnnxInferenceGateway();
    const right = new OnnxInferenceGateway();
    left.register(tinyModelDescriptor());
    right.register(tinyModelDescriptor());
    const input = { modelId: "t32.tiny-linear", inputs: { x: tensor([0.1, -2.5, 7.25], [3]) } };
    const a = await left.infer(input);
    const b = await right.infer(input);
    expect(bitwiseEqual(a.outputs.y!.data as Float32Array, b.outputs.y!.data as Float32Array)).toBe(true);
  });

  it("keeps concurrent inferences consistent on one session", async () => {
    const gateway = new OnnxInferenceGateway();
    gateway.register(tinyModelDescriptor());
    const inputs = { modelId: "t32.tiny-linear", inputs: { x: tensor([1, 1, 1], [3]) } };
    const results = await Promise.all([gateway.infer(inputs), gateway.infer(inputs), gateway.infer(inputs)]);
    const baseline = results[0]!.outputs.y!.data as Float32Array;
    for (const result of results) {
      expect(bitwiseEqual(baseline, result.outputs.y!.data as Float32Array)).toBe(true);
    }
  });

  it("attempts the optional webgpu provider and degrades to cpu without changing the contract", async () => {
    const gateway = new OnnxInferenceGateway({ preferredProviders: ["webgpu"], supportedProviders: ["cpu", "webgpu"] });
    gateway.register(tinyModelDescriptor());
    const result = await gateway.infer({ modelId: "t32.tiny-linear", inputs: { x: tensor([1, 2, 3], [3]) } });
    if (result.executionProvider === "webgpu") {
      expect(result.fallbackReason).toBeUndefined();
    } else {
      expect(result.executionProvider).toBe("cpu");
      expect(result.fallbackReason).toBeTruthy();
    }
    expect(result.outputs.y?.dims).toEqual([1]);
    await gateway.dispose();
  }, 30_000);
});

describe("onnx inference gateway — fail-closed contract matrix", () => {
  it("rejects unknown model ids with the registered list", async () => {
    const gateway = new OnnxInferenceGateway();
    gateway.register(tinyModelDescriptor());
    await expect(gateway.infer({ modelId: "nope", inputs: {} })).rejects.toThrow("未注册的 ONNX 模型");
  });

  it("rejects missing, extra, mistyped, misranked and short inputs", async () => {
    const gateway = new OnnxInferenceGateway();
    gateway.register(tinyModelDescriptor());
    const modelId = "t32.tiny-linear";
    await expect(gateway.infer({ modelId, inputs: {} })).rejects.toThrow("缺少输入张量");
    await expect(gateway.infer({ modelId, inputs: { x: tensor([1, 2, 3], [3]), extra: tensor([1], [1]) } }))
      .rejects.toThrow("契约之外的输入");
    await expect(gateway.infer({ modelId, inputs: { x: { data: Int32Array.of(1, 2, 3), dims: [3] } } }))
      .rejects.toThrow("元素类型不符");
    await expect(gateway.infer({ modelId, inputs: { x: tensor([1, 2, 3], [1, 3]) } })).rejects.toThrow("秩不符");
    await expect(gateway.infer({ modelId, inputs: { x: tensor([1, 2, 3], [4]) } })).rejects.toThrow("第 0 维不符");
    await expect(gateway.infer({ modelId, inputs: { x: tensor([1, 2], [3]) } })).rejects.toThrow("数据长度不符");
  });

  it("accepts dynamic dims declared in the contract (injected session)", async () => {
    const gateway = new OnnxInferenceGateway({
      createSession: async () => fakeSession({
        run: async () => ({ y: { data: Float32Array.of(5), dims: [1], type: "float32" } }),
      }),
    });
    gateway.register(tinyModelDescriptor({
      contract: {
        inputs: [{ name: "x", elementType: "float32", dims: ["dynamic"] }],
        outputs: [{ name: "y", elementType: "float32", dims: [1] }],
      },
    }));
    const result = await gateway.infer({ modelId: "t32.tiny-linear", inputs: { x: tensor([1, 2, 3, 4], [4]) } });
    expect((result.outputs.y?.data as Float32Array)[0]).toBe(5);
  });

  it("fails closed when the loaded session does not match the declared contract", async () => {
    const gateway = new OnnxInferenceGateway({ createSession: async () => fakeSession({ inputNames: ["z"], outputNames: ["q"] }) });
    gateway.register(tinyModelDescriptor());
    await expect(gateway.infer({ modelId: "t32.tiny-linear", inputs: { x: tensor([1, 2, 3], [3]) } }))
      .rejects.toThrow("契约不符");
  });

  it("fails closed on missing, mistyped, misdimmed or non-finite outputs (injected session)", async () => {
    const modelId = "t32.tiny-linear";
    const cases: Array<{ session: ProviderSession; expected: RegExp }> = [
      { session: fakeSession({ run: async () => ({}) }), expected: /缺少契约输出/ },
      { session: fakeSession({ run: async () => ({ y: { data: Float32Array.of(1), dims: [1], type: "int32" } }) }), expected: /元素类型不符/ },
      { session: fakeSession({ run: async () => ({ y: { data: Float32Array.of(1, 2), dims: [2], type: "float32" } }) }), expected: /第 0 维不符/ },
      { session: fakeSession({ run: async () => ({ y: { data: Float32Array.of(Number.NaN), dims: [1], type: "float32" } }) }), expected: /非有限数值/ },
      { session: fakeSession({ run: async () => ({ y: { data: Float32Array.of(Number.POSITIVE_INFINITY), dims: [1], type: "float32" } }) }), expected: /非有限数值/ },
    ];
    for (const item of cases) {
      const gateway = new OnnxInferenceGateway({ createSession: async () => item.session });
      gateway.register(tinyModelDescriptor());
      await expect(gateway.infer({ modelId, inputs: { x: tensor([1, 2, 3], [3]) } })).rejects.toThrow(item.expected);
    }
  });
});

describe("onnx inference gateway — registration and lifecycle", () => {
  it("rejects invalid descriptors and duplicate ids", () => {
    const gateway = new OnnxInferenceGateway();
    expect(() => gateway.register(tinyModelDescriptor({ modelId: " " }))).toThrow("modelId");
    expect(() => gateway.register(tinyModelDescriptor({ version: "" }))).toThrow("版本");
    expect(() => gateway.register(tinyModelDescriptor({ timeoutMs: 0 }))).toThrow("超时");
    expect(() => gateway.register(tinyModelDescriptor({
      contract: { inputs: [], outputs: [{ name: "y", elementType: "float32", dims: [1] }] },
    }))).toThrow("输入契约不能为空");
    expect(() => gateway.register(tinyModelDescriptor({
      contract: {
        inputs: [{ name: "x", elementType: "complex128" as never, dims: [3] }],
        outputs: [{ name: "y", elementType: "float32", dims: [1] }],
      },
    }))).toThrow("元素类型无效");
    expect(() => gateway.register(tinyModelDescriptor({
      contract: {
        inputs: [{ name: "x", elementType: "float32", dims: [0] }],
        outputs: [{ name: "y", elementType: "float32", dims: [1] }],
      },
    }))).toThrow("维度无效");
    expect(() => gateway.register(tinyModelDescriptor({ artifactPath: "a.onnx", modelBytes: tinyModelBytes }))).toThrow("来源歧义");
    expect(() => gateway.register(tinyModelDescriptor({ modelBytes: undefined, artifactPath: undefined }))).toThrow("缺少制品");
    gateway.register(tinyModelDescriptor());
    expect(() => gateway.register(tinyModelDescriptor())).toThrow("重复注册");
    expect(gateway.has("t32.tiny-linear")).toBe(true);
    expect(gateway.list()).toHaveLength(1);
  });

  it("allows retry after a failed session load instead of caching the rejection", async () => {
    const createSession = vi.fn(async () => fakeSession());
    createSession.mockRejectedValueOnce(new Error("temporary load failure"));
    const gateway = new OnnxInferenceGateway({ createSession });
    gateway.register(tinyModelDescriptor());
    await expect(gateway.infer({ modelId: "t32.tiny-linear", inputs: { x: tensor([1, 2, 3], [3]) } }))
      .rejects.toThrow("temporary load failure");
    const result = await gateway.infer({ modelId: "t32.tiny-linear", inputs: { x: tensor([1, 2, 3], [3]) } });
    expect(result.outputs.y?.dims).toEqual([1]);
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it("reuses the session across inferences", async () => {
    const createSession = vi.fn(async () => fakeSession());
    const gateway = new OnnxInferenceGateway({ createSession });
    gateway.register(tinyModelDescriptor());
    await gateway.infer({ modelId: "t32.tiny-linear", inputs: { x: tensor([1, 2, 3], [3]) } });
    await gateway.infer({ modelId: "t32.tiny-linear", inputs: { x: tensor([1, 2, 3], [3]) } });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(gateway.list()[0]?.sessionLoaded).toBe(true);
  });
});

describe("onnx inference gateway — timeout, cancellation and disposal", () => {
  it("rejects with OnnxInferenceTimeoutError when the run exceeds the deadline", async () => {
    const gateway = new OnnxInferenceGateway({
      createSession: async () => fakeSession({
        run: () => new Promise((resolve) => setTimeout(() => resolve({ y: { data: Float32Array.of(1), dims: [1], type: "float32" } }), 400)),
      }),
    });
    gateway.register(tinyModelDescriptor({ timeoutMs: 10_000 }));
    await expect(gateway.infer({ modelId: "t32.tiny-linear", inputs: { x: tensor([1, 2, 3], [3]) }, timeoutMs: 30 }))
      .rejects.toBeInstanceOf(OnnxInferenceTimeoutError);
  });

  it("stays usable for later inferences after a timed-out run", async () => {
    let releaseSlowRun: ((value: Record<string, { data: ArrayLike<number>; dims: number[]; type: string }>) => void) | undefined;
    let slowMode = true;
    const gateway = new OnnxInferenceGateway({
      createSession: async () => fakeSession({
        run: async () => {
          if (!slowMode) return { y: { data: Float32Array.of(1), dims: [1], type: "float32" } };
          return new Promise((resolve) => {
            releaseSlowRun = (value) => { slowMode = false; resolve(value); };
          });
        },
      }),
    });
    gateway.register(tinyModelDescriptor());
    const timedOut = gateway.infer({ modelId: "t32.tiny-linear", inputs: { x: tensor([1, 2, 3], [3]) }, timeoutMs: 20 });
    await expect(timedOut).rejects.toBeInstanceOf(OnnxInferenceTimeoutError);
    releaseSlowRun?.({ y: { data: Float32Array.of(1), dims: [1], type: "float32" } });
    const result = await gateway.infer({ modelId: "t32.tiny-linear", inputs: { x: tensor([1, 2, 3], [3]) } });
    expect(result.outputs.y?.dims).toEqual([1]);
  });

  it("rejects invalid timeout configurations", async () => {
    const gateway = new OnnxInferenceGateway({ createSession: async () => fakeSession() });
    gateway.register(tinyModelDescriptor());
    await expect(gateway.infer({ modelId: "t32.tiny-linear", inputs: { x: tensor([1, 2, 3], [3]) }, timeoutMs: 0 }))
      .rejects.toThrow("超时必须为有限正数");
  });

  it("rejects a caller signal that is already aborted", async () => {
    const gateway = new OnnxInferenceGateway({ createSession: async () => fakeSession() });
    gateway.register(tinyModelDescriptor());
    const controller = new AbortController();
    controller.abort(new Error("调用方已取消"));
    await expect(gateway.infer({ modelId: "t32.tiny-linear", inputs: { x: tensor([1, 2, 3], [3]) }, signal: controller.signal }))
      .rejects.toThrow("调用方已取消");
  });

  it("rejects promptly when the caller cancels mid-run", async () => {
    const gateway = new OnnxInferenceGateway({
      createSession: async () => fakeSession({
        run: () => new Promise(() => undefined),
      }),
    });
    gateway.register(tinyModelDescriptor());
    const controller = new AbortController();
    const pending = gateway.infer({ modelId: "t32.tiny-linear", inputs: { x: tensor([1, 2, 3], [3]) }, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("推理被取消")), 10);
    await expect(pending).rejects.toThrow("推理被取消");
    await flushMicrotasks();
  });

  it("rejects every use after dispose and releases loaded sessions", async () => {
    const release = vi.fn();
    const gateway = new OnnxInferenceGateway({ createSession: async () => fakeSession({ release }) });
    gateway.register(tinyModelDescriptor());
    await gateway.infer({ modelId: "t32.tiny-linear", inputs: { x: tensor([1, 2, 3], [3]) } });
    await gateway.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    await expect(gateway.infer({ modelId: "t32.tiny-linear", inputs: { x: tensor([1, 2, 3], [3]) } })).rejects.toThrow("已释放");
    expect(() => gateway.register(tinyModelDescriptor({ modelId: "another" }))).toThrow("已释放");
    await expect(gateway.dispose()).resolves.toBeUndefined();
  });
});
