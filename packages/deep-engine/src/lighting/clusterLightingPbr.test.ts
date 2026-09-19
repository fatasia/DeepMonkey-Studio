import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { sceneShader } from "../webgpu/pbrShader.js";
import { assignLightsToClusters } from "./clusterGrid.js";
import { ForwardPlusClusterAssigner } from "./clusterCompute.js";
import { composeForwardPlusPbrShader, FORWARD_PLUS_PBR_WGSL } from "./clusterLightingPbrWgsl.js";
import { ForwardPlusPbrLightingBindings } from "./pbrLightingBindings.js";
import { evaluateForwardPlusPbrCpu, type ForwardPlusPbrSurface } from "./pbrLightingCpu.js";
import { evaluateIesShadingFactor, packIesShading } from "./iesShading.js";
import { packClusteredLights } from "./clusterPacking.js";
import { parseIesProfile } from "./iesProfile.js";
import { quantizeIesLightProfile } from "../runtimePackage/lightProfiles.js";

const grid = { viewportWidth: 2, viewportHeight: 1, tileSizeX: 1, tileSizeY: 1,
  zSlices: 4, near: 1, far: 16, verticalFovRadians: Math.PI / 2, maxLightsPerCluster: 8 } as const;
const surface = (positionView: readonly [number, number, number] = [0, 0, -4]): ForwardPlusPbrSurface => ({
  fragmentCoordinate: [0.5, 0.5], positionView, normalView: [0, 0, 1], baseColor: [0.8, 0.7, 0.6], metallic: 0.2, roughness: 0.45,
});
const point = (color: readonly [number, number, number] = [1, 1, 1], range = 4) =>
  ({ positionView: [0, 0, -2] as const, range, color, intensity: 2 });

function fixture() {
  const buffers: Array<GPUBuffer & { destroy: ReturnType<typeof vi.fn> }> = [];
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024, maxComputeWorkgroupsPerDimension: 65_535 },
    queue: { writeBuffer: vi.fn() }, createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})), createComputePipeline: vi.fn(() => ({})),
    createBuffer: vi.fn(({ label, size, usage }: GPUBufferDescriptor) => { const value = { label, size, usage, destroy: vi.fn() } as unknown as GPUBuffer & { destroy: ReturnType<typeof vi.fn> }; buffers.push(value); return value; }),
    createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn() })),
    createSampler: vi.fn(() => ({})),
    createBindGroup: vi.fn(({ entries }: GPUBindGroupDescriptor) => ({ entries })),
  };
  const owned = new Set<GPUBuffer>(), session = { state: "ready", device,
    own<T extends GPUBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: GPUBuffer): void { if (owned.delete(resource)) resource.destroy(); } };
  return { device, session: session as unknown as DeviceSession, rawSession: session, buffers, owned };
}

