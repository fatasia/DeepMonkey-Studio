/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../src/webgpu/deviceSession.js";
import { SPATIAL_AA_PRESENT_WGSL } from "../src/postprocess/spatialAaWgsl.js";
import { resolveSpatialAaCpu } from "../src/postprocess/spatialAaCpu.js";

export interface SpatialAaProbeCase {
  readonly name: string; readonly width: number; readonly height: number;
  readonly maxCpuGpuError: number; readonly rawRmse: number; readonly aaRmse: number;
  readonly untouchedInterior: boolean; readonly gpuMilliseconds: number | null;
  readonly inputOutputBytes: number;
}
export interface SpatialAaProbeResult { readonly success: boolean; readonly cases: readonly SpatialAaProbeCase[]; readonly resourceDelta: number }
interface Fixture { name: string; width: number; height: number; shift: number; foreground: number; background: number; transparent?: boolean; flat?: boolean }
const fixtures: Fixture[] = [
  { name: "static-diagonal", width: 64, height: 32, shift: 0, foreground: 1, background: 0 },
  { name: "moving-diagonal", width: 64, height: 32, shift: 7, foreground: 1, background: 0 },
  { name: "display-highlight", width: 64, height: 32, shift: 0, foreground: 1, background: .2 },
  { name: "transparent-premultiplied", width: 64, height: 32, shift: 0, foreground: .5, background: 0, transparent: true },
  { name: "portrait-resolution", width: 17, height: 49, shift: 0, foreground: 1, background: 0 },
  { name: "flat-field", width: 37, height: 19, shift: 0, foreground: .4, background: .4, flat: true },
];
const quantize = (value: number) => Math.round(value * 255) / 255;
/** Real render + readback, compared to CPU FXAA and independent 32x32 geometric supersampling. */
export async function runSpatialAaProbe(session: DeviceSession): Promise<SpatialAaProbeResult> {
  if (session.state !== "ready") throw new Error("Spatial AA probe requires a ready session.");
  const startResources = session.resourceCount, device = session.device;
  const owned: Array<GPUTexture | GPUBuffer | GPUQuerySet> = [];
  const own = <T extends GPUTexture | GPUBuffer | GPUQuerySet>(resource: T): T => { owned.push(session.own(resource)); return resource; };
  let scopeOpen = false;
  try {
    device.pushErrorScope("validation"); scopeOpen = true;
    const module = device.createShaderModule({ code: SPATIAL_AA_PRESENT_WGSL, label: "Spatial AA probe" });
    const info = await module.getCompilationInfo();
    if (info.messages.some(message => message.type === "error")) throw new Error(info.messages.map(message => message.message).join("\n"));
    const pipeline = await device.createRenderPipelineAsync({ layout: "auto", vertex: { module, entryPoint: "vertexMain" },
      fragment: { module, entryPoint: "fragmentMain", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } });
    const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    const queries = device.features.has("timestamp-query") ? own(device.createQuerySet({ type: "timestamp", count: 2 })) : undefined;
    const queryBuffer = queries ? own(device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })) : undefined;
    const queryReadback = queries ? own(device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })) : undefined;
    const cases: SpatialAaProbeCase[] = [];
    for (const fixture of fixtures) {
      const { width, height } = fixture, bytesPerRow = Math.ceil(width * 4 / 256) * 256;
      const input = new Uint8Array(bytesPerRow * height), values: number[] = [], reference: number[] = [];
      const inside = (x: number, y: number) => x < .61 * y + width * .16 + fixture.shift;
      const fg = quantize(fixture.foreground), bg = quantize(fixture.background);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const covered = inside(x + .5, y + .5), c = covered ? fg : bg;
        const rgba = [c, c, c, fixture.transparent ? c : 1]; values.push(...rgba);
        input.set(rgba.map(value => Math.round(value * 255)), y * bytesPerRow + x * 4);
        let coverage = 0;
        for (let sy = 0; sy < 32; sy++) for (let sx = 0; sx < 32; sx++) coverage += Number(inside(x + (sx + .5) / 32, y + (sy + .5) / 32)) / 1024;
        reference.push(bg + (fg - bg) * coverage);
      }
      const source = own(device.createTexture({ size: [width, height], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }));
      const output = own(device.createTexture({ size: [width, height], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }));
      const readback = own(device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
      device.queue.writeTexture({ texture: source }, input, { bytesPerRow }, [width, height]);
      const binding = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: source.createView() }, { binding: 1, resource: sampler }] });
      const encoder = device.createCommandEncoder(), pass = encoder.beginRenderPass({
        ...(queries ? { timestampWrites: { querySet: queries, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}),
        colorAttachments: [{ view: output.createView(), loadOp: "clear", storeOp: "store" }] });
      pass.setPipeline(pipeline); pass.setBindGroup(0, binding); pass.draw(3); pass.end();
      encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow }, [width, height]);
      if (queries && queryBuffer && queryReadback) { encoder.resolveQuerySet(queries, 0, 2, queryBuffer, 0); encoder.copyBufferToBuffer(queryBuffer, 0, queryReadback, 0, 16); }
      device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
      await readback.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(readback.getMappedRange()), cpu = resolveSpatialAaCpu({ width, height, color: values });
      let error = 0, rawSquared = 0, aaSquared = 0, interior = true, count = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const p = y * width + x, offset = y * bytesPerRow + x * 4;
        for (let c = 0; c < 4; c++) error = Math.max(error, Math.abs(bytes[offset + c]! / 255 - cpu[p * 4 + c]!));
        if (x > 0 && y > 0 && x < width - 1 && y < height - 1) {
          rawSquared += (values[p * 4]! - reference[p]!) ** 2; aaSquared += (bytes[offset]! / 255 - reference[p]!) ** 2; count++;
          if (fixture.flat || Math.abs(x + .5 - .61 * (y + .5) - width * .16 - fixture.shift) > 2) interior &&= bytes[offset] === input[offset];
        }
      }
      readback.unmap(); let gpuMilliseconds: number | null = null;
      if (queryReadback) { await queryReadback.mapAsync(GPUMapMode.READ); const stamps = new BigUint64Array(queryReadback.getMappedRange());
        gpuMilliseconds = Number(stamps[1]! - stamps[0]!) / 1e6; queryReadback.unmap(); }
      cases.push({ name: fixture.name, width, height, maxCpuGpuError: error, rawRmse: Math.sqrt(rawSquared / count), aaRmse: Math.sqrt(aaSquared / count),
        untouchedInterior: interior, gpuMilliseconds, inputOutputBytes: width * height * 8 });
      for (const resource of [source, output, readback]) session.release(resource);
    }
    scopeOpen = false; const validation = await device.popErrorScope();
    if (validation) throw new Error(validation.message);
    for (const resource of owned) session.release(resource);
    const resourceDelta = session.resourceCount - startResources;
    return { success: resourceDelta === 0 && cases.every(c => c.maxCpuGpuError <= .012 && c.untouchedInterior
      && (c.rawRmse < 1e-6 ? c.aaRmse < 1e-6 : c.aaRmse < c.rawRmse * .87)), cases, resourceDelta };
  } finally {
    for (const resource of owned) session.release(resource);
    if (scopeOpen) await device.popErrorScope();
  }
}
