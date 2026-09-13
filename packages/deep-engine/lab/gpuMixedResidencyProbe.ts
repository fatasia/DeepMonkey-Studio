/// <reference types="@webgpu/types" />
import type { GeometryResource } from "@bim-studio/deep-engine/webgpu";
import {
  GpuRenderResidencyRuntime,
  type DeviceSession,
  type GpuRenderResidencyHandle,
} from "@bim-studio/deep-engine/webgpu";
import type { GpuResidentLease } from "@bim-studio/deep-engine/streaming";

const SHARED_ID = "shared-draw-resource";
const EXPECTED_PIXEL = Object.freeze([32, 128, 224, 255] as const);
const GEOMETRY_BYTES = 132;
const TEXTURE_BYTES = 4;

const geometry: GeometryResource = Object.freeze({
  id: SHARED_ID,
  revision: 1,
  vertices: new Float32Array([
    -1, -1, 0, 0, 0, 1,
    3, -1, 0, 0, 0, 1,
    -1, 3, 0, 0, 0, 1,
  ]),
  indices: new Uint32Array([0, 1, 2]),
});

export interface GpuMixedResidencyProbeResult {
  readonly action: "gpu-mixed-residency";
  readonly success: boolean;
  readonly samePublicIdResident: boolean;
  readonly realGpuDrawReadback: boolean;
  readonly leasesSurvivedDispose: boolean;
  readonly releaseCleanedResources: boolean;
  readonly gpuErrorScopesClean: boolean;
  readonly deviceDiagnosticsClean: boolean;
  readonly nonFallbackAdapter: boolean;
  readonly pixel: readonly number[] | null;
  readonly gpuErrors: readonly string[];
  readonly resourcesBefore: number;
  readonly resourcesHeldAfterDispose: number;
  readonly resourcesAfterRelease: number;
  readonly failure?: string;
}

type ProbeChecks = Omit<GpuMixedResidencyProbeResult, "action" | "success" | "failure">;

export function evaluateGpuMixedResidencyProbe(result: ProbeChecks): boolean {
  return result.samePublicIdResident && result.realGpuDrawReadback
    && result.leasesSurvivedDispose && result.releaseCleanedResources
    && result.gpuErrorScopesClean && result.deviceDiagnosticsClean && result.nonFallbackAdapter;
}

/** Proves collision-safe geometry/texture residency and delayed GPU destruction on a real device. */
export async function verifyGpuMixedResidency(session: DeviceSession): Promise<GpuMixedResidencyProbeResult> {
  if (session.state !== "ready") throw new Error("Mixed residency probe requires a ready device session.");
  const resourcesBefore = session.resourceCount, diagnosticsBefore = session.diagnostics.length;
  const runtime = createRuntime(session);
  let geometryLease: GpuResidentLease<GpuRenderResidencyHandle> | undefined;
  let textureLease: GpuResidentLease<GpuRenderResidencyHandle> | undefined;
  let resourcesHeldAfterDispose = -1, resourcesAfterRelease = -1;
  try {
    registerSharedResources(runtime);
    const frame = await runtime.submit(1, [
      { id: SHARED_ID, kind: "geometry", desiredLevel: 0, required: true },
      { id: SHARED_ID, kind: "texture", desiredLevel: 0, required: true },
    ]);
    const residents = runtime.snapshot();
    const samePublicIdResident = frame.status === "applied" && residents.length === 2
      && residents.every(resource => resource.id === SHARED_ID)
      && residents.some(resource => resource.kind === "geometry")
      && residents.some(resource => resource.kind === "texture");
    geometryLease = runtime.acquire("geometry", SHARED_ID);
    textureLease = runtime.acquire("texture", SHARED_ID);
    if (!geometryLease || geometryLease.resource.kind !== "geometry"
      || !textureLease || textureLease.resource.kind !== "texture") {
      throw new Error("Mixed residency leases were not published with both resource kinds.");
    }

    runtime.dispose();
    resourcesHeldAfterDispose = session.resourceCount;
    const leasesSurvivedDispose = runtime.disposed && resourcesHeldAfterDispose === resourcesBefore + 3;
    const draw = await drawLeasedResources(session.device, geometryLease.resource, textureLease.resource);
    const realGpuDrawReadback = pixelMatches(draw.pixel, EXPECTED_PIXEL);

    geometryLease.release(); geometryLease = undefined;
    const geometryReleasedFirst = session.resourceCount === resourcesBefore + 1;
    textureLease.release(); textureLease = undefined;
    resourcesAfterRelease = session.resourceCount;
    const releaseCleanedResources = geometryReleasedFirst && resourcesAfterRelease === resourcesBefore;
    const values = Object.freeze({ samePublicIdResident, realGpuDrawReadback, leasesSurvivedDispose,
      releaseCleanedResources, gpuErrorScopesClean: draw.errors.length === 0,
      deviceDiagnosticsClean: session.diagnostics.length === diagnosticsBefore,
      nonFallbackAdapter: session.adapterInfo?.isFallbackAdapter === false,
      pixel: draw.pixel, gpuErrors: draw.errors, resourcesBefore, resourcesHeldAfterDispose, resourcesAfterRelease });
    return Object.freeze({ action: "gpu-mixed-residency", success: evaluateGpuMixedResidencyProbe(values), ...values });
  } catch (error) {
    try { runtime.dispose(); } catch { /* Preserve the primary failure. */ }
    geometryLease?.release(); textureLease?.release(); resourcesAfterRelease = session.resourceCount;
    return Object.freeze({ action: "gpu-mixed-residency", success: false,
      samePublicIdResident: false, realGpuDrawReadback: false, leasesSurvivedDispose: false,
      releaseCleanedResources: resourcesAfterRelease === resourcesBefore, gpuErrorScopesClean: false,
      deviceDiagnosticsClean: session.diagnostics.length === diagnosticsBefore,
      nonFallbackAdapter: session.adapterInfo?.isFallbackAdapter === false, pixel: null, gpuErrors: [],
      resourcesBefore, resourcesHeldAfterDispose, resourcesAfterRelease,
      failure: error instanceof Error ? error.message : String(error) });
  }
}

