import type { DeviceSession } from "./deviceSession.js";
import { PBR_DEPTH_FORMAT } from "./renderTargets.js";

/**
 * AA-M1 深度 resolve(WGSL 新增,独立文件,stock WGSL 零变化):
 * WebGPU 没有 depth resolveTarget(仅 color 附件支持 resolve),而 depth32float 也
 * 不能作为 storage 写出 —— 1x 硬件深度的唯一还原通路是 depth-only 渲染 pass 里的
 * `@builtin(frag_depth)` 直写。采样 sample-0(中心样本)而非均值:Hi-Z 金字塔、
 * OIT 深度测试、描边遮挡、display 背景深度比较消费的都是"代表性深度",取中心
 * 样本保持数值语义逐位不变(均值会把 0/1 边缘深度插成不存在的中间值,破坏
 * depthCompare "equal" 的背景合成)。仅 MSAA 主通路且主 pass 后仍有深度消费方
 * (Hi-Z/透明/粒子/样条/网格/描边/背景)的帧编码;无消费方帧主 pass 直接
 * depthStoreOp:"discard",本 pass 不运行。
 */
export const PBR_DEPTH_RESOLVE_WGSL = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

@vertex
fn vertex(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var output: VertexOutput;
  let xy = positions[index];
  output.position = vec4<f32>(xy, 0.0, 1.0);
  return output;
}

@group(0) @binding(0) var sourceDepth: texture_depth_multisampled_2d;

@fragment
fn fragment(@builtin(position) position: vec4<f32>) -> @builtin(frag_depth) f32 {
  return textureLoad(sourceDepth, vec2<i32>(position.xy), 0);
}
`;


/** linear-depth(r32float)的 compute resolve:r32float 无硬件 resolve 能力,storage
 * 写出合法;sample-0 fetch 保持与场景写入相同的插值语义(逐像素代表性深度)。
 * 与硬件 resolveTarget 的 rgba16float/rgba8unorm 目标(view-normal/motion/hdr)不同路,
 * 该目标必须在主 pass 内 store 并带 TEXTURE_BINDING。 */
export const PBR_LINEAR_DEPTH_RESOLVE_WGSL = /* wgsl */ `
@group(0) @binding(0) var sourceLinearDepth: texture_multisampled_2d<f32>;
@group(0) @binding(1) var targetLinearDepth: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn resolveLinearDepth(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(targetLinearDepth);
  if (id.x >= size.x || id.y >= size.y) { return; }
  textureStore(targetLinearDepth, vec2<i32>(id.xy), textureLoad(sourceLinearDepth, vec2<i32>(id.xy), 0));
}
`;

/**
 * MSAA 深度还原 pass:管线随 device 生命周期;源视图是 transient 池纹理
 * (resize/epoch 会换实例),bind group 按源视图 WeakMap 缓存,实例更替自动重建。
 */
export class PbrDepthResolvePass {
  private readonly pipeline: GPURenderPipeline;
  private readonly session: DeviceSession;
  private readonly bindGroups = new WeakMap<GPUTextureView, GPUBindGroup>();
  private linearDepthPipeline: GPUComputePipeline | undefined;
  private linearDepthBindGroups: WeakMap<GPUTextureView, { target: GPUTextureView; bindGroup: GPUBindGroup }> | undefined;

  constructor(session: DeviceSession) {
    this.session = session;
    const device = session.device;
    const module = device.createShaderModule({ label: "Deep MSAA depth resolve", code: PBR_DEPTH_RESOLVE_WGSL });
    this.pipeline = device.createRenderPipeline({
      label: "Deep MSAA depth resolve", layout: "auto",
      vertex: { module, entryPoint: "vertex" },
      fragment: { module, entryPoint: "fragment", targets: [] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: PBR_DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "always" },
    });
  }

  /** linear-depth(r32float)compute resolve:同源 WeakMap 缓存。 */
  encodeLinearDepth(encoder: GPUCommandEncoder, source: GPUTextureView, target: GPUTextureView,
    width: number, height: number): void {
    let pass0 = this.linearDepthPipeline;
    if (pass0 === undefined) {
      const device = this.session.device;
      const module = device.createShaderModule({ label: "Deep MSAA linear depth resolve", code: PBR_LINEAR_DEPTH_RESOLVE_WGSL });
      pass0 = device.createComputePipeline({ label: "Deep MSAA linear depth resolve", layout: "auto",
        compute: { module, entryPoint: "resolveLinearDepth" } });
      this.linearDepthPipeline = pass0;
      this.linearDepthBindGroups = new WeakMap();
    }
    // 源/目标都是 transient 池纹理:按 (source→{target,bindGroup}) 缓存,任一实例更替即重建。
    let cached = this.linearDepthBindGroups!.get(source);
    if (cached === undefined || cached.target !== target) {
      cached = { target, bindGroup: this.session.device.createBindGroup({ layout: pass0.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: source }, { binding: 1, resource: target }] }) };
      this.linearDepthBindGroups!.set(source, cached);
    }
    const bindGroup = cached.bindGroup;
    const pass = encoder.beginComputePass({ label: "Deep MSAA linear depth resolve" });
    try {
      pass.setPipeline(pass0); pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    } finally { pass.end(); }
  }

  /** 在主 opaque pass 结束后、任何深度消费 pass 之前编码一次。 */
  encode(encoder: GPUCommandEncoder, source: GPUTextureView, target: GPUTextureView): void {
    let bindGroup = this.bindGroups.get(source);
    if (!bindGroup) {
      bindGroup = this.session.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: source }] });
      this.bindGroups.set(source, bindGroup);
    }
    const pass = encoder.beginRenderPass({ label: "Deep MSAA depth resolve", colorAttachments: [],
      depthStencilAttachment: { view: target, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
    try {
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3);
    } finally { pass.end(); }
  }
}
