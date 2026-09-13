/// <reference types="@webgpu/types" />
import { CASCADED_SHADOW_UNIFORM_BYTES, CASCADED_SHADOW_WGSL } from "@bim-studio/deep-engine/shadows";
import type { DeviceSession } from "@bim-studio/deep-engine/webgpu";

export interface CascadedShadowProbeResult {
  readonly action: "cascaded-shadow-array-pcf";
  readonly success: boolean;
  readonly cascade0: number;
  readonly cascade1: number;
  readonly casterLayersWritten: boolean;
  readonly selectedDistinctLayers: boolean;
  readonly deviceError?: string;
}

const PROBE_WGSL = `${CASCADED_SHADOW_WGSL}
struct VertexOutput { @builtin(position) position: vec4f };
@vertex fn probeVertex(@builtin(vertex_index) index: u32) -> VertexOutput {
  let vertices = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return VertexOutput(vec4f(vertices[index], 0.0, 1.0));
}
@fragment fn probeFragment(input: VertexOutput) -> @location(0) vec4f {
  let viewDepth = select(1.0, 3.0, input.position.x >= 1.0);
  let visibility = deepCascadedShadow(viewDepth, vec3f(0.0, 0.0, 0.5), vec3f(0.0, 0.0, 1.0), 1.0);
  return vec4f(visibility, visibility, visibility, 1.0);
}
@vertex fn casterVertex(@builtin(vertex_index) index: u32, @builtin(instance_index) layer: u32) -> @builtin(position) vec4f {
  let vertices = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(vertices[index], select(0.75, 0.25, layer == 1u), 1.0);
}`;

/** Draws real caster geometry into two array layers, then verifies selection and comparison sampling. */
export async function runCascadedShadowProbe(session: DeviceSession): Promise<CascadedShadowProbeResult> {
  if (session.state !== "ready") throw new Error("Cascaded shadow probe requires a ready device session.");
  const device = session.device, resources: Array<GPUBuffer | GPUTexture> = [];
  const own = <T extends GPUBuffer | GPUTexture>(resource: T): T => { resources.push(session.own(resource)); return resource; };
  const depth = own(device.createTexture({ label: "Deep cascade probe depth array", size: [4, 4, 2], format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
  const color = own(device.createTexture({ label: "Deep cascade probe color", size: [2, 1, 1], format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }));
  const uniform = own(device.createBuffer({ label: "Deep cascade probe uniform", size: CASCADED_SHADOW_UNIFORM_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
  const readback = own(device.createBuffer({ label: "Deep cascade probe readback", size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  device.pushErrorScope("validation");
  try {
    const module = device.createShaderModule({ label: "Deep cascade probe WGSL", code: PROBE_WGSL });
    const pipeline = device.createRenderPipeline({ label: "Deep cascade probe pipeline", layout: "auto",
      vertex: { module, entryPoint: "probeVertex" }, fragment: { module, entryPoint: "probeFragment", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list" } });
    const casterPipeline = device.createRenderPipeline({ label: "Deep cascade caster pipeline", layout: "auto",
      vertex: { module, entryPoint: "casterVertex" }, primitive: { topology: "triangle-list" },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" } });
    const data = new Float32Array(CASCADED_SHADOW_UNIFORM_BYTES / 4);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (let index = 0; index < 8; index += 1) data.set(identity, index * 16);
    data.set([2, 4, 4, 4, 4, 4, 4, 4], 128);
    data.set([1.8, 4, 4, 4, 4, 4, 4, 4], 136);
    data.set([1, 1, 1, 1, 1, 1, 1, 1], 144);
    data.set([2, 0, 0.25, 0], 152);
    device.queue.writeBuffer(uniform, 0, data);
    const binding = device.createBindGroup({ label: "Deep cascade probe bindings", layout: pipeline.getBindGroupLayout(2), entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: depth.createView({ dimension: "2d-array", baseArrayLayer: 0, arrayLayerCount: 2 }) },
      { binding: 2, resource: device.createSampler({ compare: "less-equal", minFilter: "nearest", magFilter: "nearest" }) },
    ] });
    const encoder = device.createCommandEncoder({ label: "Deep cascaded shadow probe" });
    for (const layer of [0, 1] as const) {
      const pass = encoder.beginRenderPass({ label: `Deep cascade probe layer ${layer}`, colorAttachments: [], depthStencilAttachment: {
        view: depth.createView({ dimension: "2d", baseArrayLayer: layer, arrayLayerCount: 1, aspect: "depth-only" }),
        depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store",
      } });
      pass.setPipeline(casterPipeline); pass.draw(3, 1, 0, layer);
      pass.end();
    }
    const render = encoder.beginRenderPass({ label: "Deep cascade selection readback", colorAttachments: [{
      view: color.createView(), clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store",
    }] });
    render.setPipeline(pipeline); render.setBindGroup(2, binding); render.draw(3); render.end();
    encoder.copyTextureToBuffer({ texture: color }, { buffer: readback, bytesPerRow: 256 }, [2, 1, 1]);
    device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
    const scoped = await device.popErrorScope();
    if (scoped) return Object.freeze({ action: "cascaded-shadow-array-pcf", success: false, cascade0: 0, cascade1: 0,
      casterLayersWritten: false,
      selectedDistinctLayers: false, deviceError: scoped.message });
    await readback.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(readback.getMappedRange());
    const cascade0 = bytes[0] ?? 0, cascade1 = bytes[4] ?? 0;
    readback.unmap();
    const casterLayersWritten = cascade0 >= 250 && cascade1 <= 5;
    const selectedDistinctLayers = casterLayersWritten;
    return Object.freeze({ action: "cascaded-shadow-array-pcf", success: selectedDistinctLayers,
      cascade0, cascade1, casterLayersWritten, selectedDistinctLayers });
  } catch (error) {
    const scoped = await device.popErrorScope().catch(() => null);
    return Object.freeze({ action: "cascaded-shadow-array-pcf", success: false, cascade0: 0, cascade1: 0,
      casterLayersWritten: false,
      selectedDistinctLayers: false, deviceError: scoped?.message ?? (error instanceof Error ? error.message : String(error)) });
  } finally {
    for (const resource of resources.reverse()) session.release(resource);
  }
}