beforeEach(() => { vi.stubGlobal("GPUShaderStage", { COMPUTE: 1, FRAGMENT: 2 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, UNIFORM: 8 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1 }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Forward+ clustered PBR lighting", () => {
  it("bypasses spot atlas sampling for non-receivers and preserves legacy entry points", () => {
    expect(FORWARD_PLUS_PBR_WGSL).toContain("if (receiveShadow) { visibility = deepLocalSpotShadow(spotIndex, worldPosition); }");
    expect(FORWARD_PLUS_PBR_WGSL).toContain("worldPosition, baseColor, metallic, roughness, normal, view, receiveShadow");
    expect(FORWARD_PLUS_PBR_WGSL).toContain("worldToView, baseColor, metallic, roughness, true");
    expect(FORWARD_PLUS_PBR_WGSL).toContain("fn deepForwardPlusPbrWorldReceiving(");
    expect(FORWARD_PLUS_PBR_WGSL).toContain("worldPosition, baseInput, metallicInput, roughnessInput, true");
  });
  it("composes the fixed lighting ABI ahead of a renderer shader", () => {
    const source = composeForwardPlusPbrShader("@compute @workgroup_size(1) fn rendererEntry() {}");
    expect(source.indexOf("deepClusterParams")).toBeLessThan(source.indexOf("rendererEntry"));
    expect(() => composeForwardPlusPbrShader("   ")).toThrow("must not be empty");
  });

  it("uses the same texture-free correlated GGX direct-light model as the primary sun", () => {
    expect(FORWARD_PLUS_PBR_WGSL).toContain("let visibility = 0.5 / max(gv + gl, 0.000001)");
    expect(FORWARD_PLUS_PBR_WGSL).toContain("let diffuse = (1.0 - metallic) * baseColor / DEEP_CLUSTER_PI");
    expect(FORWARD_PLUS_PBR_WGSL.match(/textureSampleCompareLevel/g)).toHaveLength(1);
  });

  it("samples the guarded shared atlas only for its allocated spot index", () => {
    expect(FORWARD_PLUS_PBR_WGSL).toContain("@group(3) @binding(6) var<uniform> deepLocalSpotShadowData");
    expect(FORWARD_PLUS_PBR_WGSL).toContain("@group(3) @binding(7) var deepLocalShadowAtlas: texture_depth_2d");
    expect(FORWARD_PLUS_PBR_WGSL).toContain("deepLocalSpotShadowData.entries[entryIndex]");
    expect(FORWARD_PLUS_PBR_WGSL).toContain("u32(entry.params.x) == spotIndex");
    expect(FORWARD_PLUS_PBR_WGSL).toContain("array<vec2f, 4>(");
    expect(FORWARD_PLUS_PBR_WGSL).toContain("atlasUv + offsets[sampleIndex] * texel");
    expect(FORWARD_PLUS_PBR_WGSL).toContain("attenuation * visibility");
  });

  it("injects the IES factor into the spot attenuation path with an identity sentinel", () => {
    expect(FORWARD_PLUS_PBR_WGSL).toContain("@group(3) @binding(12) var<storage, read> deepIesShading: array<vec4<f32>>");
    expect(FORWARD_PLUS_PBR_WGSL).toContain("attenuation = attenuation * deepSpotIesFactor(spotIndex, surfaceToLight, light.directionOuterCos.xyz)");
    expect(FORWARD_PLUS_PBR_WGSL).toContain("if (params.x < 0.0) { return 1.0; }");
  });

  it("modulates IES spot radiance by the packed factor and keeps non-IES radiance untouched", () => {
    const quad = quantizeIesLightProfile("syn.quad-0-90",
      parseIesProfile(readFileSync(new URL("../../fixtures/ies/e02-quad-0-90.ies", import.meta.url), "utf8")));
    const spotLight = { positionView: [0, 0, -2] as const, range: 5, color: [1, 0.5, 0.25] as const, intensity: 2,
      directionView: [0, 0, -1] as const, innerConeCos: Math.cos(0.9), outerConeCos: Math.cos(1.2) };
    const positionView = [1, 1, -4] as const;
    const probe: ForwardPlusPbrSurface = { ...surface(positionView), normalView: [0, 0, 1] };
    const plain = { spots: [spotLight] };
    const plainColor = evaluateForwardPlusPbrCpu(assignLightsToClusters(grid, plain), plain, probe).color;
    const withIes = { spots: [{ ...spotLight, ies: { profileId: "syn.quad-0-90" } }], lightProfiles: [quad] };
    const iesColor = evaluateForwardPlusPbrCpu(assignLightsToClusters(grid, withIes), withIes, probe).color;
    const packed = packClusteredLights(withIes);
    const packing = packIesShading(withIes.spots, withIes.lightProfiles);
    const dx = 0 - positionView[0], dy = 0 - positionView[1], dz = 0 - positionView[2];
    const length = Math.hypot(dx, dy, dz);
    const factor = evaluateIesShadingFactor(packing, 0,
      [packed.spots[4]!, packed.spots[5]!, packed.spots[6]!], [dx / length, dy / length, dz / length]);
    expect(factor).toBeGreaterThan(0);
    expect(factor).toBeLessThan(1);
    iesColor.forEach((value, index) => expect(value).toBeCloseTo(plainColor[index]! * factor, 12));
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("validates the composable group-3 library with Naga", () => {
    const code = `${FORWARD_PLUS_PBR_WGSL}\n@fragment fn main(@builtin(position) p: vec4f) -> @location(0) vec4f {
      return vec4f(deepForwardPlusPbr(p.xy, vec3f(0.0, 0.0, -4.0), vec3f(0.0, 0.0, 1.0),
        vec3f(0.0), vec3f(1.0), 0.0, 0.5), 1.0); }`;
    const validation = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!, ["--stdin-file-path", "deep-forward-plus-pbr.wgsl", "--input-kind", "wgsl"], { input: code, encoding: "utf8" });
    expect(validation.status, validation.stderr).toBe(0); expect(validation.stderr).toBe(""); expect(validation.stdout).toContain("Validation successful");
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("validates the composed default PBR shader", () => {
    const validation = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!, ["--stdin-file-path", "deep-forward-plus-default-pbr.wgsl", "--input-kind", "wgsl"],
      { input: sceneShader, encoding: "utf8" });
    expect(validation.status, validation.stderr).toBe(0); expect(validation.stderr).toBe("");
    expect(validation.stdout).toContain("Validation successful");
  });

  it("matches physical range cutoff, spot cone, additive accumulation, and bounded overflow on the CPU reference", () => {
    const lit = { points: [point()] }, litResult = evaluateForwardPlusPbrCpu(assignLightsToClusters(grid, lit), lit, surface());
    const outside = { points: [point([1, 1, 1], 1)] };
    expect(litResult.color.every(value => value > 0 && Number.isFinite(value))).toBe(true);
    expect(evaluateForwardPlusPbrCpu(assignLightsToClusters(grid, outside), outside, surface()).color).toEqual([0, 0, 0]);

    const spot = { spots: [{ ...point([1, 0.5, 0.25], 5), directionView: [0, 0, -1] as const,
      outerConeCos: Math.cos(Math.PI / 6), innerConeCos: Math.cos(Math.PI / 12) }] };
    const insideCone = evaluateForwardPlusPbrCpu(assignLightsToClusters(grid, spot), spot, surface()).color;
    const outsideCone = evaluateForwardPlusPbrCpu(assignLightsToClusters(grid, spot), spot, surface([2, 0, -4])).color;
    expect(insideCone[0]).toBeGreaterThan(0); expect(outsideCone).toEqual([0, 0, 0]);

    const doubled = { points: [point(), point()] };
    const doubledColor = evaluateForwardPlusPbrCpu(assignLightsToClusters(grid, doubled), doubled, surface()).color;
    doubledColor.forEach((value, index) => expect(value).toBeCloseTo(litResult.color[index]! * 2, 12));
    const boundedGrid = { ...grid, maxLightsPerCluster: 1 }, bounded = evaluateForwardPlusPbrCpu(assignLightsToClusters(boundedGrid, doubled), doubled, surface());
    bounded.color.forEach((value, index) => expect(value).toBeCloseTo(litResult.color[index]!, 12));
    expect(bounded.referencedLocalLightCount).toBe(1);
  });

  it("returns finite black for no lights and distinguishes left/right point radiance", () => {
    expect(evaluateForwardPlusPbrCpu(assignLightsToClusters(grid, {}), {}, surface()).color).toEqual([0, 0, 0]);
    const lights = { points: [
      { positionView: [-1, 0, -2] as const, range: 2.2, color: [1, 0, 0] as const, intensity: 2 },
      { positionView: [1, 0, -2] as const, range: 2.2, color: [0, 1, 0] as const, intensity: 2 },
    ] };
    const assignment = assignLightsToClusters(grid, lights);
    const left = evaluateForwardPlusPbrCpu(assignment, lights, { ...surface([-1, 0, -4]), fragmentCoordinate: [0.5, 0.5] }).color;
    const right = evaluateForwardPlusPbrCpu(assignment, lights, { ...surface([1, 0, -4]), fragmentCoordinate: [1.5, 0.5] }).color;
    expect(left[0]).toBeGreaterThan(left[1] * 10); expect(right[1]).toBeGreaterThan(right[0] * 10);
  });

  it("reuses group-3 bindings while buffers stay stable and rebuilds after growth", () => {
    const f = fixture(), assigner = new ForwardPlusClusterAssigner(f.session), bindings = new ForwardPlusPbrLightingBindings(f.session);
    const firstResources = assigner.prepare(grid, { points: [point()] }), first = bindings.bind(firstResources);
    const second = bindings.bind(assigner.prepare(grid, { points: [point([1, 0, 0])] }));
    expect(first.group).toBe(3); expect(second.bindGroup).toBe(first.bindGroup);
    const grown = bindings.bind(assigner.prepare(grid, { points: [point(), point(), point()] }));
    expect(grown.bindGroup).not.toBe(first.bindGroup); expect(f.device.createBindGroup).toHaveBeenCalledTimes(4);
    f.rawSession.state = "lost"; expect(() => bindings.bind(firstResources)).toThrow("lost GPU session");
    bindings.dispose(); assigner.dispose(); expect(f.owned.size).toBe(0);
  });

  it("adds the local shadow uniform, depth atlas, and comparison sampler to group 3", () => {
    const f = fixture(), assigner = new ForwardPlusClusterAssigner(f.session);
    const local = { uniform: {} as GPUBuffer, atlasView: {} as GPUTextureView, sampler: {} as GPUSampler };
    const bindings = new ForwardPlusPbrLightingBindings(f.session, local);
    const layout = f.device.createBindGroupLayout.mock.calls.at(-1)?.[0] as GPUBindGroupLayoutDescriptor;
    expect(layout.entries.slice(6)).toEqual([
      { binding: 6, visibility: 2, buffer: { type: "uniform", minBindingSize: 384 } },
      { binding: 7, visibility: 2, texture: { sampleType: "depth", viewDimension: "2d" } },
      { binding: 8, visibility: 2, sampler: { type: "comparison" } },
      { binding: 9, visibility: 2, texture: { sampleType: "float", viewDimension: "2d-array" } },
      { binding: 10, visibility: 2, sampler: { type: "filtering" } },
      { binding: 11, visibility: 2, buffer: { type: "uniform", minBindingSize: 256 } },
      { binding: 12, visibility: 2, buffer: { type: "read-only-storage" } },
    ]);
    const resources = assigner.prepare(grid, { points: [point()] }), result = bindings.bind(resources);
    const entries = (result.bindGroup as unknown as { entries: GPUBindGroupEntry[] }).entries;
    // binding 12 前移到簇缓冲映射尾部（0-5 之后）；6-8 仍是局部阴影三件套。
    expect(entries[6]).toEqual({ binding: 12, resource: { buffer: resources.iesShadingBuffer } });
    expect(entries.slice(7, 10)).toEqual([{ binding: 6, resource: { buffer: local.uniform } },
      { binding: 7, resource: local.atlasView }, { binding: 8, resource: local.sampler }]);
    const probe = { view: {} as GPUTextureView, sampler: {} as GPUSampler, levelMetadataBuffer: {} as GPUBuffer };
    bindings.setProbeClipmap(probe); expect(bindings.hasProbeClipmap).toBe(true);
    const withProbe = bindings.bind(resources).bindGroup as unknown as { entries: GPUBindGroupEntry[] };
    expect(withProbe.entries.slice(10)).toEqual([{ binding: 9, resource: probe.view },
      { binding: 10, resource: probe.sampler }, { binding: 11, resource: { buffer: probe.levelMetadataBuffer } }]);
    bindings.dispose(); assigner.dispose(); expect(f.owned.size).toBe(0);
  });

  it("rolls back standalone all-lit fallback resources when layout creation fails", () => {
    const f = fixture(); f.device.createBindGroupLayout.mockImplementationOnce(() => { throw new Error("layout failed"); });
    expect(() => new ForwardPlusPbrLightingBindings(f.session)).toThrow("layout failed");
    expect(f.owned.size).toBe(0);
  });
});
