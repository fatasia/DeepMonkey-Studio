import type { DeviceSession } from "./deviceSession.js";
import {
  SMAA_BLEND_PASS_PRESENT_WGSL, SMAA_EDGE_PASS_PRESENT_WGSL, SMAA_WEIGHTS_PASS_PRESENT_WGSL,
} from "../postprocess/smaaPresentWgsl.js";
import { decodeSmaaAreaLut, decodeSmaaSearchLut } from "../postprocess/smaaLuts.js";

interface Pass { readonly pipeline: GPURenderPipeline; readonly binding: GPUBindGroup }
interface SmaaTargets {
  readonly source: { texture: GPUTexture; view: GPUTextureView };
  readonly edges: { texture: GPUTexture; view: GPUTextureView };
  readonly weights: { texture: GPUTexture; view: GPUTextureView };
}
/** One SMAA 1x (official PRESET_HIGH capability set) three-pass presentation chain:
 * edge detection (rg8) → blend weights (rgba16float, orthogonal+diagonal+corners) →
 * neighborhood blending onto the present target. Allocation/binding is transactional:
 * every owned resource goes through session.own/session.release. */
export class SmaaPasses {
  private readonly linearSampler: GPUSampler;
  private readonly pointSampler: GPUSampler;
  private readonly areaView: GPUTextureView;
  private readonly searchView: GPUTextureView;
  private targets: SmaaTargets | undefined;
  private disposed = false;
  constructor(private readonly session: DeviceSession, private readonly presentFormat: GPUTextureFormat) {
    if (presentFormat !== "rgba8unorm" && presentFormat !== "bgra8unorm") {
      throw new Error("SMAA requires a non-sRGB 8-bit display target.");
    }
    const device = session.device;
    this.linearSampler = device.createSampler({ label: "Deep SMAA linear", minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    this.pointSampler = device.createSampler({ label: "Deep SMAA point", minFilter: "nearest", magFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    const modules = {
      edge: device.createShaderModule({ label: "Deep SMAA edge detection", code: SMAA_EDGE_PASS_PRESENT_WGSL }),
      weights: device.createShaderModule({ label: "Deep SMAA blend weights", code: SMAA_WEIGHTS_PASS_PRESENT_WGSL }),
      blend: device.createShaderModule({ label: "Deep SMAA neighborhood blending", code: SMAA_BLEND_PASS_PRESENT_WGSL }),
    };
    const pipeline = (label: string, module: GPUShaderModule, targets: GPUTextureFormat[]): GPURenderPipeline =>
      device.createRenderPipeline({ label, layout: "auto",
        vertex: { module, entryPoint: "vertexMain" },
        fragment: { module, entryPoint: "fragmentMain", targets: targets.map(format => ({ format })) },
        primitive: { topology: "triangle-list" } });
    this.pipelines = {
      edge: pipeline("Deep SMAA edge pass", modules.edge, ["rg8unorm"]),
      weights: pipeline("Deep SMAA weights pass", modules.weights, ["rgba16float"]),
      blend: pipeline("Deep SMAA blend pass", modules.blend, [presentFormat]),
    };
    // Official v2.8 LUTs (three SMAAPass.js L216/L218 extraction, sha256-pinned in smaaLuts.ts):
    const area = session.own(device.createTexture({ label: "Deep SMAA AreaTex",
      size: [160, 560], format: "rg8unorm", usage: GPUTextureUsage.TEXTURE_BINDING }));
    const search = session.own(device.createTexture({ label: "Deep SMAA SearchTex",
      size: [66, 33], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING }));
    try {
      device.queue.writeTexture({ texture: area }, decodeSmaaAreaLut(),
        { bytesPerRow: 160 * 2, rowsPerImage: 560 }, { width: 160, height: 560 });
      device.queue.writeTexture({ texture: search }, decodeSmaaSearchLut(),
        { bytesPerRow: 66 }, { width: 66, height: 33 });
    } catch (error) {
      this.session.release(area); this.session.release(search);
      throw error;
    }
    this.areaView = area.createView();
    this.searchView = search.createView();
    this.lutTextures = [area, search];
  }
  private readonly pipelines: { edge: GPURenderPipeline; weights: GPURenderPipeline; blend: GPURenderPipeline };
  private readonly lutTextures: GPUTexture[];
  /** Prepares (or reuses) the per-size resources; returns the upstream render target view. */
  prepare(width: number, height: number): GPUTextureView {
    this.assertReady();
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width > this.session.device.limits.maxTextureDimension2D || height > this.session.device.limits.maxTextureDimension2D) {
      throw new Error("Invalid SMAA target dimensions.");
    }
    if (this.targets?.source.texture.width === width && this.targets.source.texture.height === height) {
      return this.targets.source.view;
    }
    this.releaseTargets();
    const device = this.session.device;
    const source = this.session.own(device.createTexture({ label: "Deep display-encoded SMAA input",
      size: [width, height], format: this.presentFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
    const edges = this.session.own(device.createTexture({ label: "Deep SMAA edges",
      size: [width, height], format: "rg8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
    const weights = this.session.own(device.createTexture({ label: "Deep SMAA weights",
      size: [width, height], format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
    const candidates: SmaaTargets = { source: { texture: source, view: source.createView() },
      edges: { texture: edges, view: edges.createView() }, weights: { texture: weights, view: weights.createView() } };
    try {
      const bindings = {
        edge: device.createBindGroup({ layout: this.pipelines.edge.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: candidates.source.view }, { binding: 1, resource: this.linearSampler }] }),
        weights: device.createBindGroup({ layout: this.pipelines.weights.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: candidates.edges.view }, { binding: 1, resource: this.areaView },
            { binding: 2, resource: this.searchView }, { binding: 3, resource: this.linearSampler },
            { binding: 4, resource: this.pointSampler }] }),
        blend: device.createBindGroup({ layout: this.pipelines.blend.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: candidates.source.view }, { binding: 1, resource: candidates.weights.view },
            { binding: 2, resource: this.linearSampler }] }),
      };
      this.targets = candidates;
      this.bindings = bindings;
    } catch (error) {
      this.releaseTextures(candidates);
      throw error;
    }
    return candidates.source.view;
  }
  private bindings: { edge: GPUBindGroup; weights: GPUBindGroup; blend: GPUBindGroup } | undefined;
  /** Encodes the three SMAA passes; `present` receives the blended output. */
  encode(encoder: GPUCommandEncoder, present: GPUTextureView, queries?: GPUQuerySet): void {
    this.assertReady();
    if (!this.targets || !this.bindings) throw new Error("SMAA targets are not prepared.");
    const pass = (label: string, pipeline: GPURenderPipeline, binding: GPUBindGroup,
      colorView: GPUTextureView, timestamp: boolean): GPURenderPassEncoder => {
      const renderPass = encoder.beginRenderPass({ label,
        ...(timestamp && queries ? { timestampWrites: { querySet: queries, endOfPassWriteIndex: 1 } } : {}),
        colorAttachments: [{ view: colorView, loadOp: "clear", storeOp: "store" }] });
      renderPass.setPipeline(pipeline);
      renderPass.setBindGroup(0, binding);
      renderPass.draw(3);
      return renderPass;
    };
    pass("Deep SMAA edge detection", this.pipelines.edge, this.bindings.edge, this.targets.edges.view, false).end();
    pass("Deep SMAA blending weights", this.pipelines.weights, this.bindings.weights, this.targets.weights.view, false).end();
    // Timestamp on the final pass keeps the legacy single-pass timing contract (covers the whole chain).
    pass("Deep SMAA neighborhood blending", this.pipelines.blend, this.bindings.blend, present, true).end();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseTargets();
    for (const texture of this.lutTextures) this.session.release(texture);
  }
  private releaseTextures(targets: SmaaTargets): void {
    this.session.release(targets.source.texture);
    this.session.release(targets.edges.texture);
    this.session.release(targets.weights.texture);
  }
  private releaseTargets(): void {
    const old = this.targets;
    this.targets = undefined;
    this.bindings = undefined;
    if (old) this.releaseTextures(old);
  }
  private assertReady(): void {
    if (this.disposed) throw new Error("SMAA is disposed.");
    if (this.session.state !== "ready") { this.dispose(); throw new Error("SMAA session is not ready."); }
  }
}
