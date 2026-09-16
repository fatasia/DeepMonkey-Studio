import type { DeviceSession } from "./deviceSession.js";
import type { StudioEnvironment } from "./studioEnvironment.js";
import type { PbrFrameUniformView } from "./pbrFrameUniforms.js";
import { PBR_PANORAMA_WGSL, packPanoramaBackground } from "./pbrPanoramaBackground.js";
import { PBR_DEPTH_FORMAT, PBR_MAIN_SAMPLE_COUNT, PBR_OPAQUE_ATTACHMENT_FORMATS } from "./renderTargets.js";
import { uploadBuffer } from "./meshBuffers.js";

/** The panorama is drawn before geometry in linear HDR, without writing depth. */
export class PbrBackgroundPass {
  private readonly pipeline: GPURenderPipeline;
  private readonly uniform: GPUBuffer;
  private binding: GPUBindGroup | undefined;
  private panorama: StudioEnvironment["panorama"];

  constructor(private readonly session: DeviceSession, writeGeometryBuffers: boolean) {
    const device = session.device;
    const module = device.createShaderModule({ label: "Deep panorama background", code: PBR_PANORAMA_WGSL });
    this.pipeline = device.createRenderPipeline({ label: "Deep HDR panorama", layout: "auto",
      vertex: { module, entryPoint: "vertex" },
      fragment: { module, entryPoint: writeGeometryBuffers ? "mrt" : "color",
        targets: PBR_OPAQUE_ATTACHMENT_FORMATS.slice(0, writeGeometryBuffers ? 4 : 1).map(format => ({ format })) },
      primitive: { topology: "triangle-list" }, multisample: { count: PBR_MAIN_SAMPLE_COUNT },
      depthStencil: { format: PBR_DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: "always" },
    });
    this.uniform = uploadBuffer(session, "Deep panorama view", new Float32Array(24), GPUBufferUsage.UNIFORM);
  }

  prepare(view: PbrFrameUniformView, environment: StudioEnvironment, aspect: number): (pass: GPURenderPassEncoder) => void {
    if (!view.panoramaBackground || !environment.panorama) throw new Error("Panorama background requires a staged HDR background source.");
    const data = packPanoramaBackground(view, view.panoramaBackground, aspect);
    if (this.panorama !== environment.panorama) {
      const binding = this.session.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: environment.panorama.view },
        { binding: 2, resource: environment.panorama.sampler },
      ] });
      this.panorama = environment.panorama; this.binding = binding;
    }
    this.session.device.queue.writeBuffer(this.uniform, 0, data);
    return pass => { pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.binding!); pass.draw(3); };
  }
}
