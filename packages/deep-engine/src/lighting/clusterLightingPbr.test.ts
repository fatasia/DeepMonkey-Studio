import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { sceneShader } from "../webgpu/pbrShader.js";
import { assignLightsToClusters } from "./clusterGrid.js";
import { ForwardPlusClusterAssigner } from "./clusterCompute.js";
import { composeForwardPlusPbrShader, FORWARD_PLUS_PBR_WGSL } from "./clusterLightingPbrWgsl.js";
import { ForwardPlusPbrLightingBindings } from "./pbrLightingBindings.js";
import { evaluateForwardPlusPbrCpu, type ForwardPlusPbrSurface } from "./pbrLightingCpu.js";

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
    createBindGroup: vi.fn(({ entries }: GPUBindGroupDescriptor) => ({ entries })),
  };
  const owned = new Set<GPUBuffer>(), session = { state: "ready", device,
    own<T extends GPUBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: GPUBuffer): void { if (owned.delete(resource)) resource.destroy(); } };
  return { device, session: session as unknown as DeviceSession, rawSession: session, buffers, owned };
}

beforeEach(() => { vi.stubGlobal("GPUShaderStage", { COMPUTE: 1, FRAGMENT: 2 }); vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4 }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Forward+ clustered PBR lighting", () => {
  it("composes the fixed lighting ABI ahead of a renderer shader", () => {
    const source = composeForwardPlusPbrShader("@compute @workgroup_size(1) fn rendererEntry() {}");
    expect(source.indexOf("deepClusterParams")).toBeLessThan(source.indexOf("rendererEntry"));
    expect(() => composeForwardPlusPbrShader("   ")).toThrow("must not be empty");
  });

  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("validates the composable group-3 library with Naga", () => {
    const code = `${FORWARD_PLUS_PBR_WGSL}\n@fragment fn main(@builtin(position) p: vec4f) -> @location(0) vec4f {
      return vec4f(deepForwardPlusPbr(p.xy, vec3f(0.0, 0.0, -4.0), vec3f(0.0, 0.0, 1.0), vec3f(1.0), 0.0, 0.5), 1.0); }`;
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
});
