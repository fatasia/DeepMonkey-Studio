import { describe, expect, it } from "vitest";
import {
  HI_Z_FIRST_STAGE_SUBGROUP_NAME, HI_Z_SUBGROUP_WORKGROUP_SIZE, buildHiZFirstStageKernel,
  buildHiZFirstStageSubgroupKernel, emitKernelGlsl, emitKernelWgsl, generateHiZInput,
  hiZFirstStageSubgroupDispatchSize, kernelIrSha256, kernelUsesSubgroupOps,
  referenceHiZFirstStage, referenceHiZFirstStageSubgroup, validateKernel,
} from "./index.js";

const sameBits = (a: Float32Array, b: Float32Array): boolean => {
  if (a.length !== b.length) return false;
  const bitsA = new Uint32Array(a.buffer), bitsB = new Uint32Array(b.buffer);
  for (let index = 0; index < bitsA.length; index++) if (bitsA[index] !== bitsB[index]) return false;
  return true;
};

describe("Hi-Z first-stage subgroup DCIR kernel", () => {
  it("builds valid min/max kernels with deterministic emission and stable IR hashes", () => {
    const min = buildHiZFirstStageSubgroupKernel(false);
    const max = buildHiZFirstStageSubgroupKernel(true);
    expect(validateKernel(min)).toEqual([]);
    expect(validateKernel(max)).toEqual([]);
    expect(min.name).toBe(HI_Z_FIRST_STAGE_SUBGROUP_NAME);
    expect([...min.workgroupSize]).toEqual([...HI_Z_SUBGROUP_WORKGROUP_SIZE]);
    expect(kernelUsesSubgroupOps(min)).toBe(true);
    const wgslMin = emitKernelWgsl(min);
    expect(wgslMin.irSha256).toBe(kernelIrSha256(min));
    expect(wgslMin.code).toBe(emitKernelWgsl(buildHiZFirstStageSubgroupKernel(false)).code);
    // ±Inf 吸收值必须哈希可区分（min/+Inf 与 max/-Inf 是不同 IR，缓存不得串 shader）。
    expect(kernelIrSha256(min)).toBe("f2415bd729a2f744694a5e8d80e91a543a9e31b07d25a6136b38c6678a1fc35a");
    expect(kernelIrSha256(max)).toBe("b29bf38551fa1177295bd3f6a3a4a66ebfbd5014cde8493ef8669f601b4174b8");
    expect(min.uniforms.map((uniform) => uniform.name)).toEqual(["sourceSize", "targetSize"]);
  });

  it("emits WGSL with requires subgroups, lane builtin, subgroupMin/Max and bitcast absorbers", () => {
    const { code, features } = emitKernelWgsl(buildHiZFirstStageSubgroupKernel(false));
    expect(features).toEqual(["subgroups"]);
    expect(code).toContain("requires subgroups;");
    expect(code.indexOf("requires subgroups;")).toBeLessThan(code.indexOf("struct DeepKernelUniforms"));
    expect(code).toContain(
      "fn hi_z_first_stage_subgroup(@builtin(global_invocation_id) deepGlobalId: vec3u, " +
      "@builtin(subgroup_invocation_id) deepSubgroupLane: u32) {",
    );
    expect(code).toContain("let n_lane: u32 = deepSubgroupLane;");
    expect(code).toContain("subgroupMin(");
    expect(code).not.toContain("subgroupMax(");
    expect(code).toContain("let n_absorber: f32 = bitcast<f32>(0x7f800000u);");
    const maxCode = emitKernelWgsl(buildHiZFirstStageSubgroupKernel(true)).code;
    expect(maxCode).toContain("subgroupMax(");
    expect(maxCode).toContain("let n_absorber: f32 = bitcast<f32>(0xff800000u);");
  });

  it("keeps legacy kernel emission byte-identical (no requires, no lane param)", () => {
    const legacy = emitKernelWgsl(buildHiZFirstStageKernel(false));
    expect(legacy.features).toEqual([]);
    expect(legacy.code).not.toContain("requires");
    expect(legacy.code).toContain("fn hi_z_first_stage(@builtin(global_invocation_id) deepGlobalId: vec3u) {");
    expect(kernelUsesSubgroupOps(buildHiZFirstStageKernel(false))).toBe(false);
  });

  it("fails closed on GLSL: subgroup ops require WebGPU backend", () => {
    expect(() => emitKernelGlsl(buildHiZFirstStageSubgroupKernel(false)))
      .toThrow(/subgroup ops require WebGPU backend/);
  });

  it("validates subgroup op types and input arity at IR level", () => {
    const kernel = buildHiZFirstStageSubgroupKernel(false);
    const load = kernel.nodes.find((node) => node.op === "texel-load")!;
    // subgroup-min 的操作数必须是 f32：指向 u32 节点 → type-mismatch。
    const badOperand = {
      ...kernel,
      nodes: kernel.nodes.map((node) =>
        node.op === "subgroup-min" ? { ...node, id: "sub_bad", input: load.coords } : node),
    };
    expect(validateKernel(badOperand).some((issue) => issue.code === "type-mismatch")).toBe(true);
    // 元数合同：缺 input 引用 → invalid-input（运行时校验，持久化 IR 可能来自不受信 JSON）。
    const missingInput = {
      ...kernel,
      nodes: kernel.nodes.map((node) => {
        if (node.op !== "subgroup-min") return node;
        const { input: _removed, ...rest } = node;
        return rest;
      }),
    };
    expect(validateKernel(missingInput as unknown as typeof kernel).some((issue) => issue.code === "invalid-input")).toBe(true);
    // subgroup-invocation-id 必须 u32。
    const badLane = {
      ...kernel,
      nodes: kernel.nodes.map((node) =>
        node.op === "subgroup-invocation-id" ? { ...node, type: "f32" as const } : node),
    };
    expect(validateKernel(badLane).some((issue) => issue.code === "type-mismatch")).toBe(true);
    // Infinity 字面量仅 f32 合法（吸收值合同）。
    expect(validateKernel(kernel)).toEqual([]);
    const badInfinity = {
      ...kernel,
      nodes: kernel.nodes.map((node) =>
        node.op === "literal" && node.type === "u32" ? { ...node, value: Number.POSITIVE_INFINITY } : node),
    };
    expect(validateKernel(badInfinity).some((issue) => issue.code === "invalid-literal")).toBe(true);
  });

  it("subgroup reference is bitwise identical to the certified 2x2 reference across sizes and subgroup sizes", () => {
    const sizes: readonly (readonly [number, number])[] = [
      [1, 1], [2, 1], [1, 2], [2, 2], [3, 3], [5, 4], [16, 16], [31, 1], [1, 31],
      [37, 23], [33, 17], [64, 64], [65, 63],
    ];
    for (const [width, height] of sizes) {
      const input = generateHiZInput(0x5eed_0050 + width * 131 + height, width, height);
      const expected = referenceHiZFirstStage(input, width, height, false);
      const expectedMax = referenceHiZFirstStage(input, width, height, true);
      for (const subgroupSize of [4, 8, 12, 16, 32]) {
        const minOut = referenceHiZFirstStageSubgroup(input, width, height, false, subgroupSize);
        const maxOut = referenceHiZFirstStageSubgroup(input, width, height, true, subgroupSize);
        expect(sameBits(minOut, expected), `${width}x${height} min s=${subgroupSize}`).toBe(true);
        expect(sameBits(maxOut, expectedMax), `${width}x${height} max s=${subgroupSize}`).toBe(true);
        for (const value of minOut) expect(Number.isNaN(value)).toBe(false);
      }
    }
  });

  it("preserves the adversarial -0/tie/inf edges of the 3x3 reference case", () => {
    const input = new Float32Array([0.75, 0.25, -0, 0.5, 1, 0.125, 0, 0.5, 0.625]);
    for (const subgroupSize of [4, 8, 16]) {
      const minOut = referenceHiZFirstStageSubgroup(input, 3, 3, false, subgroupSize);
      const maxOut = referenceHiZFirstStageSubgroup(input, 3, 3, true, subgroupSize);
      expect([...minOut]).toEqual([0.25, 0, 0, 0.625]);
      expect([...maxOut]).toEqual([1, 0.125, 0.5, 0.625]);
      const bits = new Uint32Array(minOut.buffer);
      expect([...bits]).toEqual([0x3e800000, 0, 0, 0x3f200000]); // -0 已折叠为 +0
    }
  });

  it("exposes dispatch geometry and enforces the 4-divides-subgroupSize layout contract", () => {
    expect(hiZFirstStageSubgroupDispatchSize(64, 64)).toEqual([32, 4]);
    expect(hiZFirstStageSubgroupDispatchSize(37, 23)).toEqual([19, 2]);
    expect(hiZFirstStageSubgroupDispatchSize(1, 1)).toEqual([1, 1]);
    const input = generateHiZInput(7, 8, 8);
    expect(() => referenceHiZFirstStageSubgroup(input, 8, 8, false, 3)).toThrow("multiple of 4");
    expect(() => referenceHiZFirstStageSubgroup(input, 8, 8, false, 0)).toThrow("multiple of 4");
  });
});
