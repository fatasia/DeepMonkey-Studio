/// <reference types="@webgpu/types" />
import { CASCADED_SHADOW_UNIFORM_BYTES, CASCADED_SHADOW_WGSL } from "../src/shadows/cascadedShadowShader.js";
import { DEEP_PACKAGE_CSM_WGSL } from "../src/shaderAuthoring/packageAdapterCsm.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { csmBoundaryCases, csmBoundaryPoints, referenceCsmVisibility, type CsmBoundaryFixture } from "./j2CsmBoundaryFixture.js";

const DEPTHS = [1, 1.8, 1.9, 2, 2.1, 4, 4.1];

/** Same real CSM functions as production; only fixture bindings and fragment entry differ. */
export async function runJ2CsmBoundaryGpuProbe(nativeSource: string, fixture?: CsmBoundaryFixture) {
  if (!navigator.gpu) throw Error("WebGPU unavailable");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw Error("GPU adapter unavailable");
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener("uncapturederror", event => errors.push(event.error.message));
  const variants = [
    { id: "ts-built-in", source: CASCADED_SHADOW_WGSL, group: 2, bytes: CASCADED_SHADOW_UNIFORM_BYTES,
      entries: [0, 1, 2], call: "deepCascadedShadow(depth, world, vec3f(0), 1.0)" },
    { id: "ts-deepsl-package", source: `struct ProbeFrame { eye: vec4f };
var<private> deepPbrFrame: ProbeFrame;
@group(0) @binding(1) var deepShadowMap: texture_depth_2d_array;
@group(0) @binding(2) var deepShadowSampler: sampler_comparison;
${DEEP_PACKAGE_CSM_WGSL}`, group: 0, bytes: 336, entries: [7, 1, 2],
      call: "deepShadowVisibility(world, vec3f(0), 1.0)" },
    { id: "native-production-wgsl", source: `struct ProbeFrame { eye: vec4f };
var<private> frame: ProbeFrame;
${nativeSource.slice(0, nativeSource.indexOf("fn local_spot_pcss("))}`, group: 0, bytes: 336,
      entries: [7, 1, 2], call: "shadow_visibility(world, vec3f(0), 1.0)" },
  ];
  if (nativeSource.indexOf("fn local_spot_pcss(") < 0) throw Error("Native CSM source boundary changed");
  const results = [];
  const points = fixture ? csmBoundaryPoints(fixture) : DEPTHS.map(depth => ({ depth, u: .5 }));
  const cases = fixture ? csmBoundaryCases(fixture) : [1.8, 2].map(blendStart => ({ blendStart,
    filter: "nearest" as const, pattern: "constant" as const }));
  const size = fixture?.size ?? 4, readbackBytes = Math.ceil(points.length * 16 / 256) * 256;
  try {
  const writer = device.createShaderModule({ code: `
struct Out { @builtin(position) p: vec4f, @location(0) @interpolate(flat) d: f32 };
@vertex fn v(@builtin(vertex_index) i: u32, @builtin(instance_index) layer: u32) -> Out {
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  var out: Out; out.p = vec4f(p[i],0,1); out.d = select(${fixture?.edgeRightDepths[0] ?? .25},${fixture?.edgeRightDepths[1] ?? .75},layer==1u); return out;
}
@fragment fn f(in: Out) -> @builtin(frag_depth) f32 { return in.d; }` });
  const writerPipeline = fixture ? await device.createRenderPipelineAsync({ layout: "auto", vertex: { module: writer, entryPoint: "v" },
    fragment: { module: writer, entryPoint: "f", targets: [] }, depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" } }) : undefined;
    for (const variant of variants) for (const row of cases) {
      const { blendStart } = row;
      device.pushErrorScope("validation");
      const owned: Array<GPUTexture | GPUBuffer> = [];
      try {
        const depth = device.createTexture({ size: [size, size, 2], format: "depth32float",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }); owned.push(depth);
        const target = device.createTexture({ size: [points.length, 1], format: "rgba32float",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }); owned.push(target);
        const uniform = device.createBuffer({ size: variant.bytes,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); owned.push(uniform);
        const readback = device.createBuffer({ size: readbackBytes,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); owned.push(readback);
        const data = new Float32Array(variant.bytes / 4), count = variant.group === 2 ? 8 : 4;
        // Project every receiver to UV center/depth .5; viewDepth remains the test axis.
        const projection = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, .5, 1];
        for (let index = 0; index < count; index++) data.set(projection, index * 16);
        const offset = count * 16;
        data.set(Array.from({ length: count }, (_, index) => index === 0 ? 2 : 4), offset);
        data.set(Array.from({ length: count }, (_, index) => index === 0 ? blendStart : 4), offset + count);
        const params = offset + count * 3;
        data.set([2, 0, 1 / size, 0], params);
        if (variant.group === 0) data.set([0, 0, 1, 0], params + 4);
        device.queue.writeBuffer(uniform, 0, data);
        const code = `${variant.source}
@vertex fn probeVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[index],0,1);
}
@fragment fn probeFragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let depths = array<f32,${points.length}>(${points.map(point => point.depth).join(",")});
  let us = array<f32,${points.length}>(${points.map(point => point.u).join(",")});
  let pixel = u32(position.x); let depth = depths[pixel]; let world = vec3f(us[pixel]*2.0-1.0,0,depth);
  return vec4f(${variant.call},0,0,1);
}`;
        const module = device.createShaderModule({ code });
        const pipeline = await device.createRenderPipelineAsync({ layout: "auto",
          vertex: { module, entryPoint: "probeVertex" }, primitive: { topology: "triangle-list" },
          fragment: { module, entryPoint: "probeFragment", targets: [{ format: "rgba32float" }] } });
        const binding = device.createBindGroup({ layout: pipeline.getBindGroupLayout(variant.group), entries: [
          { binding: variant.entries[0]!, resource: { buffer: uniform } },
          { binding: variant.entries[1]!, resource: depth.createView({ dimension: "2d-array" }) },
          { binding: variant.entries[2]!, resource: device.createSampler({ compare: "less-equal",
            addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", minFilter: row.filter, magFilter: row.filter }) },
        ] });
        const encoder = device.createCommandEncoder();
        for (const layer of [0, 1]) {
          const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
            view: depth.createView({ dimension: "2d", baseArrayLayer: layer, arrayLayerCount: 1 }),
            depthClearValue: fixture?.clearDepths[layer] ?? (layer === 0 ? .75 : .25), depthLoadOp: "clear", depthStoreOp: "store",
          } });
          if (row.pattern === "edge") { pass.setPipeline(writerPipeline!); pass.setScissorRect(size / 2, 0, size / 2, size); pass.draw(3, 1, 0, layer); }
          pass.end();
        }
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(),
          clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store" }] });
        pass.setPipeline(pipeline); pass.setBindGroup(variant.group, binding); pass.draw(3); pass.end();
        encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: readbackBytes }, [points.length, 1]);
        device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
        await readback.mapAsync(GPUMapMode.READ);
        const mapped = new Float32Array(readback.getMappedRange());
        const values = points.map((_, index) => mapped[index * 4]!); readback.unmap();
        const expected = fixture ? points.map(point => referenceCsmVisibility(fixture, row, point.depth, point.u))
          : blendStart === 2 ? [1, 1, 1, 1, 0, 0, 1] : [1, 1, .5, 0, 0, 0, 1];
        const maxError = Math.max(...values.map((value, index) => Math.abs(value - expected[index]!)));
        results.push({ id: variant.id, sourceHash: sha256Utf8(code), libraryHash: sha256Utf8(variant.source),
          ...row, depths: points.map(point => point.depth), uvXs: points.map(point => point.u), values, expected, maxError,
          finite: values.every(Number.isFinite), passed: values.every(Number.isFinite) && maxError <= (fixture?.maxError ?? 0.000001) });
      } finally {
        const scoped = await device.popErrorScope(); if (scoped) errors.push(scoped.message);
        for (const resource of owned.reverse()) resource.destroy();
      }
    }
    const info = adapter.info;
    return { scope: fixture ? "production-csm-functions-webgpu-linear-edge" : "production-csm-functions-webgpu-boundary", adapter: {
      vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
    },
      results, errors, passed: errors.length === 0 && results.every(result => result.passed),
      excluded: ["native-wgpu execution", "full scene image", ...(fixture ? [] : ["linear PCF border filtering"]), "GPU timing"] };
  } finally { device.destroy(); }
}
