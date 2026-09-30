/// <reference types="@webgpu/types" />
import { CASCADED_SHADOW_UNIFORM_BYTES, CASCADED_SHADOW_WGSL } from "../src/shadows/cascadedShadowShader.js";
import { DEEP_PACKAGE_CSM_WGSL } from "../src/shaderAuthoring/packageAdapterCsm.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";

const DEPTHS = [1, 1.8, 1.9, 2, 2.1, 4, 4.1];

/** Same real CSM functions as production; only fixture bindings and fragment entry differ. */
export async function runJ2CsmBoundaryGpuProbe(nativeSource: string) {
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
  try {
    for (const variant of variants) for (const blendStart of [1.8, 2]) {
      device.pushErrorScope("validation");
      const owned: Array<GPUTexture | GPUBuffer> = [];
      try {
        const depth = device.createTexture({ size: [4, 4, 2], format: "depth32float",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }); owned.push(depth);
        const target = device.createTexture({ size: [DEPTHS.length, 1], format: "rgba32float",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }); owned.push(target);
        const uniform = device.createBuffer({ size: variant.bytes,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); owned.push(uniform);
        const readback = device.createBuffer({ size: 256,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); owned.push(readback);
        const data = new Float32Array(variant.bytes / 4), count = variant.group === 2 ? 8 : 4;
        // Project every receiver to UV center/depth .5; viewDepth remains the test axis.
        const projection = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, .5, 1];
        for (let index = 0; index < count; index++) data.set(projection, index * 16);
        const offset = count * 16;
        data.set(Array.from({ length: count }, (_, index) => index === 0 ? 2 : 4), offset);
        data.set(Array.from({ length: count }, (_, index) => index === 0 ? blendStart : 4), offset + count);
        const params = offset + count * 3;
        data.set([2, 0, .25, 0], params);
        if (variant.group === 0) data.set([0, 0, 1, 0], params + 4);
        device.queue.writeBuffer(uniform, 0, data);
        const code = `${variant.source}
@vertex fn probeVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[index],0,1);
}
@fragment fn probeFragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let depths = array<f32,${DEPTHS.length}>(${DEPTHS.join(",")});
  let depth = depths[u32(position.x)]; let world = vec3f(0,0,depth);
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
            minFilter: "nearest", magFilter: "nearest" }) },
        ] });
        const encoder = device.createCommandEncoder();
        for (const layer of [0, 1]) {
          const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
            view: depth.createView({ dimension: "2d", baseArrayLayer: layer, arrayLayerCount: 1 }),
            depthClearValue: layer === 0 ? .75 : .25, depthLoadOp: "clear", depthStoreOp: "store",
          } }); pass.end();
        }
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(),
          clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store" }] });
        pass.setPipeline(pipeline); pass.setBindGroup(variant.group, binding); pass.draw(3); pass.end();
        encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: 256 }, [DEPTHS.length, 1]);
        device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
        await readback.mapAsync(GPUMapMode.READ);
        const mapped = new Float32Array(readback.getMappedRange());
        const values = DEPTHS.map((_, index) => mapped[index * 4]!); readback.unmap();
        const expected = blendStart === 2 ? [1, 1, 1, 1, 0, 0, 1] : [1, 1, .5, 0, 0, 0, 1];
        const maxError = Math.max(...values.map((value, index) => Math.abs(value - expected[index]!)));
        results.push({ id: variant.id, sourceHash: sha256Utf8(code), libraryHash: sha256Utf8(variant.source),
          blendStart, depths: DEPTHS, values, expected, maxError,
          finite: values.every(Number.isFinite), passed: values.every(Number.isFinite) && maxError < 0.000001 });
      } finally {
        const scoped = await device.popErrorScope(); if (scoped) errors.push(scoped.message);
        for (const resource of owned.reverse()) resource.destroy();
      }
    }
    const info = adapter.info;
    return { scope: "production-csm-functions-webgpu-boundary", adapter: {
      vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
    },
      results, errors, passed: errors.length === 0 && results.every(result => result.passed),
      excluded: ["native-wgpu execution", "full scene image", "linear PCF border filtering", "GPU timing"] };
  } finally { device.destroy(); }
}
