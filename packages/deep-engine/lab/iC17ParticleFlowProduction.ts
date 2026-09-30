/// <reference types="@webgpu/types" />
import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import type { RenderView } from "../src/webgpu/pbrRendererTypes.js";
import { GpuParticleRuntime, type GpuParticleRuntimeFrameInput, type GpuParticleRenderBinding } from "../src/webgpu/gpuParticleRuntime.js";
import type { DeviceSession } from "../src/webgpu/deviceSession.js";
import type { GpuParticleSeed } from "../src/webgpu/gpuParticleTypes.js";
import { advanceFlowParticleCpu } from "../src/particles/flowFieldParticleCpu.js";
import { GPU_PARTICLE_FLOW_FIELD_WGSL } from "../src/webgpu/gpuParticleFlowFieldWgsl.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { isPbrFrameReadbackSnapshot, type PbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { decodeHalfFloat } from "../src/rayTracing/probeGridBakeMath.js";

async function readState(session: DeviceSession, binding: GpuParticleRenderBinding) {
  const bytes = binding.capacity * 64;
  const read = session.own(session.device.createBuffer({ label: "C17 particle state readback", size: bytes + 16,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
  try {
    const encoder = session.device.createCommandEncoder(); encoder.copyBufferToBuffer(binding.stateBuffer, 0, read, 0, bytes);
    encoder.copyBufferToBuffer(binding.indirectBuffer, 0, read, bytes, 16); session.device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ); const copied = read.getMappedRange().slice(0); read.unmap();
    const floats = new Float32Array(copied, 0, bytes / 4), indirect = Array.from(new Uint32Array(copied, bytes, 4));
    const particles = Array.from({ length: indirect[1]! }, (_, index) => Array.from(floats.slice(index * 16, index * 16 + 16)))
      .sort((a, b) => a[14]! - b[14]!);
    return { particles, indirect };
  } finally { if (read.mapState === "mapped") read.unmap(); session.release(read); }
}
const seeds: readonly GpuParticleSeed[] = [...Array.from({ length: 16 }, (_, id): GpuParticleSeed => ({
  id, position: [id * .13 - .71, id * -.17 + .37, id * .11 - .43], velocity: [.3, .1, -.2],
  lifetime: .7, age: id * .037, flags: 1, color: [.2, .7, 1, .8], size: .04,
})), { id: 99, position: [0, 0, 0], velocity: [0, 0, 0], lifetime: .1, age: .09 }];
async function numeric(session: DeviceSession, mode: "flow" | "base" | "zero", seed = 17) {
  const before = session.resourceCount, runtime = new GpuParticleRuntime(session, `c17-${mode}-${seed}`,
    { capacity: 32, initialParticles: seeds });
  const cold = session.resourceCount; let reference = [...seeds], maxError = 0, speed = 0, invalidRetained = false;
  const frames = [];
  try {
    for (let frame = 0; frame < 8; frame++) {
      const input: GpuParticleRuntimeFrameInput = { frame, deltaTime: .08, acceleration: [0, -.07, 0], drag: .03,
        ...(mode === "base" ? {} : { flow: { phase: frame * .13, noiseScale: .7, flowStrength: mode === "zero" ? 0 : 3,
          flowSpeed: 1.2, maxSpeed: mode === "zero" ? 0 : .8, seed } }) };
      const result = await runtime.beginFrame(input);
      if (result.status !== "committed" || !result.snapshot) throw result.error ?? Error("C17 frame not committed");
      const actual = await readState(session, result.snapshot.binding);
      reference = reference.map(particle => advanceFlowParticleCpu(particle, input)).filter((p): p is GpuParticleSeed => p !== undefined);
      if (actual.particles.length !== reference.length || actual.indirect[0] !== 6) throw Error("C17 compaction count mismatch");
      for (const p of actual.particles) {
        const expected = reference.find(candidate => candidate.id === p[14]); if (!expected) throw Error("C17 ID mismatch");
        const values = [...expected.position, expected.age!, ...expected.velocity, expected.lifetime];
        maxError = Math.max(maxError, ...values.map((v, axis) => Math.abs(v - p[axis]!)));
        speed = Math.max(speed, Math.hypot(p[4]!, p[5]!, p[6]!));
      }
      frames.push(actual);
    }
    const snapshot = runtime.current;
    const invalid = await runtime.beginFrame({ deltaTime: .08, flow: { phase: NaN } });
    const abort = new AbortController(); abort.abort("C17 pre-abort");
    const cancelled = await runtime.beginFrame({ deltaTime: .08, flow: { phase: 0 } }, abort.signal);
    invalidRetained = invalid.status === "failed" && cancelled.status === "cancelled" && runtime.current === snapshot;
    return { frames, maxError, speed, invalidRetained, coldExtraResources: cold - before, warmExtraResources: session.resourceCount - before };
  } finally { runtime.dispose(); if (session.resourceCount !== before) throw Error("C17 runtime leaked resources"); }
}
const view: RenderView = { width: 1920, height: 1080, pixelRatio: 1, eye: [0, 0, 6], target: [0, 0, 0], up: [0, 1, 0],
  extent: 6, verticalFovRadians: .8, near: .1, far: 50, exposure: 1, roughness: .7,
  background: [.012, .021, .032], floor: [0, 0, 0],
  authorColorEffects: { colorGrading: { hue: 0, saturation: 0, brightness: 0, contrast: 0, temperature: 0, tint: 0 } } };
function pixelChange(a: PbrFrameReadbackSnapshot, b: PbrFrameReadbackSnapshot) {
  const av = new DataView(a.bytes.buffer, a.bytes.byteOffset), bv = new DataView(b.bytes.buffer, b.bytes.byteOffset);
  let changed = 0;
  for (let y = 0; y < 1080; y++) for (let x = 0; x < 1920; x++) {
    let difference = 0;
    for (let c = 0; c < 3; c++) difference = Math.max(difference,
      Math.abs(decodeHalfFloat(av.getUint16(y * a.bytesPerRow + x * 8 + c * 2, true))
        - decodeHalfFloat(bv.getUint16(y * b.bytesPerRow + x * 8 + c * 2, true))));
    if (difference > .001) changed++;
  }
  return changed;
}
export async function runIC17ParticleFlowProduction(onFrame: (name: string) => Promise<void>, temporalAa = false, neutralGrading = true) {
  const canvas = document.createElement("canvas"); canvas.width = 1920; canvas.height = 1080;
  canvas.style.width = "100vw"; canvas.style.height = "100vh"; document.body.append(canvas);
  const capture = new FrameCaptureSession();
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    particleEmitters: [{ id: "stream", preset: "flow-line", start: [-2.4, -1, 0], end: [2.4, 1, 0],
      count: 256, lifetime: 30, size: .025, color: [.1, .65, 1, .85], seed: 17 }], particleRuntime: { capacity: 256 },
    features: { environment: false, groundPlane: false, groundGrid: false, fog: false, ambientOcclusion: false,
      screenSpaceReflection: false, temporalAa, spatialAa: false, bloom: false, vignette: false, occlusionCulling: false },
    frameCapture: { session: capture, readbacks: { requests: [{ resourceId: "opaque-hdr" }] } },
  });
  const session = renderer.session, device = session.device; let result: Record<string, unknown> = {}, validationError: string | undefined;
  device.pushErrorScope("validation");
  try {
    const flow = await numeric(session, "flow"), repeat = await numeric(session, "flow"), different = await numeric(session, "flow", 19);
    const baseline = await numeric(session, "base"), zero = await numeric(session, "zero");
    const deterministic = JSON.stringify(flow.frames) === JSON.stringify(repeat.frames);
    const seedChangesField = JSON.stringify(flow.frames) !== JSON.stringify(different.frames);
    const zeroIdentity = JSON.stringify(baseline.frames) === JSON.stringify(zero.frames);
    await renderer.setPacketValidated({ geometries: [{ id: "plate", revision: 1,
      vertices: new Float32Array([-4, -2, -2, 0, 0, 1, 4, -2, -2, 0, 0, 1, 4, 2, -2, 0, 0, 1, -4, 2, -2, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }],
      materials: [{ id: "backdrop", baseColor: [.023, .04, .06], roughness: .9, metallic: 0, doubleSided: true }],
      instances: [{ id: "plate", geometry: "plate", material: "backdrop", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] });
    const images: PbrFrameReadbackSnapshot[] = [], draws: number[] = [];
    for (let frame = 0; frame < 5; frame++) {
      const { authorColorEffects, ...bareView } = view;
      const metrics = renderer.render({ ...bareView, ...(neutralGrading ? { authorColorEffects } : {}),
        ...(frame < 4 ? { particleFlow: { phase: frame * .1, flowStrength: 3, seed: 17 } } : {}) });
      if (!metrics) throw Error("C17 production frame missing"); draws.push(metrics.drawCalls);
      const reads = await renderer.frameReadbackResults;
      const image = reads?.find(isPbrFrameReadbackSnapshot) as PbrFrameReadbackSnapshot | undefined;
      if (!image) throw Error("C17 HDR readback unavailable"); images.push(image);
      await device.queue.onSubmittedWorkDone(); await new Promise(resolve => setTimeout(resolve, 10));
      if (frame === 3 || frame === 4) await onFrame(frame === 3 ? "flow-enabled" : "flow-disabled");
    }
    const changedPixels = pixelChange(images[0]!, images[3]!);
    result = { temporalAa, neutralGrading, flow, baseline, zero, deterministic, seedChangesField, zeroIdentity, changedPixels, draws,
      shaderHash: sha256Utf8(GPU_PARTICLE_FLOW_FIELD_WGSL), adapter: session.adapterInfo, epoch: session.recovery?.epoch ?? 0,
      sameDevice: session.device === device, passed: deterministic && seedChangesField && zeroIdentity && flow.maxError < .0001
        && flow.speed <= .80001 && flow.invalidRetained && flow.coldExtraResources === 7 && flow.warmExtraResources === 8
        && baseline.warmExtraResources === 7 && zero.warmExtraResources === 7 && changedPixels > 100 && draws.at(-1)! >= 2 };
  } catch (error) { result = { temporalAa, neutralGrading, failure: error instanceof Error ? error.message : String(error), passed: false }; }
  finally { validationError = (await device.popErrorScope())?.message; renderer.dispose(); canvas.remove(); }
  return { ...result, validationError, diagnostics: session.diagnostics, remainingResources: session.resourceCount,
    passed: result.passed === true && !validationError && !session.hasErrors && session.resourceCount === 0 };
}
