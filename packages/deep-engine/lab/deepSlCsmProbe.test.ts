import { describe, expect, it } from "vitest";
import { DEEP_PBR_MESH_V2_SHA256 } from "@bim-studio/deep-engine/shader-abi";
import { resolveShaderPackagePipeline } from "../src/shaderPackage/pipeline.js";
import { adaptDeepSlCsmProbe, CSM_PROBE_POINTS, CSM_PROBE_STATES, csmProbeUniform, evaluateCsmProbe,
  type CsmProbeCase } from "./deepSlCsmProbeFixture.js";
import { readPbrProbeReadback, validateCsmProbe, type DeepSlPbrGpuSample } from "./deepSlPbrGpuDrawSupport.js";
import { PBR_PROBE_CLEAR } from "./deepSlPbrProbeFixture.js";

function cases(): CsmProbeCase[] {
  const samples = [
    [[0.8, 0.3, 0.2, 1], [0.8, 0.3, 0.2, 1]],
    [[0.1, 0.03, 0.02, 1], [0.8, 0.3, 0.2, 1]],
    [[0.8, 0.3, 0.2, 1], [0.1, 0.03, 0.02, 1]],
  ];
  return CSM_PROBE_STATES.map((state, index) => ({ id: state.id, sample: {
    pixel: samples[index]![0]!, raw16: [], samplePixels: samples[index]!, shadowDepth: 0.50001,
    frameBytes: 208, geometryStride: 40, instanceStride: 144, shadowDraws: 1, forwardDraws: 1,
    resolveUsed: true, colorFormat: "rgba16float", sampleCount: 4,
    forwardDepthFormat: "depth24plus", shadowDepthFormat: "depth32float",
  } }));
}

describe("DeepSL CSM GPU probe evidence", () => {
  it.each([false, true])("reads center and optional CSM samples with a single mapped range: %s", withSamples => {
    const data = new ArrayBuffer(4096);
    const view = new DataView(data);
    const write = (x: number, channels: number[]) => channels.forEach((bits, channel) =>
      view.setUint16(8 * 256 + x * 8 + channel * 2, bits, true));
    write(8, [0x3800, 0x3c00, 0x4000, 0x3c00]);
    write(4, [0x3400, 0x3800, 0x3c00, 0x3c00]);
    write(12, [0x4000, 0x4200, 0x4400, 0x3c00]);
    let mappings = 0;
    const sample = readPbrProbeReadback({ getMappedRange: () => {
      if (++mappings > 1) throw new Error("Overlapping mapped range");
      return data;
    } }, withSamples ? CSM_PROBE_POINTS : undefined);
    expect(mappings).toBe(1);
    expect(sample.raw16).toEqual([0x3800, 0x3c00, 0x4000, 0x3c00]);
    expect(sample.pixel).toEqual([0.5, 1, 2, 1]);
    expect(sample.samplePixels).toEqual(withSamples ? [[0.25, 0.5, 1, 1], [2, 3, 4, 1]] : undefined);
    new Uint8Array(data).fill(0);
    expect(sample.pixel).toEqual([0.5, 1, 2, 1]);
  });

  it("uses the production explicit v2 adapter with CSM forward and fixed shadow passes", () => {
    const adapted = adaptDeepSlCsmProbe({ features: [], limits: {
      maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16,
    } });
    if (!adapted.success) throw new Error(JSON.stringify(adapted.report));
    expect(adapted.package.shaderAbi.id).toBe("deep.pbr.mesh.v2");
    expect(adapted.package.shaderAbi.contentHash.value).toBe(DEEP_PBR_MESH_V2_SHA256);
    for (const pass of adapted.package.passes) {
      const plan = resolveShaderPackagePipeline(adapted.package.shaderAbi.contract, pass.pipeline)!;
      expect(plan.bindGroupLayouts[0]!.bindings.length).toBe(pass.kind === "forward" ? 8 : 1);
    }
    const source = adapted.package.modules.map(module => module.source).join("\n");
    expect(source).toContain("texture_depth_2d_array");
    expect(source).toContain("fn deepSampleCascade(");
    expect(source).toContain("@group(0) @binding(7)");
  });

  it("keeps both pixels outside blend bands and writes the actual shadow to a separate fourth layer", () => {
    const uniform = csmProbeUniform();
    expect(uniform.byteLength).toBe(336);
    expect(Array.from(uniform.slice(76, 84))).toEqual([4, Math.fround(0.001), 1 / 16, 0, 1, 0, 0, 0]);
    const depths = CSM_PROBE_POINTS.map(([x]) => (x + 0.5) / 16 * 2 - 1);
    expect(depths[0]).toBeLessThan(uniform[68]!);
    expect(depths[1]).toBeGreaterThan(uniform[64]!);
    expect(depths[1]).toBeLessThan(uniform[69]!);
    expect(CSM_PROBE_STATES.map(state => state.depths[3])).toEqual([1, 1, 1]);
    expect(evaluateCsmProbe(cases())).toMatchObject({ verified: true, isolatedCascade0: true,
      isolatedCascade1: true, shadowExecuted: true });
  });

  it.each(["shared-layer", "ignored-csm", "clear-only", "shadow-not-drawn", "nan", "missing-case"])(
    "rejects misleading %s evidence", failure => {
      const samples = cases();
      const replace = (index: number, fields: Partial<DeepSlPbrGpuSample>) => {
        samples[index] = { ...samples[index]!, sample: { ...samples[index]!.sample, ...fields } };
      };
      if (failure === "shared-layer") replace(1, { samplePixels: [[0.1, 0.03, 0.02, 1], [0.1, 0.03, 0.02, 1]] });
      if (failure === "ignored-csm") replace(1, { samplePixels: samples[0]!.sample.samplePixels! });
      if (failure === "clear-only") replace(0, { samplePixels: [PBR_PROBE_CLEAR, PBR_PROBE_CLEAR] });
      if (failure === "shadow-not-drawn") replace(2, { shadowDepth: 1 });
      if (failure === "nan") replace(1, { samplePixels: [[Number.NaN, 0, 0, 1], [0.8, 0.3, 0.2, 1]] });
      if (failure === "missing-case") samples.pop();
      expect(evaluateCsmProbe(samples).verified).toBe(false);
    },
  );

  it("rejects malformed GPU input and out-of-target pixel reads before resource creation", () => {
    const valid = { uniform: csmProbeUniform(), clearDepths: [1, 1, 1, 1] as const, shadowLayer: 3 };
    expect(() => validateCsmProbe({ cascadedShadow: valid, samplePoints: CSM_PROBE_POINTS })).not.toThrow();
    for (const csm of [{ ...valid, uniform: new Float32Array(80) }, { ...valid, shadowLayer: 4 },
      { ...valid, clearDepths: [Number.NaN, 1, 1, 1] as const }]) {
      expect(() => validateCsmProbe({ cascadedShadow: csm })).toThrow(/CSM/);
    }
    expect(() => validateCsmProbe({ samplePoints: [[16, 8]] })).toThrow(/outside/);
  });
});
