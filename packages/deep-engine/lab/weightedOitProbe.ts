/// <reference types="@webgpu/types" />
import { WeightedOitPass, weightedOitColorTargets, WEIGHTED_OIT_FRAGMENT_WGSL,
  type DeviceSession } from "@bim-studio/deep-engine/webgpu";
import { decodeFloat16Bits } from "./shaderPackageProbe.js";

const SIZE = 4;
const ROW_BYTES = 256;

const PROBE_WGSL = /* wgsl */ `${WEIGHTED_OIT_FRAGMENT_WGSL}
struct LayerParameters {
  color: vec4f,
  depthPadding: vec4f,
};
@group(0) @binding(0) var<uniform> layer: LayerParameters;

@vertex fn probeVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[index], 0.0, 1.0);
}

@fragment fn probeFragment() -> DeepWeightedOitOutput {
  return deepWeightedOit(layer.color.rgb, layer.color.a, layer.depthPadding.x);
}`;

export interface WeightedOitProbeResult {
  readonly action: "weighted-blended-oit";
  readonly success: boolean;
  readonly forwardPixel: readonly number[];
  readonly reversePixel: readonly number[];
  readonly maxOrderDelta: number;
  readonly depthWeighted: boolean;
  readonly generation: number;
  readonly targetsReused: boolean;
  readonly deviceError?: string;
}

function layerData(color: readonly [number, number, number, number], depth: number): Float32Array<ArrayBuffer> {
  const values = new Float32Array(new ArrayBuffer(32));
  values.set(color); values[4] = depth;
  return values;
}

/** Draws the same intersecting transparency layers in opposite orders and compares real GPU pixels. */
export async function runWeightedOitProbe(session: DeviceSession): Promise<WeightedOitProbeResult> {
  if (session.state !== "ready") throw new Error("Weighted OIT probe requires a ready device session.");
  const device = session.device, resources: Array<GPUBuffer | GPUTexture> = [];
  const own = <T extends GPUBuffer | GPUTexture>(resource: T): T => { resources.push(session.own(resource)); return resource; };
  const oit = new WeightedOitPass(session);
  let scopePopped = false;
  device.pushErrorScope("validation");
  try {
    const targets = oit.resize(SIZE, SIZE), reused = oit.resize(SIZE, SIZE);
    const opaque = own(device.createTexture({ label: "Deep OIT probe opaque", size: [SIZE, SIZE], format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
    const outputA = own(device.createTexture({ label: "Deep OIT probe output A", size: [SIZE, SIZE], format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }));
    const outputB = own(device.createTexture({ label: "Deep OIT probe output B", size: [SIZE, SIZE], format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }));
    const readbackA = own(device.createBuffer({ label: "Deep OIT probe readback A", size: ROW_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    const readbackB = own(device.createBuffer({ label: "Deep OIT probe readback B", size: ROW_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    const layerLayout = device.createBindGroupLayout({ label: "Deep OIT probe layer layout", entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ] });
    const shader = device.createShaderModule({ label: "Deep OIT order probe WGSL", code: PROBE_WGSL });
    const pipeline = device.createRenderPipeline({ label: "Deep OIT accumulation probe pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layerLayout] }),
      vertex: { module: shader, entryPoint: "probeVertex" },
      fragment: { module: shader, entryPoint: "probeFragment", targets: [...weightedOitColorTargets()] },
      primitive: { topology: "triangle-list", cullMode: "none" }, multisample: { count: 1 } });
    const buffers = [
      own(device.createBuffer({ label: "Deep OIT near red layer", size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })),
      own(device.createBuffer({ label: "Deep OIT far blue layer", size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })),
    ];
    device.queue.writeBuffer(buffers[0]!, 0, layerData([1, 0, 0, 0.55], 0.2));
    device.queue.writeBuffer(buffers[1]!, 0, layerData([0, 0, 1, 0.55], 0.8));
    const bindings = buffers.map((buffer, index) => device.createBindGroup({ label: `Deep OIT probe layer ${index}`,
      layout: layerLayout, entries: [{ binding: 0, resource: { buffer } }] }));
    const encoder = device.createCommandEncoder({ label: "Deep weighted OIT order probe" });
    const opaquePass = encoder.beginRenderPass({ label: "Deep OIT opaque background", colorAttachments: [{
      view: opaque.createView(), clearValue: [0.02, 0.02, 0.02, 1], loadOp: "clear", storeOp: "store",
    }] });
    opaquePass.end();
    const drawLayers = (order: readonly number[], output: GPUTexture): void => {
      const pass = encoder.beginRenderPass({ label: "Deep OIT accumulation", colorAttachments: [...oit.accumulationAttachments()] });
      pass.setPipeline(pipeline);
      for (const index of order) { pass.setBindGroup(0, bindings[index]!); pass.draw(3); }
      pass.end();
      oit.encodeComposite(encoder, opaque.createView(), output.createView(), { outputFormat: "rgba16float" });
    };
    drawLayers([0, 1], outputA); drawLayers([1, 0], outputB);
    encoder.copyTextureToBuffer({ texture: outputA, origin: [2, 2, 0] }, { buffer: readbackA, bytesPerRow: ROW_BYTES }, [1, 1, 1]);
    encoder.copyTextureToBuffer({ texture: outputB, origin: [2, 2, 0] }, { buffer: readbackB, bytesPerRow: ROW_BYTES }, [1, 1, 1]);
    device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
    const deviceError = await device.popErrorScope(); scopePopped = true;
    if (deviceError) return failed(targets.generation, reused === targets, deviceError.message);
    await Promise.all([readbackA.mapAsync(GPUMapMode.READ), readbackB.mapAsync(GPUMapMode.READ)]);
    const readPixel = (buffer: GPUBuffer): readonly number[] => {
      const view = new DataView(buffer.getMappedRange());
      return Object.freeze(Array.from({ length: 4 }, (_, index) => decodeFloat16Bits(view.getUint16(index * 2, true))));
    };
    const forwardPixel = readPixel(readbackA), reversePixel = readPixel(readbackB);
    readbackA.unmap(); readbackB.unmap();
    const maxOrderDelta = Math.max(...forwardPixel.map((value, index) => Math.abs(value - reversePixel[index]!)));
    const finite = [...forwardPixel, ...reversePixel].every(Number.isFinite);
    const depthWeighted = forwardPixel[0]! > forwardPixel[2]! * 1.5 && forwardPixel[2]! > 0.05;
    return Object.freeze({ action: "weighted-blended-oit", success: finite && maxOrderDelta <= 0.002 && depthWeighted,
      forwardPixel, reversePixel, maxOrderDelta, depthWeighted, generation: targets.generation, targetsReused: reused === targets });
  } catch (error) {
    const scoped = scopePopped ? null : await device.popErrorScope().catch(() => null); scopePopped = true;
    return failed(oit.current?.generation ?? 0, false, scoped?.message ?? (error instanceof Error ? error.message : String(error)));
  } finally {
    if (!scopePopped) await device.popErrorScope().catch(() => null);
    oit.dispose(); for (const resource of resources.reverse()) session.release(resource);
  }
}

function failed(generation: number, targetsReused: boolean, deviceError: string): WeightedOitProbeResult {
  return Object.freeze({ action: "weighted-blended-oit", success: false, forwardPixel: [], reversePixel: [],
    maxOrderDelta: Number.POSITIVE_INFINITY, depthWeighted: false, generation, targetsReused, deviceError });
}
