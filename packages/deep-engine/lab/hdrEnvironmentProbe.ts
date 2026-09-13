/// <reference types="@webgpu/types" />
import { createHdrEnvironment, type DeviceSession } from "@bim-studio/deep-engine/webgpu";

const SAMPLE_WGSL = /* wgsl */ `
@group(0) @binding(0) var specular: texture_cube<f32>;
@group(0) @binding(1) var diffuse: texture_cube<f32>;
@group(0) @binding(2) var environmentSampler: sampler;
@group(0) @binding(3) var<storage, read_write> output: array<vec4f>;
fn direction(index: u32) -> vec3f {
  switch index {
    case 0u: { return vec3f(1.0, 0.0, 0.0); }
    case 1u: { return vec3f(-1.0, 0.0, 0.0); }
    case 2u: { return vec3f(0.0, 0.0, 1.0); }
    default: { return vec3f(0.0, 0.0, -1.0); }
  }
}
@compute @workgroup_size(4) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= 4u) { return; }
  let sampleDirection = direction(id.x);
  output[id.x * 2u] = textureSampleLevel(specular, environmentSampler, sampleDirection, 0.0);
  output[id.x * 2u + 1u] = textureSampleLevel(diffuse, environmentSampler, sampleDirection, 0.0);
}`;

export interface HdrEnvironmentProbeResult {
  readonly action: "hdr-environment";
  readonly success: boolean;
  readonly directionalRange: number;
  readonly diffuseEnergy: number;
  readonly specularSamples: readonly (readonly number[])[];
  readonly expectedDirectionality: boolean;
  readonly resourcesReleased: boolean;
  readonly gpuHealthy: boolean;
  readonly error?: string;
}

function panorama(): { readonly width: number; readonly height: number; readonly data: Float32Array<ArrayBuffer> } {
  const width = 16, height = 8, data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3, first = x < width / 2;
    data[offset] = first ? 8 : 0.25;
    data[offset + 1] = y < height / 2 ? 2 : 0.5;
    data[offset + 2] = first ? 0.125 : 6;
  }
  return { width, height, data };
}

export async function verifyHdrEnvironment(session: DeviceSession): Promise<HdrEnvironmentProbeResult> {
  if (session.state !== "ready") throw new Error("HDR environment probe requires a ready device session.");
  const device = session.device, before = session.resourceCount, diagnosticsBefore = session.diagnostics.length;
  const output = session.own(device.createBuffer({ label: "Deep HDRI probe output", size: 128,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }));
  const readback = session.own(device.createBuffer({ label: "Deep HDRI probe readback", size: 128,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  let environment: Awaited<ReturnType<typeof createHdrEnvironment>> | undefined;
  let scopeOpen = false, directionalRange = 0, diffuseEnergy = 0, error: string | undefined;
  let specularSamples: readonly (readonly number[])[] = [], expectedDirectionality = false;
  try {
    device.pushErrorScope("validation"); scopeOpen = true;
    environment = await createHdrEnvironment(session, panorama(), { specularSize: 64, diffuseSize: 16, sampleCount: 64 });
    const module = device.createShaderModule({ label: "Deep HDRI probe sample", code: SAMPLE_WGSL });
    const pipeline = await device.createComputePipelineAsync({ label: "Deep HDRI probe sample", layout: "auto",
      compute: { module, entryPoint: "main" } });
    const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: environment.specular }, { binding: 1, resource: environment.diffuse },
      { binding: 2, resource: environment.sampler }, { binding: 3, resource: { buffer: output } },
    ] });
    const encoder = device.createCommandEncoder({ label: "Deep HDRI probe" });
    const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.dispatchWorkgroups(1); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 128); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const samples = new Float32Array(readback.getMappedRange()), luminances: number[] = [], sampled: number[][] = [];
    for (let index = 0; index < 4; index++) {
      const specularOffset = index * 8, diffuseOffset = specularOffset + 4;
      sampled.push(Array.from(samples.slice(specularOffset, specularOffset + 3)));
      luminances.push(samples[specularOffset]! * 0.2126 + samples[specularOffset + 1]! * 0.7152 + samples[specularOffset + 2]! * 0.0722);
      diffuseEnergy += samples[diffuseOffset]! + samples[diffuseOffset + 1]! + samples[diffuseOffset + 2]!;
    }
    specularSamples = Object.freeze(sampled.map(value => Object.freeze(value)));
    const positiveZ = sampled[2]!, negativeZ = sampled[3]!;
    expectedDirectionality = positiveZ[2]! > positiveZ[0]! * 2 && negativeZ[0]! > negativeZ[2]! * 2;
    directionalRange = Math.max(...luminances) - Math.min(...luminances);
    readback.unmap();
    const gpuError = await device.popErrorScope(); scopeOpen = false;
    if (gpuError) throw new Error(gpuError.message);
    if (![directionalRange, diffuseEnergy].every(Number.isFinite)) throw new Error("HDRI probe produced non-finite samples.");
  } catch (reason) {
    error = reason instanceof Error ? reason.message : String(reason);
    if (readback.mapState === "mapped") readback.unmap();
    if (scopeOpen) try { const gpuError = await device.popErrorScope(); if (gpuError && !error) error = gpuError.message; } catch { /* keep probe error */ }
  } finally {
    environment?.dispose(); session.release(output); session.release(readback);
  }
  const resourcesReleased = session.resourceCount === before;
  const gpuHealthy = session.state === "ready" && session.diagnostics.length === diagnosticsBefore && !error;
  return Object.freeze({ action: "hdr-environment", success: directionalRange > 0.1 && diffuseEnergy > 0
    && expectedDirectionality && resourcesReleased && gpuHealthy, directionalRange, diffuseEnergy,
    specularSamples, expectedDirectionality, resourcesReleased, gpuHealthy, ...(error ? { error } : {}) });
}
