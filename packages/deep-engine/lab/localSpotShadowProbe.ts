/// <reference types="@webgpu/types" />
import { LOCAL_SPOT_SHADOW_WGSL } from "../src/shadows/localSpotShadowShader.js";
import { LocalSpotShadowRuntime } from "../src/webgpu/localSpotShadowRuntime.js";
import type { DeviceSession } from "@bim-studio/deep-engine/webgpu";
import type { WorldClusteredLights } from "../src/lighting/worldLights.js";
import type { Pipelines } from "../src/webgpu/pipelines.js";

const ROW_BYTES = 256;
const LOCAL_SPOT_SHADOW_PROBE_CASTER_WGSL = /* wgsl */ `
@vertex fn casterVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[index], 0.4, 1.0);
}
@fragment fn casterFragment(@builtin(position) position: vec4f) -> @builtin(frag_depth) f32 {
  let tileX = position.x - floor(position.x / 512.0) * 512.0;
  if (tileX >= 256.0) { discard; }
  return 0.4;
}`;
const LOCAL_SPOT_SHADOW_PROBE_SAMPLE_WGSL = /* wgsl */ `${LOCAL_SPOT_SHADOW_WGSL}
@vertex fn sampleVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[index], 0.0, 1.0);
}
@fragment fn sampleFragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let pairX = position.x - floor(position.x / 2.0) * 2.0;
  let worldX = select(-1.0, 1.0, pairX >= 1.0);
  let spotIndex = min(3u, u32(floor(position.x / 2.0)));
  let visibility = deepLocalSpotShadow(spotIndex, vec3f(worldX, 0.0, -2.0));
  return vec4f(visibility, visibility, visibility, 1.0);
}`;

export interface LocalSpotShadowProbeResult {
  readonly action: "local-spot-shadow-readback";
  readonly success: boolean;
  readonly checks: Readonly<{ occludedAndLit: boolean; disabledFullyLit: boolean;
    fourSpotsRendered: boolean; fixedAtlasBudget: boolean; overflowStable: boolean;
    repeatFrameSkipped: boolean; atlasStableAcrossRepeat: boolean; resourcesReleased: boolean; gpuHealthy: boolean }>;
  readonly metrics: Readonly<{ enabled: readonly number[]; repeated: readonly number[]; disabled: readonly number[];
    firstRendered: boolean; repeatedRendered: boolean; shadowedSpotIndices: readonly number[];
    allocationKeys: readonly string[]; rejectedSpotKeys: readonly string[]; atlasDepthBytes: number;
    requestedSpotCount: number; deviceEpoch: string; resourcesBefore: number; resourcesAfter: number }>;
  readonly deviceError?: string;
}

export function evaluateLocalSpotShadowSamples(enabled: readonly number[], repeated: readonly number[],
  disabled: readonly number[]): Pick<LocalSpotShadowProbeResult["checks"], "occludedAndLit" | "disabledFullyLit" | "atlasStableAcrossRepeat"> {
  const occludedAndLit = enabled.length === 8
    && [0, 2, 4, 6].every(index => enabled[index]! <= 8 && enabled[index + 1]! >= 247);
  const disabledFullyLit = disabled.length === 8 && disabled.every(value => value >= 247);
  const atlasStableAcrossRepeat = repeated.length === enabled.length
    && repeated.every((value, index) => Math.abs(value - enabled[index]!) <= 1);
  return { occludedAndLit, disabledFullyLit, atlasStableAcrossRepeat };
}

