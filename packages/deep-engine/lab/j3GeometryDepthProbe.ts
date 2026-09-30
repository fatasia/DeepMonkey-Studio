/// <reference types="@webgpu/types" />
import { PbrRenderer, type PbrRendererOptions, type RenderView } from "../src/webgpu/pbrRenderer.js";
import { materializeRuntimeRenderPacket } from "../src/runtimePackage/renderPacket.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { sceneShader } from "../src/webgpu/pbrShader.js";
interface Camera { id: string; eye: readonly [number, number, number]; target: readonly [number, number, number];
  up: readonly [number, number, number]; verticalFovRadians: number; near: number; far: number }
interface Manifest { packageHash: string; packetHash: string; width: number; height: number; cameras: Camera[] }
interface HdrManifest extends Manifest { sun: { surfaceToLightWorld: readonly [number, number, number];
  radiance: readonly [number, number, number]; intensity: number; exposure: number } }
interface Package { packageHash: { value: string }; entrypoints: { renderPacket: string }; payloads: Record<string, unknown> }
const options: PbrRendererOptions = { shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 128 } },
  features: { environment: false, groundPlane: false, groundGrid: false, ambientOcclusion: false,
    temporalAa: false, occlusionCulling: false, bloom: false, vignette: false, fog: false } };

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Error("Production geometry operation timed out")), 30000);
  })]); } finally { clearTimeout(timer); }
}

async function readFrame(renderer: PbrRenderer, width: number, height: number, captureHdr = false) {
  const observed = renderer as unknown as { targets: { hdrTexture: GPUTexture; depthTexture: GPUTexture }; frameData: Float32Array;
    mainBindings: { diffuseData: Float32Array } };
  const device = renderer.session.device, bytes = width * height * 16;
  const storage = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const read = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const module = device.createShaderModule({ code: `
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${width}u || id.y >= ${height}u) { return; }
  result[id.y * ${width}u + id.x] = vec4f(textureLoad(hdr, vec2i(id.xy), 0).rgb, textureLoad(depth, vec2i(id.xy), 0));
}` });
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: observed.targets.hdrTexture.createView() },
      { binding: 1, resource: observed.targets.depthTexture.createView({ aspect: "depth-only" }) },
      { binding: 2, resource: { buffer: storage } },
    ] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end();
    encoder.copyBufferToBuffer(storage, 0, read, 0, bytes); device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(read.getMappedRange()).slice(); read.unmap();
    if (!values.every(Number.isFinite)) throw Error("Non-finite actual geometry attachments");
    const depth = [], hdr = [], background = values.slice(0, 3); let hdrNonBackground = 0;
    if (values[3]! < 1 - 1e-7) throw Error("Geometry fixture corner depth must be the far-plane clear");
    if (background.some(value => Math.abs(value) > .001)) throw Error("Geometry fixture corner must be black background");
    for (let pixel = 0; pixel < width * height; pixel++) {
      depth.push(values[pixel * 4 + 3]!);
      if (captureHdr) hdr.push(...values.slice(pixel * 4, pixel * 4 + 3));
      if (background.some((clear, lane) => Math.abs(values[pixel * 4 + lane]! - clear) > .001)) hdrNonBackground++;
    }
    if (hdrNonBackground <= 32) throw Error("Empty actual geometry HDR frame");
    const frame = observed.frameData;
    return { depth, depthSamples: 1, vp: Array.from(frame.slice(0, 16)), hdrNonBackground,
      ...(captureHdr ? { hdr, lighting: { direction: Array.from(frame.slice(76, 79)), radiance: Array.from(frame.slice(84, 87)),
        intensity: frame[87], environment: frame[67], shadows: frame[71], exposure: frame[88],
        diffuseCoefficients: Array.from(observed.mainBindings.diffuseData) } } : {}) };
  } finally { read.destroy(); storage.destroy(); }
}

export async function runJ3GeometryDepthProbe(canvas: HTMLCanvasElement, manifest: Manifest, source: Package,
  observe?: (cameraId: string, round: number) => Promise<void>, hdrManifest?: HdrManifest) {
  const payload = source.payloads[source.entrypoints.renderPacket], packetHash = sha256Utf8(JSON.stringify(payload));
  if (source.packageHash.value !== manifest.packageHash || packetHash !== manifest.packetHash) throw Error("Geometry source manifest mismatch");
  const packet = materializeRuntimeRenderPacket(payload, "$.geometryPacket"), abort = new AbortController();
  const renderer = await bounded(PbrRenderer.create(canvas, navigator.gpu, abort.signal, options));
  type Frame = Awaited<ReturnType<typeof readFrame>> & { cameraId: string; round: number };
  const frames: Frame[] = [], defaults: Frame[] = [];
  try {
    await bounded(renderer.setPacketValidated(packet, abort.signal));
    for (const profile of hdrManifest ? ["default", "common"] : ["geometry"]) {
    for (const camera of manifest.cameras) for (let round = 0; round < (profile === "default" ? 1 : 2); round++) {
      const view: RenderView = { ...camera, width: manifest.width, height: manifest.height, pixelRatio: 1,
        extent: 8, background: [0, 0, 0], floor: [0, 0, 0], exposure: 1, roughness: .8,
        ...(profile === "common" && hdrManifest ? { lights: { directional: [{
          directionWorld: hdrManifest.sun.surfaceToLightWorld.map(value => -value) as unknown as readonly [number, number, number],
          color: hdrManifest.sun.radiance, intensity: hdrManifest.sun.intensity, castShadow: false,
        }], points: [], spots: [], areas: [], ambient: [], hemisphere: [] }, fog: null, environmentIntensity: 0 } : {}) };
      const metrics = await bounded(renderer.validateFrame(view));
      if (metrics.drawCalls < 1 || metrics.triangles < 1) throw Error("No actual production geometry draws");
      (profile === "default" ? defaults : frames).push({ cameraId: camera.id, round,
        ...(hdrManifest ? { localLightCount: metrics.lightCount } : {}),
        ...await bounded(readFrame(renderer, manifest.width, manifest.height, hdrManifest !== undefined)) });
      await observe?.(camera.id, round);
    }
    }
    return { host: "webgpu-production-pbr", packageHash: manifest.packageHash, packetHash,
      width: manifest.width, height: manifest.height, frames, passed: true,
      ...(hdrManifest ? { defaults, profile: "same-authored-sun", sourceHash: sha256Utf8(sceneShader),
        normalAttachment: "absent; geometry buffers disabled" } : {}) };
  } finally { abort.abort(); renderer.dispose(); }
}
