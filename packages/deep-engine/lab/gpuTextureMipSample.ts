/// <reference types="@webgpu/types" />
import type { GpuTextureResidencyHandle } from "@bim-studio/deep-engine/webgpu";

const ROW_BYTES = 256;

export interface TextureMipSample {
  readonly rgba: readonly number[];
  readonly errors: readonly string[];
}

/** Samples one explicit mip through a render pipeline and returns an actual GPU readback. */
export async function sampleTextureMip(device: GPUDevice, texture: GpuTextureResidencyHandle,
  mip: number): Promise<TextureMipSample> {
  if (!Number.isSafeInteger(mip) || mip < 0 || mip >= texture.mipLevelCount) {
    throw new RangeError("Texture mip sample level is out of range.");
  }
  const target = device.createTexture({ label: "Deep mip residency sample target", size: [1, 1],
    format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const readback = device.createBuffer({ label: "Deep mip residency sample readback", size: ROW_BYTES,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  let scopes = 0;
  try {
    for (const filter of ["validation", "out-of-memory", "internal"] as const) {
      device.pushErrorScope(filter); scopes += 1;
    }
    const module = device.createShaderModule({ label: "Deep mip residency sample shader", code: `
      @group(0) @binding(0) var sourceTexture: texture_2d<f32>;
      @group(0) @binding(1) var sourceSampler: sampler;
      @vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
        let positions = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
        return vec4f(positions[index], 0.0, 1.0);
      }
      @fragment fn fragmentMain() -> @location(0) vec4f {
        return textureSampleLevel(sourceTexture, sourceSampler, vec2f(0.5), ${mip}.0);
      }
    ` });
    const pipeline = device.createRenderPipeline({ label: "Deep mip residency sample pipeline", layout: "auto",
      vertex: { module, entryPoint: "vertexMain" }, fragment: { module, entryPoint: "fragmentMain",
        targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } });
    const bindings = device.createBindGroup({ label: "Deep mip residency sample bindings",
      layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: texture.view }, { binding: 1, resource: texture.sampler },
      ] });
    const encoder = device.createCommandEncoder({ label: "Deep mip residency sample commands" });
    const pass = encoder.beginRenderPass({ label: "Deep mip residency sample draw", colorAttachments: [{
      view: target.createView(), clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store",
    }] });
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.draw(3); pass.end();
    encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: ROW_BYTES }, [1, 1]);
    device.queue.submit([encoder.finish()]);
    const checks: Promise<GPUError | null>[] = [];
    while (scopes-- > 0) checks.push(device.popErrorScope());
    await device.queue.onSubmittedWorkDone();
    const errors = (await Promise.all(checks)).filter((error): error is GPUError => error !== null)
      .map(error => error.message);
    if (errors.length) return Object.freeze({ rgba: Object.freeze([]), errors: Object.freeze(errors) });
    await readback.mapAsync(GPUMapMode.READ);
    const rgba = Object.freeze(Array.from(new Uint8Array(readback.getMappedRange(), 0, 4)));
    readback.unmap();
    return Object.freeze({ rgba, errors: Object.freeze(errors) });
  } finally {
    while (scopes-- > 0) { try { await device.popErrorScope(); } catch { /* Cleanup only. */ } }
    target.destroy(); readback.destroy();
  }
}

export function sampledColor(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === 4 && expected.length === 4
    && actual.every((value, index) => Math.abs(value - expected[index]!) <= 3);
}
