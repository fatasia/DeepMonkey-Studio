import { describe, expect, it } from "vitest";
import { emitKernelGlsl, emitKernelWgsl, KernelBuilder, validateKernel } from "./index.js";
import type { DcirKernel } from "./types.js";

function v1Kernel(): DcirKernel {
  const builder = new KernelBuilder();
  const gid = builder.push({ id: "gid", type: "vec2u", op: "global-invocation-id" });
  const x = builder.push({ id: "x", type: "u32", op: "component", input: gid });
  const seed = builder.push({ id: "seed", type: "u32", op: "literal", value: 17 });
  const salt = builder.push({ id: "salt", type: "u32", op: "literal", value: 29 });
  const rng = builder.push({ id: "rng", type: "u32", op: "hash-rng", seed, salt });
  const value = builder.push({ id: "value", type: "f32", op: "literal", value: 1 });
  const stored = builder.push({ id: "stored", type: "f32", op: "buffer-store", buffer: "scratch", index: x, value });
  const guard = builder.push({ id: "guard", type: "bool", op: "literal", value: true });
  const coords = builder.push({ id: "coords", type: "vec2u", op: "make-vec2u", inputs: [x, x] });
  const loopIndex = { id: "loopIndex", type: "u32", op: "loop-index", loopId: "steps" } as const;
  void loopIndex;
  return {
    name: "v1_storage_write_rng",
    workgroupSize: [8, 8], uniforms: [],
    buffers: [{ name: "scratch", elementType: "f32", access: "read_write" }],
    nodes: [...builder.nodes()],
    loops: [{ id: "steps", indexId: "loopIndex", start: 0, end: 4, step: 1, body: [] }],
    guard, output: { coords, value },
  };
}

describe("DCIR v1 read-write storage, static loops, and hash-rng", () => {
  it("validates and emits deterministic WGSL", () => {
    const kernel = v1Kernel();
    expect(validateKernel(kernel)).toEqual([]);
    const first = emitKernelWgsl(kernel);
    const second = emitKernelWgsl(v1Kernel());
    expect(first.irSha256).toBe(second.irSha256);
    expect(first.code).toBe(second.code);
    expect(first.code).toContain("var<storage, read_write> deep_scratch: array<f32>;");
    expect(first.code).toContain("fn deepPcg(state: u32) -> u32");
    expect(first.code).toContain("let n_rng: u32 = deepPcg(n_seed ^ n_salt);");
    expect(first.code).toContain("deep_scratch[n_x] = n_value;");
    expect(first.code).toContain("for (var l_steps: u32 = 0u; l_steps < 4u; l_steps = l_steps + 1u)");
  });

  it("fails closed for every v1 capability in GLSL/WebGL2", () => {
    expect(() => emitKernelGlsl(v1Kernel())).toThrow(/storage buffers|v2 op|cannot be emitted/i);
    const noBuffer = v1Kernel();
    expect(() => emitKernelGlsl({ ...noBuffer, buffers: [], nodes: noBuffer.nodes.filter((node) => node.op !== "buffer-store" && node.op !== "hash-rng"), loops: undefined })).not.toThrow();
  });

  it("rejects stores to read-only buffers and invalid static ranges", () => {
    const kernel = v1Kernel();
    expect(validateKernel({ ...kernel, buffers: [{ name: "scratch", elementType: "f32", access: "read" }] }).some((issue) => issue.code === "buffer-not-writable")).toBe(true);
    expect(validateKernel({ ...kernel, loops: [{ id: "steps", indexId: "loopIndex", start: 4, end: 0, step: 1, body: [] }] }).some((issue) => issue.code === "invalid-loop")).toBe(true);
    expect(validateKernel({ ...kernel, loops: [{ id: "steps", indexId: "loopIndex", start: 0, end: 5000, step: 1, body: [] }] }).some((issue) => issue.code === "invalid-loop")).toBe(true);
  });
});
