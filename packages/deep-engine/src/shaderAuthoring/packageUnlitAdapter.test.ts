import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateDeepShaderPackage } from "../shaderPackage/validation.js";
import { ShaderPackageExecutor } from "../webgpu/shaderPackageExecutor.js";
import { packageRequest } from "./packageAdapter.testFixture.js";
import { adaptDeepSlToShaderPackage } from "./packageAdapterDispatch.js";
import { adaptDeepSlUnlitToShaderPackage } from "./packageUnlitAdapter.js";

const BASE = `shader deep.unlit {
  surface unlit;
  baseColor [0.25, 0.5, 0.75, 0.8];
  alpha opaque;
  doubleSided false;
  baseColorTexture off;
  emissiveTexture off;
  emissiveFactor [0.1, 0.2, 0.3];
  emissiveStrength 2;
}`;

function adapt(source = BASE, targetAbi?: "deep.pbr.mesh.v1" | "deep.pbr.mesh.v2") {
  const result = adaptDeepSlUnlitToShaderPackage({ ...packageRequest(source), ...(targetAbi ? { targetAbi } : {}) });
  if (!result.success) throw new Error(JSON.stringify(result.report));
  return result;
}

function fakeDevice() {
  const descriptors: GPURenderPipelineDescriptor[] = [];
  const device = {
    lost: new Promise<GPUDeviceLostInfo>(() => {}),
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null),
    createShaderModule: vi.fn(() => ({ getCompilationInfo: vi.fn(async () => ({ messages: [] })) })),
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => ({ descriptor })),
    createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => ({ descriptor })),
    createRenderPipelineAsync: vi.fn(async (descriptor: GPURenderPipelineDescriptor) => {
      descriptors.push(descriptor); return { descriptor };
    }),
  };
  return { device: device as unknown as GPUDevice, descriptors };
}

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
  vi.stubGlobal("GPUColorWrite", { ALL: 15 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("DeepSL executable Unlit package adapter", () => {
  it("dispatches Unlit through the generic package entry without changing Standard behavior", () => {
    expect(adaptDeepSlToShaderPackage(packageRequest(BASE))).toMatchObject({
      success: true, report: { adapterProfile: "deep.pbr.mesh.v1/deepsl-unlit-plain.v2" },
    });
    expect(adaptDeepSlToShaderPackage(packageRequest(BASE.replace("surface unlit", "surface standard"))))
      .toMatchObject({ success: true, report: { adapterProfile: "deep.pbr.mesh.v1/deepsl-standard-plain.v2" } });
  });

  it("builds bounded single-sided OPAQUE forward and solid-shadow variants", async () => {
    const result = adapt();
    expect(result.report).toMatchObject({
      adapterProfile: "deep.pbr.mesh.v1/deepsl-unlit-plain.v2",
      materialSource: "instance-stream",
      vertexStreams: ["geometry", "instance"],
      materialDefaults: {
        baseColorMetallic: [0.25, 0.5, 0.75, 0],
        roughnessAlphaCutoffHandednessFlags: [1, 0.5, 1, 0],
        emissiveAlpha: [0.2, 0.4, 0.6, 1],
      },
    });
    expect(result.package.passes.map((pass) => [pass.id, pass.pipeline.passVariantId, pass.pipeline.rasterMode]))
      .toEqual([
        ["webgpu/forwardCcw", "forward-plain", "ccw"], ["webgpu/forwardCw", "forward-plain", "cw"],
        ["webgpu/shadowCcw", "shadow-solid", "ccw"], ["webgpu/shadowCw", "shadow-solid", "cw"],
      ]);
    expect(validateDeepShaderPackage(result.package)).toMatchObject({ valid: true, diagnostics: [] });
    expect(result.package.modules[0]!.source).toContain(`struct DeepUnlitFrame {
  view: mat4x4f,
  light: mat4x4f,
  eye: vec4f,
  background: vec4f,
  floor: vec4f,
  lightDirection: vec4f,
  tuning: vec4f,
};`);
    const fake = fakeDevice();
    const prepared = await new ShaderPackageExecutor(fake.device).prepare(result.package);
    expect(prepared.passes).toHaveLength(4);
    expect(fake.descriptors.filter((entry) => entry.fragment)).toHaveLength(2);
  });

  it("uses the same transformed base alpha for MASK color and shadow", () => {
    const source = BASE
      .replace("alpha opaque", "alpha mask")
      .replace("baseColorTexture off", `baseColorTexture on;
  baseColorTextureTransform texCoord 1 offset [0.25, -0.5] scale [2, 3] rotation 0`)
      .replace("emissiveTexture off", `emissiveTexture on;
  emissiveTextureTransform texCoord 0 offset [0, 0] scale [0.5, 0.25] rotation 0`);
    const result = adapt(source);
    expect(result.report).toMatchObject({
      adapterProfile: "deep.pbr.mesh.v1/deepsl-unlit-textures.v2",
      materialTextureDefaults: {
        enabledSlots: ["baseColor", "emissive"],
        baseColor: { texCoord: 1, uvTransform: [2, 0, 0.25, 0, 3, -0.5] },
        emissive: { texCoord: 0, emissiveStrength: 2 },
      },
    });
    expect(result.package.passes.map((pass) => [pass.pipeline.passVariantId, pass.entryPoints.fragment]))
      .toEqual([
        ["forward-material", "fragmentMaterial"], ["forward-material", "fragmentMaterial"],
        ["shadow-mask-material", "shadowMaskTextured"], ["shadow-mask-material", "shadowMaskTextured"],
      ]);
    const wgsl = result.package.modules[0]!.source;
    expect(wgsl).toContain("let alpha = input.baseColorAlpha.a * baseSample.a;");
    expect(wgsl).toContain("alpha *= textureSample(deepBaseColorMap");
    expect(wgsl).toContain("if (alpha < input.alphaCutoff.y) { discard; }");
    expect(validateDeepShaderPackage(result.package)).toMatchObject({ valid: true, diagnostics: [] });
  });

  it("emits one double-sided BLEND pass and never casts a blended shadow", () => {
    const result = adapt(BASE.replace("alpha opaque", "alpha blend").replace("doubleSided false", "doubleSided true"));
    expect(result.package.passes.map((pass) => [pass.id, pass.kind, pass.pipeline.attachmentProfileId]))
      .toEqual([["webgpu/forwardDouble", "forward", "forward-blend"]]);
    expect(result.report.materialDefaults?.roughnessAlphaCutoffHandednessFlags[3]).toBe(5);
    expect(result.package.modules[0]!.source).toContain("return vec4f(color, alpha);");
    expect(result.package.modules[0]!.source).not.toContain("@vertex fn shadow");
  });

  it.each([
    "metallic 0", "roughness 1", "metallicRoughnessTexture off",
    "normalTexture off", "normalScale 1", "occlusionTexture off", "occlusionStrength 1",
  ])("rejects the inapplicable Unlit declaration %s with a machine-readable issue", declaration => {
    const result = adaptDeepSlUnlitToShaderPackage(packageRequest(BASE.replace("\n}", `\n  ${declaration};\n}`)));
    expect(result).toMatchObject({
      success: false, report: { issues: [{ code: "unsupported-unlit-field", path: `$.source.${declaration.split(" ")[0]}` }] },
    });
  });

  it("supports mesh.v2 without lighting work and fails closed on ABI capacity", () => {
    const result = adapt(BASE, "deep.pbr.mesh.v2");
    expect(result.report).toMatchObject({
      adapterProfile: "deep.pbr.mesh.v2/deepsl-unlit-plain.v2", shaderAbi: "deep.pbr.mesh.v2",
    });
    expect(result.package.modules[0]!.source).not.toContain("deepShadowVisibility");
    const limited = adaptDeepSlUnlitToShaderPackage({ ...packageRequest(BASE), targetAbi: "deep.pbr.mesh.v2",
      capabilities: { features: [], limits: {
        maxBindGroups: 4, maxBindingsPerBindGroup: 7, maxInterStageShaderVariables: 16,
      } } });
    expect(limited).toMatchObject({ success: false, report: {
      shaderAbi: "deep.pbr.mesh.v2", issues: [{ code: "unsupported-capability" }],
    } });
    const interStageLimited = adaptDeepSlUnlitToShaderPackage({
      ...packageRequest(BASE.replace("baseColorTexture off", "baseColorTexture on")),
      capabilities: { features: [], limits: {
        maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 4,
      } },
    });
    expect(interStageLimited).toMatchObject({ success: false, report: { issues: [{
      code: "unsupported-capability", path: "$.capabilities.limits.maxInterStageShaderVariables",
    }] } });
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("validates every executable Unlit module with Naga", () => {
    const sources = [
      BASE,
      BASE.replace("alpha opaque", "alpha mask"),
      BASE.replace("alpha opaque", "alpha blend").replace("doubleSided false", "doubleSided true"),
      BASE.replace("baseColorTexture off", "baseColorTexture on").replace("alpha opaque", "alpha mask"),
      BASE.replace("emissiveTexture off", "emissiveTexture on"),
    ];
    for (const source of sources) {
      const result = adapt(source);
      const validation = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!, [
        "--stdin-file-path", "deep-unlit-package.wgsl", "--input-kind", "wgsl",
      ], { input: result.package.modules[0]!.source, encoding: "utf8", timeout: 20_000 });
      expect({ source, status: validation.status, stderr: validation.stderr, error: validation.error })
        .toEqual({ source, status: 0, stderr: "", error: undefined });
    }
  });
});
