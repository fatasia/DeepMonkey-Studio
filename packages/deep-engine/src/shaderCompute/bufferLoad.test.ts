import { describe, expect, it } from "vitest";
import { KernelBuilder } from "./kernel.js";
import { emitKernelGlsl } from "./emitGlsl.js";
import { emitKernelWgsl } from "./emitWgsl.js";
import type { DcirKernel } from "./types.js";

/** v1 buffer-load 内核:从只读 storage buffer 读 u32,与阈值比较作为 guard。 */
function bufferKernel(): DcirKernel {
  const builder = new KernelBuilder();
  const gid = builder.push({ id: "gid", type: "vec2u", op: "global-invocation-id" });
  const x = builder.push({ id: "x", type: "u32", op: "component", input: gid });
  const index = builder.push({ id: "index", type: "u32", op: "buffer-load", buffer: "visibleFlags", index: x });
  const threshold = builder.push({ id: "threshold", type: "u32", op: "literal", value: 1 });
  const visible = builder.push({ id: "visible", type: "bool", op: "ieq", inputs: [index, threshold] });
  const half = builder.push({ id: "half", type: "f32", op: "literal", value: 0.5 });
  const value = builder.push({ id: "value", type: "f32", op: "canonicalize-f32", input: half });
  const coords = builder.push({ id: "coords", type: "vec2u", op: "make-vec2u", inputs: [x, x] });
  return {
    name: "buffer_read_smoke",
    textureIo: "r32float",
    workgroupSize: [8, 8],
    uniforms: [],
    buffers: [{ name: "visibleFlags", elementType: "u32", access: "read" }],
    nodes: builder.nodes(),
    guard: visible,
    output: { coords, value },
  };
}

describe("DCIR v1 buffer-load", () => {
  it("emits read-only storage bindings and bounds-checked loads in WGSL", () => {
    const { code } = emitKernelWgsl(bufferKernel());
    expect(code).toContain("var<storage, read> deep_visibleFlags: array<u32>;");
    expect(code).toContain("@group(0) @binding(2)");
    expect(code).toContain("arrayLength(&deep_visibleFlags)");
    expect(code).toContain("deep_visibleFlags[n_x]");
  });

  it("fails closed on GLSL emission (WebGL2 has no SSBO path)", () => {
    expect(() => emitKernelGlsl(bufferKernel())).toThrowError(/WebGPU\/Native only/);
  });

  it("rejects undeclared buffers and element-type mismatches", () => {
    const kernel = bufferKernel();
    const broken: DcirKernel = {
      ...kernel,
      nodes: kernel.nodes.map((node) =>
        node.op === "buffer-load" ? { ...node, buffer: "ghost" } : node,
      ),
    };
    expect(() => emitKernelWgsl(broken)).toThrowError(/unknown-buffer.*"ghost"/u);
    const wrongType: DcirKernel = {
      ...kernel,
      buffers: [{ name: "visibleFlags", elementType: "f32", access: "read" }],
    };
    expect(() => emitKernelWgsl(wrongType)).toThrowError(/type-mismatch.*carries f32/u);
  });

  it("keeps irSha256 stable for identical kernels and sensitive to buffer declarations", () => {
    const first = emitKernelWgsl(bufferKernel());
    const second = emitKernelWgsl(bufferKernel());
    expect(first.irSha256).toBe(second.irSha256);
    const wider: DcirKernel = {
      ...bufferKernel(),
      buffers: [
        { name: "visibleFlags", elementType: "u32", access: "read" },
        { name: "extra", elementType: "f32", access: "read" },
      ],
    };
    expect(emitKernelWgsl(wider).irSha256).not.toBe(first.irSha256);
  });
});