/** Writes the production atlas, samples production PCF, and reads both shadow states back from the GPU. */
export async function runLocalSpotShadowProbe(session: DeviceSession): Promise<LocalSpotShadowProbeResult> {
  if (session.state !== "ready") throw new Error("Local spot shadow probe requires a ready device session.");
  const device = session.device, resourcesBefore = session.resourceCount, diagnosticsBefore = session.diagnostics.length;
  const owned: Array<GPUBuffer | GPUTexture> = [];
  const own = <T extends GPUBuffer | GPUTexture>(resource: T): T => { owned.push(session.own(resource)); return resource; };
  let runtime: LocalSpotShadowRuntime | undefined, readback: GPUBuffer | undefined, readbackMapped = false, scopeOpen = false;
  let enabled: readonly number[] = [], repeated: readonly number[] = [], disabled: readonly number[] = [];
  let firstRendered = false, repeatedRendered = true, shadowedSpotIndices: readonly number[] = [];
  let allocationKeys: readonly string[] = [], repeatedAllocationKeys: readonly string[] = [], rejectedSpotKeys: readonly string[] = [];
  let atlasDepthBytes = 0, requestedSpotCount = 0;
  let deviceEpoch = "", deviceError: string | undefined;
  try {
    runtime = await LocalSpotShadowRuntime.create(session); deviceEpoch = runtime.deviceEpoch;
    const group0 = device.createBindGroupLayout({ label: "Deep local shadow probe frame layout", entries: [{ binding: 0,
      visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }] });
    const casterModule = device.createShaderModule({ label: "Deep local shadow probe caster WGSL", code: LOCAL_SPOT_SHADOW_PROBE_CASTER_WGSL });
    const caster = device.createRenderPipeline({ label: "Deep local shadow probe caster",
      layout: device.createPipelineLayout({ bindGroupLayouts: [group0] }),
      vertex: { module: casterModule, entryPoint: "casterVertex" }, fragment: { module: casterModule, entryPoint: "casterFragment", targets: [] },
      primitive: { topology: "triangle-list" }, depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" } });
    const empty1 = device.createBindGroupLayout({ label: "Deep local shadow probe empty 0", entries: [] });
    const empty2 = device.createBindGroupLayout({ label: "Deep local shadow probe empty 1", entries: [] });
    const empty3 = device.createBindGroupLayout({ label: "Deep local shadow probe empty 2", entries: [] });
    const localLayout = device.createBindGroupLayout({ label: "Deep local shadow probe bindings", entries: [
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d" } },
      { binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
    ] });
    const sampleModule = device.createShaderModule({ label: "Deep local shadow probe sample WGSL", code: LOCAL_SPOT_SHADOW_PROBE_SAMPLE_WGSL });
    const sample = device.createRenderPipeline({ label: "Deep local shadow probe sample",
      layout: device.createPipelineLayout({ bindGroupLayouts: [empty1, empty2, empty3, localLayout] }),
      vertex: { module: sampleModule, entryPoint: "sampleVertex" },
      fragment: { module: sampleModule, entryPoint: "sampleFragment", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list", cullMode: "none" } });
    const localBindings = device.createBindGroup({ label: "Deep local shadow probe production bindings", layout: localLayout,
      entries: [{ binding: 6, resource: { buffer: runtime.bindings.uniform } },
        { binding: 7, resource: runtime.bindings.atlasView }, { binding: 8, resource: runtime.bindings.sampler }] });
    const target = own(device.createTexture({ label: "Deep local shadow probe target", size: [8, 1], format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }));
    readback = own(device.createBuffer({ label: "Deep local shadow probe readback", size: ROW_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    const pipelines = { shadow: caster } as unknown as Pipelines;
    const packets = { draw(pass: GPURenderPassEncoder) { pass.draw(3); return { drawCalls: 1, triangles: 1 }; } };
    const spot = (key: string, importance: number) => ({ positionWorld: [0, 0, 0] as const,
      directionWorld: [0, 0, -1] as const, range: 10,
      color: [1, 1, 1] as const, intensity: 4, innerConeCos: 0.8, outerConeCos: Math.SQRT1_2,
      shadow: { key, importance } });
    const lights = { spots: [spot("probe-spot-a", 5), spot("probe-spot-b", 4), spot("probe-spot-c", 3),
      spot("probe-spot-d", 2), spot("probe-spot-overflow", 1)] };
    requestedSpotCount = lights.spots.length; atlasDepthBytes = runtime.budget?.allocatedDepthTextureBytes ?? 0;
    const execute = async (activeLights: WorldClusteredLights = lights): Promise<Readonly<{
      pixels: readonly number[]; rendered: boolean; shadowedSpotIndices: readonly number[];
      allocationKeys: readonly string[]; rejectedSpotKeys: readonly string[] }>> => {
      device.pushErrorScope("validation"); scopeOpen = true;
      const encoder = device.createCommandEncoder({ label: "Deep local spot shadow probe commands" });
      const frame = runtime!.prepareAndEncode(encoder, packets as never, pipelines, activeLights, false);
      const pass = encoder.beginRenderPass({ label: "Deep local shadow visibility readback", colorAttachments: [{ view: target.createView(),
        clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store" }] });
      pass.setPipeline(sample); pass.setBindGroup(3, localBindings); pass.draw(3); pass.end();
      encoder.copyTextureToBuffer({ texture: target }, { buffer: readback!, bytesPerRow: ROW_BYTES }, [8, 1]);
      device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
      const scoped = await device.popErrorScope(); scopeOpen = false; if (scoped) throw new Error(scoped.message);
      await readback!.mapAsync(GPUMapMode.READ); readbackMapped = true;
      const bytes = new Uint8Array(readback!.getMappedRange());
      const values = Object.freeze([bytes[0]!, bytes[4]!, bytes[8]!, bytes[12]!,
        bytes[16]!, bytes[20]!, bytes[24]!, bytes[28]!]);
      readback!.unmap(); readbackMapped = false; runtime!.commit();
      return Object.freeze({ pixels: values, rendered: frame.rendered, shadowedSpotIndices: frame.shadowedSpotIndices,
        allocationKeys: Object.freeze(frame.plan?.allocations.filter(value => value.kind === "spot").map(value => value.key) ?? []),
        rejectedSpotKeys: Object.freeze(frame.plan?.rejected.filter(value => value.kind === "spot").map(value => value.key) ?? []) });
    };
    const first = await execute(), repeat = await execute(), fallback = await execute({});
    enabled = first.pixels; firstRendered = first.rendered; shadowedSpotIndices = first.shadowedSpotIndices;
    allocationKeys = first.allocationKeys; rejectedSpotKeys = first.rejectedSpotKeys;
    repeated = repeat.pixels; repeatedRendered = repeat.rendered; disabled = fallback.pixels;
    repeatedAllocationKeys = repeat.allocationKeys;
  } catch (error) {
    if (scopeOpen) try { await device.popErrorScope(); } catch { /* Preserve the first failure. */ }
    deviceError = error instanceof Error ? error.message : String(error);
  } finally {
    if (readbackMapped) try { readback?.unmap(); } catch { /* Device loss may invalidate the map. */ }
    runtime?.dispose(); for (const resource of owned.reverse()) session.release(resource);
  }
  const sampleChecks = evaluateLocalSpotShadowSamples(enabled, repeated, disabled);
  const diagnostics = session.diagnostics.slice(diagnosticsBefore);
  if (diagnostics.length) deviceError = diagnostics.map(value => value.message).join("; ");
  const checks = Object.freeze({ ...sampleChecks,
    fourSpotsRendered: firstRendered && shadowedSpotIndices.length === 4
      && shadowedSpotIndices.every((value, index) => value === index),
    fixedAtlasBudget: atlasDepthBytes === 4 * 1024 * 1024,
    overflowStable: allocationKeys.length === 4 && rejectedSpotKeys.includes("probe-spot-overflow")
      && JSON.stringify(repeatedAllocationKeys) === JSON.stringify(allocationKeys),
    repeatFrameSkipped: firstRendered && !repeatedRendered,
    resourcesReleased: session.resourceCount === resourcesBefore,
    gpuHealthy: session.state === "ready" && diagnostics.length === 0 && !deviceError });
  const metrics = Object.freeze({ enabled, repeated, disabled, firstRendered, repeatedRendered, shadowedSpotIndices,
    allocationKeys, rejectedSpotKeys, atlasDepthBytes, requestedSpotCount, deviceEpoch,
    resourcesBefore, resourcesAfter: session.resourceCount });
  return Object.freeze({ action: "local-spot-shadow-readback", success: Object.values(checks).every(Boolean), checks, metrics,
    ...(deviceError ? { deviceError } : {}) });
}
