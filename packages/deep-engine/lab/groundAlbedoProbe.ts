/// <reference types="@webgpu/types" />
import type { DeviceSession } from "@bim-studio/deep-engine/webgpu";
import { GROUND_ALBEDO_WGSL } from "../src/webgpu/pbrGroundAlbedo.js";

const BASES = [[0.01, 0.02, 0.03], [0.88, 0.92, 0.96], [1, 1, 1], [-0.5, 1.5, 3],
  [0.006, 0.006, 0.006], [0.92, 0.92, 0.92]] as const;
const GRIDS = [0, 1, 4, -1] as const;
const CASES = [...BASES.flatMap(base => GRIDS.map(grid => ({ base, grid, ground: true }))),
  { base: [-0.5, 1.5, 3] as const, grid: 1, ground: false }];
const EPSILON = 0.000001;

interface GroundAlbedoSample {
  readonly base: readonly number[];
  readonly grid: number;
  readonly ground: boolean;
  readonly actual: readonly number[];
  readonly expected: readonly number[];
}

export interface GroundAlbedoProbeResult {
  readonly action: "ground-albedo";
  readonly success: boolean;
  readonly checks: Readonly<{
    complete: boolean;
    boundedReflectance: boolean;
    darkGridContrast: boolean;
    lightGridContrast: boolean;
    whitePreserved: boolean;
    noGridPreserved: boolean;
    nonGroundPreserved: boolean;
    gridClamped: boolean;
    cpuGpuAgreement: boolean;
    resourcesReleased: boolean;
    gpuHealthy: boolean;
  }>;
  readonly samples: readonly GroundAlbedoSample[];
  readonly deviceError?: string;
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value));
const close = (left: number, right: number): boolean => Math.abs(left - right) <= EPSILON;

/** Exercises the production ground-grid function, including theme-white and invalid authored ranges. */
export async function verifyGroundAlbedo(session: DeviceSession): Promise<GroundAlbedoProbeResult> {
  if (session.state !== "ready") throw new Error("Ground albedo probe requires a ready device session.");
  const device = session.device, before = session.resourceCount, diagnosticsBefore = session.diagnostics.length;
  const owned: GPUBuffer[] = [], samples: GroundAlbedoSample[] = [];
  const own = (buffer: GPUBuffer): GPUBuffer => { owned.push(session.own(buffer)); return buffer; };
  let scopes = 0, readback: GPUBuffer | undefined, deviceError: string | undefined;
  for (const filter of ["validation", "out-of-memory", "internal"] as const) { device.pushErrorScope(filter); scopes++; }
  try {
    const module = device.createShaderModule({ label: "Deep ground albedo production function probe", code: `${GROUND_ALBEDO_WGSL}
@group(0) @binding(0) var<storage, read> source: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(64)
fn verifyGround(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&output)) { return; }
  let sample = source[id.x * 2u];
  let ground = source[id.x * 2u + 1u].x > 0.5;
  output[id.x] = vec4f(groundGridAlbedo(sample.rgb, sample.a, ground), 1.0);
}` });
    const pipeline = device.createComputePipeline({ label: "Deep ground albedo probe", layout: "auto", compute: { module, entryPoint: "verifyGround" } });
    const bytes = CASES.length * 16;
    const input = own(device.createBuffer({ label: "Ground albedo cases", size: bytes * 2, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
    const output = own(device.createBuffer({ label: "Ground albedo output", size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }));
    readback = own(device.createBuffer({ label: "Ground albedo readback", size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    device.queue.writeBuffer(input, 0, new Float32Array(CASES.flatMap(({ base, grid, ground }) => [...base, grid, Number(ground), 0, 0, 0])));
    const group = device.createBindGroup({ label: "Ground albedo probe bindings", layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } },
    ] });
    const encoder = device.createCommandEncoder({ label: "Ground albedo real GPU verification" });
    const compute = encoder.beginComputePass(); compute.setPipeline(pipeline); compute.setBindGroup(0, group); compute.dispatchWorkgroups(1); compute.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
    device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
    const errors: string[] = [];
    while (scopes > 0) { scopes--; const error = await device.popErrorScope(); if (error) errors.push(error.message); }
    if (errors.length) throw new Error(errors.join("; "));
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange());
    for (const [index, { base, grid, ground }] of CASES.entries()) samples.push(Object.freeze({ base, grid, ground,
      actual: Object.freeze(Array.from(values.subarray(index * 4, index * 4 + 3))),
      expected: Object.freeze(base.map(value => { const albedo = clamp(value); return ground ? albedo + albedo * (1 - albedo) * (0.32 * clamp(grid)) : value; })),
    }));
  } catch (error) { deviceError = error instanceof Error ? error.message : String(error); }
  finally {
    if (readback?.mapState === "mapped") readback.unmap();
    while (scopes > 0) { scopes--; await device.popErrorScope().catch(() => null); }
    for (const resource of owned.reverse()) session.release(resource);
  }
  const complete = samples.length === CASES.length;
  const dark = samples.filter(sample => sample.ground && sample.grid === 1 && sample.base.every(value => value > 0 && value <= 0.03));
  const light = samples.filter(sample => sample.ground && sample.grid === 1 && sample.base.every(value => value >= 0.88 && value < 1));
  const diagnostics = session.diagnostics.slice(diagnosticsBefore);
  if (diagnostics.length) deviceError = diagnostics.map(value => value.message).join("; ");
  const checks = Object.freeze({ complete,
    boundedReflectance: complete && samples.filter(sample => sample.ground).every(sample => sample.actual.every(value => Number.isFinite(value) && value >= 0 && value <= 1)),
    darkGridContrast: dark.length === 2 && dark.every(sample => sample.actual.every((value, channel) => value > sample.base[channel]! && value < 0.04 && Math.abs(value / sample.base[channel]! - 1.32) < 0.011)),
    lightGridContrast: light.length === 2 && light.every(sample => sample.actual.every((value, channel) => value > sample.base[channel]! && value < 1)),
    whitePreserved: complete && samples.slice(8, 12).every(sample => sample.actual.every(value => value === 1)),
    noGridPreserved: complete && samples.filter(sample => sample.ground && sample.grid <= 0).every(sample => sample.actual.every((value, channel) => close(value, clamp(sample.base[channel]!)))),
    nonGroundPreserved: complete && samples.filter(sample => !sample.ground).every(sample => sample.actual.every((value, channel) => close(value, sample.base[channel]!))),
    gridClamped: complete && BASES.every((_, baseIndex) => samples[baseIndex * 4 + 1]!.actual.every((value, channel) => close(value, samples[baseIndex * 4 + 2]!.actual[channel]!))),
    cpuGpuAgreement: complete && samples.every(sample => sample.actual.every((value, channel) => close(value, sample.expected[channel]!))),
    resourcesReleased: session.resourceCount === before,
    gpuHealthy: session.state === "ready" && !deviceError,
  });
  return Object.freeze({ action: "ground-albedo", success: Object.values(checks).every(Boolean), checks,
    samples: Object.freeze(samples), ...(deviceError ? { deviceError } : {}) });
}
