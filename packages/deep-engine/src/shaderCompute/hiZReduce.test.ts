import { describe, expect, it } from "vitest";
import {
  buildHiZFirstStageKernel, emitKernelGlsl, emitKernelWgsl, generateHiZInput, DCIR_GLSL_VERTEX,
  hiZFirstStageTargetSize, kernelIrSha256, referenceHiZFirstStage, validateKernel,
} from "./index.js";

describe("Hi-Z first-stage DCIR kernel", () => {
  it("builds valid min/max kernels with deterministic emission and stable IR hashes", () => {
    const min = buildHiZFirstStageKernel(false);
    const max = buildHiZFirstStageKernel(true);
    expect(validateKernel(min)).toEqual([]);
    expect(validateKernel(max)).toEqual([]);
    const wgslMin = emitKernelWgsl(min);
    const glslMin = emitKernelGlsl(min);
    expect(wgslMin.irSha256).toBe(kernelIrSha256(min));
    expect(glslMin.irSha256).toBe(wgslMin.irSha256);
    expect(wgslMin.code).toBe(emitKernelWgsl(buildHiZFirstStageKernel(false)).code);
    expect(kernelIrSha256(min)).toBe("2356435319d8607f08fd589261837cff774b96b64ca14c7cdc640316d182b6e6");
    expect(kernelIrSha256(max)).toBe("4dfb1ea6e9f2d649d7a6d3326a0481d5c140bc2a5caea4f04b766b73e2e8636f");
    // 模式特化只允许改变归约方向；IR 哈希头注释随模式不同，比较时剥去注释行。
    const stripHeader = (text: string): string =>
      text.split("\n").filter((line) => !line.startsWith("//")).join("\n");
    const wgslBody = (kernel: ReturnType<typeof buildHiZFirstStageKernel>): string =>
      stripHeader(emitKernelWgsl(kernel).code);
    const glslBody = (kernel: ReturnType<typeof buildHiZFirstStageKernel>): string =>
      stripHeader(emitKernelGlsl(kernel).fragment);
    expect(wgslBody(max).replace(/max\(/g, "min(")).toBe(wgslBody(min));
    expect(glslBody(max).replace(/max\(/g, "min(")).toBe(glslBody(min));
    expect(min.uniforms.map((uniform) => uniform.name)).toEqual(["sourceSize", "targetSize"]);
  });

  it("emits WGSL compute with uniforms, ordered lets, guard and store", () => {
    const { code } = emitKernelWgsl(buildHiZFirstStageKernel(false));
    expect(code).toContain("@compute @workgroup_size(8, 8, 1)");
    expect(code).toContain("var deepSource: texture_2d<f32>;");
    expect(code).toContain("var deepTarget: texture_storage_2d<r32float, write>;");
    expect(code).toContain("sourceSize: vec2u,");
    expect(code).toContain("let n_value: f32 = select(n_v3, 0.0, n_v3 == 0.0);");
    expect(code.indexOf("let n_gid:")).toBeLessThan(code.indexOf("let n_tx:"));
    expect(code).toContain("if (!(n_inside)) { return; }");
    expect(code).toContain("textureStore(deepTarget, vec2i(n_gid), vec4f(n_value, 0.0, 0.0, 0.0));");
  });

  it("emits GLSL ES 3.0 fragment lowering with texelFetch and shared fullscreen triangle", () => {
    const { fragment, vertex } = emitKernelGlsl(buildHiZFirstStageKernel(false));
    expect(fragment.startsWith("#version 300 es\n")).toBe(true);
    expect(fragment).toContain("uniform highp sampler2D deepSource;");
    expect(fragment).toContain("uniform uvec2 deep_u_sourceSize;");
    expect(fragment).toContain("uint n_tx = n_gid.x;");
    expect(fragment).toContain("float n_s10 = texelFetch(deepSource, ivec2(n_c10), 0).r;");
    expect(fragment).toContain("float n_value = (n_v3 == 0.0 ? 0.0 : n_v3);");
    expect(fragment).toContain("if (!(n_inside)) { discard; }");
    expect(vertex).toBe(DCIR_GLSL_VERTEX);
    expect(DCIR_GLSL_VERTEX).toContain("gl_VertexID");
  });

  it("rejects out-of-order references, type mismatches and bad literals", () => {
    const kernel = buildHiZFirstStageKernel(false);
    const reordered = { ...kernel, nodes: [...kernel.nodes].reverse() };
    expect(validateKernel(reordered).some((issue) => issue.code === "unknown-node")).toBe(true);
    expect(validateKernel({ ...kernel, guard: "n_s00" }).some((issue) => issue.code === "invalid-guard")).toBe(true);
    expect(validateKernel({ ...kernel, output: { coords: "gid", value: "gid" } }).some((issue) => issue.code === "invalid-output")).toBe(true);
    expect(() => emitKernelWgsl(reordered)).toThrow(/unknown-node/);
  });

  it("computes first-stage target sizes including odd and tiny sources", () => {
    expect(hiZFirstStageTargetSize(37, 23)).toEqual([19, 12]);
    expect(hiZFirstStageTargetSize(64, 64)).toEqual([32, 32]);
    expect(hiZFirstStageTargetSize(1, 1)).toEqual([1, 1]);
    expect(() => hiZFirstStageTargetSize(0, 4)).toThrow("positive");
  });

  it("reference reduction matches brute-force clamped 2x2 min/max and folds -0", () => {
    const input = new Float32Array([0.75, 0.25, -0, 0.5, 1, 0.125, 0, 0.5, 0.625]);
    // cell(1,0)：种子 -0、两角越界回退、对 0.125 取 min → -0 → canonicalize 折叠为 +0。
    expect(referenceHiZFirstStage(input, 3, 3, false)).toEqual(new Float32Array([0.25, 0, 0, 0.625]));
    expect(referenceHiZFirstStage(input, 3, 3, true)).toEqual(new Float32Array([1, 0.125, 0.5, 0.625]));
    const bits = new Uint32Array(referenceHiZFirstStage(input, 3, 3, false).buffer);
    expect([...bits]).toEqual([0x3e800000, 0, 0, 0x3f200000]);
  });

  it("generates deterministic inputs with exact f32 values and adversarial ties", () => {
    const first = generateHiZInput(0x5eed_0002, 37, 23);
    const second = generateHiZInput(0x5eed_0002, 37, 23);
    expect(Buffer.from(first.buffer).equals(Buffer.from(second.buffer))).toBe(true);
    expect(first[0]).toBe(0);
    expect(Object.is(first[1], -0)).toBe(true);
    expect(first[2]).toBe(1);
    expect(first[3]).toBe(first[4]);
    expect(first[5]).toBe(Number.POSITIVE_INFINITY);
    const bits = new Uint32Array(first.buffer);
    expect(bits[0]).toBe(0);
    expect(bits[1]).toBe(0x8000_0000);
    for (const value of first) {
      expect(Number.isNaN(value)).toBe(false);
      expect(value === 0 || Math.fround(value) === value).toBe(true);
    }
    const denormal = generateHiZInput(7, 17, 9, { denormal: true });
    const denormalBits = new Uint32Array(denormal.buffer);
    expect((denormalBits[3]! & 0x7f80_0000) === 0).toBe(true);
    expect(denormalBits[3]! & 0x007f_ffff).toBeGreaterThan(0);
  });
});