function createRuntime(session: DeviceSession): GpuRenderResidencyRuntime {
  return new GpuRenderResidencyRuntime(session,
    { maxResidentBytes: GEOMETRY_BYTES + TEXTURE_BYTES, maxUploadBytesPerFrame: GEOMETRY_BYTES + TEXTURE_BYTES },
    request => request.kind === "geometry" ? { kind: "geometry", source: geometry } : {
      kind: "texture", source: { level: request.level, texture: {
        id: SHARED_ID, revision: 1, semantic: "normal", width: 1, height: 1,
        data: new Uint8Array(EXPECTED_PIXEL),
      } },
    }, { maxConcurrentUploads: 2 });
}

function registerSharedResources(runtime: GpuRenderResidencyRuntime): void {
  runtime.register({ id: SHARED_ID, revision: 1, kind: "geometry",
    levels: [{ level: 0, byteLength: GEOMETRY_BYTES }] });
  runtime.register({ id: SHARED_ID, revision: 1, kind: "texture",
    levels: [{ level: 0, byteLength: TEXTURE_BYTES }] });
}

async function drawLeasedResources(device: GPUDevice,
  geometryHandle: Extract<GpuRenderResidencyHandle, { kind: "geometry" }>,
  textureHandle: Extract<GpuRenderResidencyHandle, { kind: "texture" }>,
): Promise<Readonly<{ pixel: readonly number[]; errors: readonly string[] }>> {
  const target = device.createTexture({ label: "Deep mixed residency probe target", size: [1, 1],
    format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const readback = device.createBuffer({ label: "Deep mixed residency probe readback", size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  let scopes = 0;
  try {
    for (const filter of ["validation", "out-of-memory", "internal"] as const) {
      device.pushErrorScope(filter); scopes++;
    }
    const module = device.createShaderModule({ label: "Deep mixed residency probe shader", code: `
      struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f }
      @vertex fn vertex(@location(0) position: vec3f) -> VertexOut {
        var out: VertexOut; out.position = vec4f(position, 1.0); out.uv = vec2f(0.5); return out;
      }
      @group(0) @binding(0) var probeSampler: sampler;
      @group(0) @binding(1) var probeTexture: texture_2d<f32>;
      @fragment fn fragment(input: VertexOut) -> @location(0) vec4f {
        return textureSampleLevel(probeTexture, probeSampler, input.uv, 0.0);
      }
    ` });
    const pipeline = device.createRenderPipeline({ label: "Deep mixed residency probe pipeline", layout: "auto",
      vertex: { module, entryPoint: "vertex", buffers: [{ arrayStride: 40,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
      fragment: { module, entryPoint: "fragment", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list" } });
    const bindings = device.createBindGroup({ label: "Deep mixed residency probe bindings",
      layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: textureHandle.sampler },
        { binding: 1, resource: textureHandle.view },
      ] });
    const encoder = device.createCommandEncoder({ label: "Deep mixed residency probe commands" });
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear",
      storeOp: "store", clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindings);
    pass.setVertexBuffer(0, geometryHandle.mesh.vertices);
    pass.setIndexBuffer(geometryHandle.mesh.indices, "uint32");
    pass.drawIndexed(geometryHandle.mesh.indexCount); pass.end();
    encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: 256 }, [1, 1]);
    device.queue.submit([encoder.finish()]);
    const checks: Promise<GPUError | null>[] = [];
    while (scopes-- > 0) checks.push(device.popErrorScope());
    await device.queue.onSubmittedWorkDone();
    const errors = (await Promise.all(checks)).filter((error): error is GPUError => error !== null)
      .map(error => error.message);
    await readback.mapAsync(GPUMapMode.READ);
    const pixel = Object.freeze(Array.from(new Uint8Array(readback.getMappedRange(), 0, 4)));
    readback.unmap();
    return Object.freeze({ pixel, errors: Object.freeze(errors) });
  } finally {
    while (scopes-- > 0) { try { await device.popErrorScope(); } catch { /* Cleanup only. */ } }
    target.destroy(); readback.destroy();
  }
}

function pixelMatches(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]!) <= 2);
}
