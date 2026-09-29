import { outputShader } from "./pbrShader.js";
import { wgslSourceFingerprint } from "./pipelineCache.js";

export interface SharedOutputPipeline {
  readonly validated: Promise<void>;
  renderPipeline(): Promise<GPURenderPipeline>;
}

const outputPipelines = new WeakMap<GPUDevice, Map<string, SharedOutputPipeline>>();

/** The static and deformation PBR variants use the same HDR output shader and target. */
export function sharedOutputPipeline(device: GPUDevice, format: GPUTextureFormat,
  source: string = outputShader): SharedOutputPipeline {
  // C26:缓存键含 WGSL 源指纹——同一 device/format 下源变更即得到新条目,
  // 不再把旧源编译的陈旧管线返回给新代码(hot reload/测试注入场景)。
  const cacheKey = `${format}\u0000${wgslSourceFingerprint(source)}`;
  let byFormat = outputPipelines.get(device);
  if (!byFormat) { byFormat = new Map(); outputPipelines.set(device, byFormat); }
  const existing = byFormat.get(cacheKey);
  if (existing) return existing;
  const module = device.createShaderModule({ label: "Deep HDR output", code: source });
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
        void created.catch(() => { if (byFormat!.get(cacheKey) === shared) byFormat!.delete(cacheKey); });
      }
      return pipeline;
    },
  };
  byFormat.set(cacheKey, shared);
  void shared.validated.catch(() => { if (byFormat!.get(cacheKey) === shared) byFormat!.delete(cacheKey); });
  return shared;
}
