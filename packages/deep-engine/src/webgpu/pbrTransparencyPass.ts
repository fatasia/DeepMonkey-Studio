import type { DeviceSession } from "./deviceSession.js";
import type { PbrActualPassDescription } from "./pbrFramePlanResources.js";
import { PBR_HDR_FORMAT, pbrFullHdrTransientUsage } from "./renderTargets.js";
import { WeightedOitPass } from "./weightedOit.js";
import { WEIGHTED_OIT_ACCUMULATION_FORMAT, WEIGHTED_OIT_REVEALAGE_FORMAT } from "./weightedOitTypes.js";
import { runResourceCleanup } from "./resourceCleanup.js";
import type { PbrTransientTextureHandle, PbrTransientTexturePool } from "./pbrTransientTexturePool.js";

interface DrawStats { readonly drawCalls: number; readonly triangles: number }
interface TransparencyInput {
  readonly encoder: GPUCommandEncoder;
  readonly opaqueColor: GPUTexture;
  readonly hdrColor: GPUTexture;
  readonly hdrView: GPUTextureView;
  readonly depthView: GPUTextureView;
  readonly viewOf: (texture: GPUTexture) => GPUTextureView;
  readonly draw: (pass: GPURenderPassEncoder) => DrawStats;
}

/** 管理透明合成目标；AO 关闭时不能读写同一张 HDR 纹理。 */
export class PbrTransparencyPass {
  private readonly oit: WeightedOitPass;
  private scratch: { texture: GPUTexture; view: GPUTextureView; pooled?: PbrTransientTextureHandle } | undefined;
  private disposed = false;
  private output: GPUTexture | undefined;

  constructor(private readonly session: DeviceSession, private readonly pool?: PbrTransientTexturePool) {
    this.oit = new WeightedOitPass(session, pool);
  }

  get currentColor(): GPUTexture | undefined {
    return !this.disposed && this.session.state === "ready" ? this.output : undefined;
  }

  encode(input: TransparencyInput): DrawStats & { readonly color: GPUTexture } {
    if (this.disposed) throw new Error("PBR transparency pass is disposed.");
    if (this.session.state !== "ready") {
      this.dispose(); throw new Error("GPU session is not ready for PBR transparency.");
    }
    this.output = undefined;
    const { encoder, hdrColor, opaqueColor } = input;
    this.oit.resize(hdrColor.width, hdrColor.height);
    try {
      const destination = opaqueColor === hdrColor ? this.scratchTarget(hdrColor.width, hdrColor.height)
        : { texture: hdrColor, view: input.hdrView };
      const pass = encoder.beginRenderPass({ label: "Deep weighted OIT accumulation",
        colorAttachments: this.oit.accumulationAttachments(),
        depthStencilAttachment: { view: input.depthView, depthLoadOp: "load", depthStoreOp: "discard" } });
      let stats: DrawStats;
      try { stats = input.draw(pass); } finally { pass.end(); }
      this.oit.encodeComposite(encoder, input.viewOf(opaqueColor), destination.view, { outputFormat: PBR_HDR_FORMAT });
      this.output = destination.texture;
      return { color: destination.texture, drawCalls: stats.drawCalls + 1, triangles: stats.triangles + 1 };
    } finally { this.releaseTransientFrame(); }
  }

  /** 第一切片计划对拍声明(DE26/B03):OIT 累积与合成两个 render pass 的实际读写;纯静态,不触 GPU。 */
  static describePasses(opaqueColorResource = "ao-hdr"): readonly PbrActualPassDescription[] {
    const oitTargets = (id: string, format: string): PbrActualPassDescription["claims"][number] => ({
      id, access: "write", format, sampleCount: 1,
      usages: ["render-attachment", "texture-binding", "copy-src"], sizeRole: "surface",
    });
    return [
      {
        passId: "transparent-oit", executor: "PbrTransparencyPass.encode → WeightedOitPass accumulation", kind: "render",
        reads: [], writes: ["oit-accumulation", "oit-revealage"],
        claims: [oitTargets("oit-accumulation", WEIGHTED_OIT_ACCUMULATION_FORMAT),
          oitTargets("oit-revealage", WEIGHTED_OIT_REVEALAGE_FORMAT)],
        unplannedAttachments: [{ id: "hardware-depth", reason: "透明绘制复用主 pass 硬件深度(load/discard),第一切片未入图" }],
        gpuPassCount: 1,
      }, {
        passId: "composite-oit", executor: "PbrTransparencyPass.encode → WeightedOitPass.encodeComposite", kind: "render",
        reads: [opaqueColorResource, "oit-accumulation", "oit-revealage"], writes: ["composited-hdr"],
        claims: [{ id: opaqueColorResource, access: "read", format: PBR_HDR_FORMAT, sampleCount: 1,
          usages: opaqueColorResource === "opaque-hdr" ? ["render-attachment", "texture-binding", "storage-binding", "copy-src"]
            : ["storage-binding", "texture-binding", "render-attachment", "copy-src"], sizeRole: "surface" },
          { id: "oit-accumulation", access: "read", format: WEIGHTED_OIT_ACCUMULATION_FORMAT, sampleCount: 1,
            usages: ["render-attachment", "texture-binding", "copy-src"], sizeRole: "surface" },
          { id: "oit-revealage", access: "read", format: WEIGHTED_OIT_REVEALAGE_FORMAT, sampleCount: 1,
            usages: ["render-attachment", "texture-binding", "copy-src"], sizeRole: "surface" },
          { id: "composited-hdr", access: "write", format: PBR_HDR_FORMAT, sampleCount: 1,
            usages: ["render-attachment", "texture-binding", "storage-binding", "copy-src"], sizeRole: "surface" }],
        gpuPassCount: 1,
      },
    ];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.output = undefined;
    const scratch = this.scratch;
    this.scratch = undefined;
    runResourceCleanup("PBR transparency disposal failed.", [
      () => { if (scratch && !scratch.pooled) this.session.release(scratch.texture); }, () => this.oit.dispose(),
    ]);
  }

  private scratchTarget(width: number, height: number): { texture: GPUTexture; view: GPUTextureView } {
    if (this.pool) {
      const pooled = this.pool.acquire({ resourceId: "composited-hdr", format: PBR_HDR_FORMAT, width, height, sampleCount: 1,
        usage: pbrFullHdrTransientUsage() });
      this.scratch = { texture: pooled.texture, view: pooled.view, pooled }; return this.scratch;
    }
    if (this.scratch?.texture.width === width && this.scratch.texture.height === height) return this.scratch;
    const texture = this.session.own(this.session.device.createTexture({ label: "Deep OIT composite HDR",
      size: { width, height }, format: PBR_HDR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
    let view: GPUTextureView;
    try { view = texture.createView(); } catch (error) { this.session.release(texture); throw error; }
    const previous = this.scratch;
    this.scratch = { texture, view };
    if (previous) this.session.release(previous.texture);
    return this.scratch;
  }

  private releaseTransientFrame(): void {
    if (!this.pool) return;
    const scratch = this.scratch; this.scratch = undefined;
    runResourceCleanup("PBR transparency transient release failed.", [
      () => { if (scratch?.pooled) this.pool!.release(scratch.pooled); }, () => this.oit.releaseFrame(),
    ]);
  }
}
