import type { DeviceSession } from "./deviceSession.js";
import { PBR_DEPTH_FORMAT, PBR_HDR_FORMAT } from "./renderTargets.js";
import { authorGridUniforms, prepareAuthorGridTexture, type AuthorGridView } from "./authorGridTypes.js";
import type { DecodedTexture } from "../textures/decodedTexture.js";
import { packPbrFog } from "./pbrFog.js";

export const AUTHOR_GRID_WGSL = `struct Settings { matrix: mat4x4f, color: vec4f, modelView: mat4x4f, fogColor: vec4f, fogParameters: vec4f };
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var image: texture_2d<f32>;
@group(0) @binding(2) var filtering: sampler;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f, @location(1) depth: f32 };
@vertex fn vs(@builtin(vertex_index) i: u32) -> Vertex {
  let uv = array<vec2f, 6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1))[i];
  var out: Vertex; out.position = settings.matrix * vec4f(uv - 0.5, 0, 1); out.uv = vec2f(uv.x, 1-uv.y);
  out.depth = -(settings.modelView * vec4f(uv - 0.5, 0, 1)).z; return out;
}
@fragment fn fs(in: Vertex) -> @location(0) vec4f {
  let sampled = textureSample(image, filtering, in.uv) * settings.color;
  var fog = 0.0;
  if (settings.fogColor.w == 1) { fog = smoothstep(settings.fogParameters.x, settings.fogParameters.y, in.depth); }
  if (settings.fogColor.w == 2) { let d = in.depth * settings.fogParameters.z; fog = 1-exp(-d*d); }
  return vec4f(mix(sampled.rgb, settings.fogColor.rgb, fog) * sampled.a, sampled.a);
}`;

/** Grid contributes color before transparency/output; never writes or replaces scene depth. */
export class AuthorGridResources {
  private pipeline?: GPURenderPipeline;
  private uniform?: GPUBuffer;
  private texture?: GPUTexture;
  private binding: GPUBindGroup | undefined;
  private source: DecodedTexture | undefined;
  private disposed = false;
  constructor(private readonly session: DeviceSession) {}
  encode(encoder: GPUCommandEncoder, color: GPUTextureView, depth: GPUTextureView,
    viewProjection: ArrayLike<number>, worldToView: ArrayLike<number>, view?: AuthorGridView): number {
    if (this.disposed || this.session.state !== "ready") throw new Error("Author grid device is unavailable.");
    if (!view) return 0;
    const uniforms = new Float32Array(44);
    uniforms.set(authorGridUniforms(view, viewProjection));
    uniforms.set(authorGridUniforms(view, worldToView).subarray(0, 16), 20);
    uniforms.set(packPbrFog(view.fog ?? null), 36);
    if (!this.pipeline) {
      const module = this.session.device.createShaderModule({ label: "Deep author grid", code: AUTHOR_GRID_WGSL });
      const pipeline = this.session.device.createRenderPipeline({ label: "Deep author grid", layout: "auto",
        vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: PBR_HDR_FORMAT,
          blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: PBR_DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: "less-equal" } });
      const uniform = this.session.own(this.session.device.createBuffer({ label: "Deep author grid transform", size: 176,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
      this.pipeline = pipeline; this.uniform = uniform;
    }
    if (this.source !== view.texture) this.upload(view.texture);
    this.session.device.queue.writeBuffer(this.uniform!, 0, uniforms);
    const pass = encoder.beginRenderPass({ label: "Deep authored grid HDR", colorAttachments: [{ view: color, loadOp: "load", storeOp: "store" }],
      depthStencilAttachment: { view: depth, depthReadOnly: true } });
    try { pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.binding!); pass.draw(6); } finally { pass.end(); }
    return 2;
  }
  private upload(source: DecodedTexture): void {
    const prepared = prepareAuthorGridTexture(source), device = this.session.device;
    const texture = this.session.own(device.createTexture({ label: "Deep author grid texture", format: prepared.format,
      size: [source.width, source.height], mipLevelCount: prepared.levels.length, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }));
    try {
      for (const [level, mip] of prepared.levels.entries()) device.queue.writeTexture({ texture, mipLevel: level }, mip.data,
        { bytesPerRow: mip.bytesPerRow }, [mip.width, mip.height]);
      const sampler = device.createSampler(prepared.sampler);
      const binding = device.createBindGroup({ layout: this.pipeline!.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.uniform! } }, { binding: 1, resource: texture.createView() }, { binding: 2, resource: sampler }] });
      const old = this.texture; this.texture = texture; this.binding = binding; this.source = source;
      if (old) this.session.release(old);
    } catch (error) { this.session.release(texture); throw error; }
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    if (this.texture) this.session.release(this.texture);
    if (this.uniform) this.session.release(this.uniform);
    this.source = undefined; this.binding = undefined;
  }
}
