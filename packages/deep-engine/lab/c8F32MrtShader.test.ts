import { expect, it } from "vitest";
import { sceneShader } from "../src/webgpu/pbrShader.js";
import { observeDeepF32Mrt, f32WitnessPipeline, F32_WITNESS_ENTRY } from "./c8F32MrtShader.js";

it.each(["single", "multi", "full"] as const)("preserves original color fragment and bindings while recording actual %s", mode => {
  const result = observeDeepF32Mrt(mode), original = sceneShader.match(/@fragment fn fragmentMainColor\([^]*?\n\}/)![0];
  expect(result.code).toContain(original);
  expect(result.code.match(/@group\([^]*?@binding\(/g)).toEqual(sceneShader.match(/@group\([^]*?@binding\(/g));
  expect(result.code).toContain(`@fragment fn ${F32_WITNESS_ENTRY}`);
  expect(result.code).toContain("out.color = vec4f(color, coverage(v.emissiveAlpha.w, v.material));");
  expect(result.code).toContain("out.witness = vec4f(deepC8F32Witness, out.color.a);");
  expect(result.code).not.toContain("deepC8Multi = color -");
  expect(result.code).toContain(mode === "single" ? "deepC8F32Witness = color;" : mode === "multi" ? "color += deepC8Multi;\n  deepC8F32Witness = deepC8Multi;" : "deepC8F32Witness = deepC8Full;\n  return deepC8Full;");
});
it("rejects source drift and unknown modes before instrumentation", () => {
  expect(() => observeDeepF32Mrt("single", sceneShader + "\n")).toThrow("drifted");
  expect(() => observeDeepF32Mrt("bogus" as "single")).toThrow("Unknown");
});
export function canonicalWitnessPipeline(module: GPUShaderModule): GPURenderPipelineDescriptor {
  return { label: "Deep forward PBR plain/depth/ccw", layout: "auto", vertex: { module, entryPoint: "vertexMain" },
    fragment: { module, entryPoint: "fragmentMainColor", targets: [{ format: "rgba16float" }] },
    primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" }, depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" }, multisample: { count: 1 } };
}
it("allows one F32 attachment and rejects noncanonical variants", () => {
  const module = {} as GPUShaderModule, modules = new WeakSet([module]), descriptor = canonicalWitnessPipeline(module);
  const result = f32WitnessPipeline(descriptor, modules);
  expect(Array.from(result.fragment!.targets)).toEqual([{ format: "rgba16float" }, { format: "rgba32float" }]);
  expect(Array.from(descriptor.fragment!.targets)).toHaveLength(1);
  for (const invalid of [
    { ...descriptor, multisample: { count: 4 } }, { ...descriptor, primitive: { ...descriptor.primitive, frontFace: "cw" as const } },
    { ...descriptor, vertex: { ...descriptor.vertex, entryPoint: "vertexDeformed" } },
    { ...descriptor, fragment: { ...descriptor.fragment!, targets: [{ format: "rgba32float" as const }] } },
    { ...descriptor, depthStencil: { ...descriptor.depthStencil!, depthWriteEnabled: false } },
    { ...descriptor, fragment: { ...descriptor.fragment!, module: {} as GPUShaderModule } },
  ]) expect(() => f32WitnessPipeline(invalid, modules)).toThrow("canonical");
  expect(() => f32WitnessPipeline(descriptor, new WeakSet())).toThrow("canonical");
});
