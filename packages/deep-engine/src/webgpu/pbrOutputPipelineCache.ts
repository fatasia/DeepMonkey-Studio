import { outputShader } from "./pbrShader.js";

export interface SharedOutputPipeline {
  readonly validated: Promise<void>;
  renderPipeline(): Promise<GPURenderPipeline>;
}

const outputPipelines = new WeakMap<GPUDevice, Map<GPUTextureFormat, SharedOutputPipeline>>();

/** The static and deformation PBR variants use the same HDR output shader and target. */
export function sharedOutputPipeline(device: GPUDevice, format: GPUTextureFormat): SharedOutputPipeline {
  let byFormat = outputPipelines.get(device);
  if (!byFormat) { byFormat = new Map(); outputPipelines.set(device, byFormat); }
  const existing = byFormat.get(format);
  if (existing) return existing;
  const module = device.createShaderModule({ label: "Deep HDR output", code: outputShader });
  let pipeline: Promise<GPURenderPipeline> | undefined;
  const shared: SharedOutputPipeline = {
    validated: module.getCompilationInfo().then(info => {
      const errors = info.messages.filter(message => message.type === "error");
      if (errors.length) throw new Error(errors.map(message => `WGSL ${message.lineNum}: ${message.message}`).join("\n"));
    }),
    renderPipeline: () => {
      if (!pipeline) {
        const created = device.createRenderPipelineAsync({
          label: "Deep output", layout: "auto", vertex: { module, entryPoint: "vertexMain" },
          fragment: { module, entryPoint: "fragmentMain", targets: [{ format }] },
          primitive: { topology: "triangle-list" },
        });
        pipeline = created;
        void created.catch(() => { if (byFormat!.get(format) === shared) byFormat!.delete(format); });
      }
      return pipeline;
    },
  };
  byFormat.set(format, shared);
  void shared.validated.catch(() => { if (byFormat!.get(format) === shared) byFormat!.delete(format); });
  return shared;
}
