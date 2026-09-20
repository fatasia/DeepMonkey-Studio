import { describe, expect, it } from "vitest";
import {
  buildHiZFirstStageKernel, buildHiZVariableReduceKernel, emitKernelGlsl, emitKernelWgsl, generateHiZInput,
  hiZChainLevelCount, hiZChainLevelSize, HI_Z_VARIABLE_REDUCE_NAME, kernelIrSha256,
  referenceHiZChain, referenceHiZFirstStage, referenceHiZVariableReduce, usesAnchoredReduce, validateKernel,
} from "./index.js";

describe("Hi-Z variable reduce DCIR kernel", () => {
  it("builds valid min/max kernels with deterministic emission and stable IR hashes", () => {
    const min = buildHiZVariableReduceKernel(false);
    const max = buildHiZVariableReduceKernel(true);
    expect(min.name).toBe(HI_Z_VARIABLE_REDUCE_NAME);
    expect(validateKernel(min)).toEqual([]);
    expect(validateKernel(max)).toEqual([]);
    const wgslMin = emitKernelWgsl(min);
    const glslMin = emitKernelGlsl(min);
    expect(wgslMin.irSha256).toBe(kernelIrSha256(min));
    expect(glslMin.irSha256).toBe(wgslMin.irSha256);
    expect(wgslMin.code).toBe(emitKernelWgsl(buildHiZVariableReduceKernel(false)).code);
    expect(kernelIrSha256(min)).toBe("ca33d78ba998800c7b2eec6a8812a107d10cbb05d0a6eb8b059e93f04528c94e");
    expect(kernelIrSha256(max)).toBe("f5be302b1b1a810b4499ebd7741773b4f9cd6e5e14bd7410e8693c8423e6312a");
    expect(min.uniforms.map((uniform) => uniform.name)).toEqual(["sourceSize", "targetSize"]);
  });

  it("emits 9-tap masked gather with clamped texel coordinates and guard", () => {
    const { code } = emitKernelWgsl(buildHiZVariableReduceKernel(false));
    expect(code).toContain("fn hi_z_variable_reduce(@builtin(global_invocation_id) deepGlobalId: vec3u)");
    // 进位除与截断除窗口公式。
    expect(code).toContain("let n_xb: u32 = n_xp / n_tw;");
    expect(code).toContain("let n_xe: u32 = n_xq / n_tw;");
    // 9 次定序取数全部 clamp 入界（texel-load 界内合同），tap(1,0) 取数坐标为 (cx1, cy0)。
    expect((code.match(/textureLoad\(deepSource/g) ?? []).length).toBe(9);
    expect(code).toContain("let n_co_cx1_cy0: vec2u = vec2u(n_cx1, n_cy0);");
    expect(code).toContain("let n_a10: f32 = select(n_r00, n_s_cx1_cy0, n_w10);");
    expect(code).toContain("select(n_xm1, n_bx2, n_vx2)");
    expect(code).toContain("if (!(n_inside)) { return; }");
  });

  it("emits GLSL fragment lowering with the same two-uvec2 uniform shape as the certified kernel", () => {
    const { fragment, vertex } = emitKernelGlsl(buildHiZVariableReduceKernel(true));
    expect(fragment).toContain("uniform uvec2 deep_u_sourceSize;");
    expect(fragment).toContain("uniform uvec2 deep_u_targetSize;");
    expect((fragment.match(/texelFetch\(deepSource/g) ?? []).length).toBe(9);
    expect(fragment).toContain("float n_r22 = max(n_r12, n_a22);");
    expect(fragment).toContain("if (!(n_inside)) { discard; }");
    expect(vertex).toContain("gl_VertexID");
  });

  it("reference matches the golden variable-window formula including overlapping odd windows and -0 folding", () => {
    // 37→19 首档：tx=18 的窗口为 [36, 37) 1 列；19→9：末格窗口 [36,37)+clamp 覆盖，与黄金公式一致。
    const input = generateHiZInput(0x5eed_0002, 37, 23);
    const reference = referenceHiZVariableReduce(input, 37, 23, 19, 12, false);
    const brute = bruteForceGoldenReduce(input, 37, 23, 19, 12, false);
    expect([...reference]).toEqual([...brute]);
    // ±0：种子 -0 与 +0 并列取 min → 手写路径可能保留 -0，参考实现按合同折叠为 +0。
    const zeros = new Float32Array([-0, 0]);
    expect(Object.is(referenceHiZVariableReduce(zeros, 2, 1, 1, 1, false)[0]!, -0)).toBe(false);
    expect(referenceHiZVariableReduce(zeros, 2, 1, 1, 1, false)[0]).toBe(0);
  });

  it("reproduces the certified first-stage reference for even sources (fast-path equivalence)", () => {
    for (const [width, height] of [[64, 64], [32, 16], [8, 8], [2, 2]] as const) {
      const input = generateHiZInput(0xa11ce, width, height);
      const anchored = referenceHiZFirstStage(input, width, height, true);
      const variable = referenceHiZVariableReduce(input, width, height, width / 2, height / 2, true);
      expect([...variable]).toEqual([...anchored]);
    }
  });

  it("computes floor-chain level sizes and full-chain reference with per-level dimensions", () => {
    expect(hiZChainLevelCount(13, 7)).toBe(4);
    expect([0, 1, 2, 3].map((level) => hiZChainLevelSize(13, level))).toEqual([13, 6, 3, 1]);
    expect([0, 1, 2, 3].map((level) => hiZChainLevelSize(7, level))).toEqual([7, 3, 1, 1]);
    expect(hiZChainLevelSize(1, 3)).toBe(1);
    const input = generateHiZInput(0xbeef, 16, 16);
    const chain = referenceHiZChain(input, 16, 16, 5, true);
    expect(chain).toHaveLength(5);
    expect([...chain[1]!]).toEqual([...referenceHiZVariableReduce(input, 16, 16, 8, 8, true)]);
    expect(chain[4]![0]).toBe(Math.max(...input));
    expect(() => referenceHiZChain(input, 16, 16, 6, true)).toThrow("complete chain");
  });

  it("routes even-even sources to the certified anchored fast path and odd sources to the variable kernel", () => {
    expect(usesAnchoredReduce(64, 64)).toBe(true);
    expect(usesAnchoredReduce(48, 16)).toBe(true);
    expect(usesAnchoredReduce(37, 23)).toBe(false);
    expect(usesAnchoredReduce(48, 37)).toBe(false);
    expect(usesAnchoredReduce(2, 1)).toBe(false);
  });
});

/** 黄金公式直译（独立实现，防参考实现自我循环）：u32 语义的变窗定序 gather。 */
function bruteForceGoldenReduce(input: Float32Array, sourceWidth: number, sourceHeight: number,
  targetWidth: number, targetHeight: number, reduceMax: boolean): Float32Array {
  const trunc = (numerator: number, divisor: number): number => Math.floor(numerator / divisor);
  const output = new Float32Array(targetWidth * targetHeight);
  for (let ty = 0; ty < targetHeight; ty++) {
    for (let tx = 0; tx < targetWidth; tx++) {
      const beginX = trunc(tx * sourceWidth, targetWidth);
      const endX = trunc((tx + 1) * sourceWidth + targetWidth - 1, targetWidth);
      const beginY = trunc(ty * sourceHeight, targetHeight);
      const endY = trunc((ty + 1) * sourceHeight + targetHeight - 1, targetHeight);
      let value = input[beginY * sourceWidth + beginX]!;
      for (let y = beginY; y < endY; y++) {
        for (let x = beginX; x < endX; x++) {
          const sample = input[y * sourceWidth + x]!;
          value = reduceMax ? Math.max(value, sample) : Math.min(value, sample);
        }
      }
      output[ty * targetWidth + tx] = value === 0 ? 0 : value;
    }
  }
  return output;
}
