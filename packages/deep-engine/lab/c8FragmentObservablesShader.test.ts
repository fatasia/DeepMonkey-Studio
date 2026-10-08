import { ShaderChunk } from "three";
import { expect, it } from "vitest";
import { sceneShader } from "../src/webgpu/pbrShader.js";
import { observeDeepFragment, observeThreeFragment } from "./c8FragmentObservablesShader.js";
import { prepareFragmentObservation } from "./c8FragmentObservablesProbe.js";

it("observes the original production single response before direct MS, without replacing BRDF math", () => {
  const deep = observeDeepFragment("single"), three = observeThreeFragment("single", ShaderChunk);
  expect(deep.originalHash).not.toBe(deep.instrumentedHash);
  expect(deep.code).toContain("let deepObservedSingle = color;");
  expect(deep.code.indexOf("let deepObservedSingle = color;")).toBeLessThan(deep.code.indexOf("color += deepDirectMultiscatteringFromView"));
  expect(deep.code).toContain("return deepObservedSingle;");
  expect(deep.code).toContain("deepViewGeometryRoughness(geometryNormal)");
  expect(three.lights_physical_pars_fragment).toContain("irradiance * ( specularBRDF + BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F ) )");
  expect(three.lights_physical_pars_fragment).toContain("reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;");
  expect(three.opaque_fragment).toContain("vec4( deepObservedFragment, diffuseColor.a )");
  expect(three.originalHash).not.toBe(three.instrumentedHash);
});
it("keeps actual geometry/material preparation before reading effective roughness", () => {
  expect(observeDeepFragment("geometry").code).toContain("return vec3f(clamp(dot(n, view), 0.0001, 1.0), clamp(dot(n, l), 0.0, 1.0), rough);");
  expect(observeThreeFragment("geometry", ShaderChunk).lights_physical_pars_fragment).toContain("material.roughness");
});
it("keeps current direct DFG and IBL separation intact in every observation mode", () => {
  for (const mode of ["geometry", "single", "rough-single", "view-normal", "abs-dx", "abs-dy"] as const) {
    const observed = observeDeepFragment(mode);
    expect(observed.code.includes("directDfg = deepDirectDfg185(rough, nv);")).toBe(true);
    expect(observed.code.includes("deepSeedDirectViewDfg(directDfg);")).toBe(true);
    expect(observed.code.includes("color += deepDirectMultiscatteringFromView(n, l, base, metal, rough, dielectric, directDfg)")).toBe(true);
    expect(observed.code.includes("dfg = textureSampleLevel(brdfLut, environmentSampler")).toBe(true);
  }
});
it("rejects unknown mode, stale input, duplicate output and Three source drift", () => {
  expect(() => observeDeepFragment("bad" as never)).toThrow("Unknown");
  const stale = sceneShader.replace("let n = normalInput;", "let n = safeNormalize(normalInput, vec3f(0.0, 1.0, 0.0));");
  expect(stale).not.toBe(sceneShader);
  expect(() => observeDeepFragment("single", stale)).toThrow("drifted");
  expect(() => observeDeepFragment("single", observeDeepFragment("geometry").code)).toThrow("instrumented");
  expect(() => observeThreeFragment("geometry", observeThreeFragment("single", ShaderChunk))).toThrow("instrumented");
  expect(() => observeThreeFragment("single", { ...ShaderChunk, opaque_fragment: `${ShaderChunk.opaque_fragment}\n` })).toThrow("drifted");
  expect(() => observeThreeFragment("single", { ...ShaderChunk, lights_physical_pars_fragment: ShaderChunk.lights_physical_pars_fragment.replace("irradiance * specularBRDF", "2.0 * irradiance * specularBRDF") })).toThrow("drifted");
});
it("rejects empty receipts and unobserved compiled GL sources, restoring original chunks on failure", async () => {
  const chunks = { ...ShaderChunk }, original = { ...chunks };
  const leaf = prepareFragmentObservation("single", { requestAdapter: async () => null } as unknown as GPU, chunks);
  try {
    await leaf.gpu.requestAdapter();
    expect(chunks.opaque_fragment).not.toBe(original.opaque_fragment);
    expect(() => leaf.receipt()).toThrow("Empty");
    expect(() => leaf.recordThreeFragments(["ordinary shader"])).toThrow("not compiled");
    const stale = observeThreeFragment("geometry", original);
    expect(() => leaf.recordThreeFragments([stale.lights_physical_pars_fragment + stale.opaque_fragment])).toThrow("not compiled");
  } finally { leaf.dispose(); }
  expect(chunks).toEqual(original);
  await expect(leaf.gpu.requestAdapter()).rejects.toThrow("disposed");
});
it("keeps the actual device object and scopes shader interception to production identity", async () => {
  const chunks = { ...ShaderChunk }, submitted: GPUShaderModuleDescriptor[] = [];
  const native = (descriptor: GPUShaderModuleDescriptor) => { submitted.push(descriptor); return {} as GPUShaderModule; };
  const device = { createShaderModule: native } as unknown as GPUDevice;
  const adapter = { requestDevice: async () => device } as unknown as GPUAdapter;
  const leaf = prepareFragmentObservation("geometry", { requestAdapter: async () => adapter } as unknown as GPU, chunks);
  try {
    const delivered = await (await leaf.gpu.requestAdapter())!.requestDevice();
    expect(delivered).toBe(device);
    device.createShaderModule({ label: "environment", code: "untouched" });
    expect(submitted[0]!.code).toBe("untouched");
    expect(() => device.createShaderModule({ label: "Deep PBR", code: `${sceneShader}\n` })).toThrow("differs");
    device.createShaderModule({ label: "Deep PBR", code: sceneShader });
    expect(submitted[1]!.code).toBe(observeDeepFragment("geometry").code);
    leaf.recordThreeFragments([`${chunks.lights_physical_pars_fragment}\n${chunks.opaque_fragment}`]);
    expect(leaf.receipt().deep.moduleCount).toBe(1);
  } finally { leaf.dispose(); }
  expect(device.createShaderModule).toBe(native);
});
it("retires a device delivered after disposal or unable to install the isolated observation", async () => {
  for (const nonExtensible of [false, true]) {
    let resolveDevice!: (device: GPUDevice) => void, retired = 0;
    const device = { createShaderModule: () => ({}), destroy: () => { retired++; } } as unknown as GPUDevice;
    if (nonExtensible) Object.freeze(device);
    const adapter = { requestDevice: () => new Promise<GPUDevice>(resolve => { resolveDevice = resolve; }) } as unknown as GPUAdapter;
    const chunks = { ...ShaderChunk }, original = { ...chunks };
    const leaf = prepareFragmentObservation("single", { requestAdapter: async () => adapter } as unknown as GPU, chunks);
    const pending = (await leaf.gpu.requestAdapter())!.requestDevice();
    if (!nonExtensible) leaf.dispose();
    resolveDevice(device);
    await expect(pending).rejects.toThrow(); leaf.dispose();
    expect(retired).toBe(1); expect(chunks).toEqual(original);
  }
});
