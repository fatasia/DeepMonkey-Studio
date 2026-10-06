import { RenderGraphBuilder, type RenderGraphCompileResult } from "../renderGraph.js";
import { resolvePbrRendererFeatures, type PbrRendererFeatureOptions } from "./pbrRendererFeatures.js";

export interface PbrFrameGraphOptions {
  readonly transparency: boolean;
  readonly features?: PbrRendererFeatureOptions;
  readonly directDisplay?: boolean;
  readonly writeGeometryBuffers?: boolean;
  readonly godRays?: boolean;
  /** Execution metadata for the negotiated HDR canvas; topology and allocations are unchanged. */
  readonly hdrDisplay?: boolean;
}

/**
 * The production frame contract. GPU deformation, visibility and lighting must feed the same
 * geometry pass; post effects consume its real attachments and current Hi-Z is published for
 * the next frame instead of creating a same-frame depth dependency.
 *
 * Builder factory so the compile plan and the per-pass read/write declarations stay
 * sourced from one graph definition (DE26/B03 execution planning).
 */
export function buildPbrFrameGraph(options: PbrFrameGraphOptions): RenderGraphBuilder {
  const features = resolvePbrRendererFeatures(options.features);
  if (options.directDisplay) return new RenderGraphBuilder()
    .addResource({ id: "surface", descriptor: "swapchain", external: true })
    .addPass({ id: "opaque", kind: "render", outputs: ["surface"] });
  const geometry = options.writeGeometryBuffers ?? true;
  const graph = new RenderGraphBuilder()
    .addResource({ id: "animation-state", descriptor: "scene-animation-v1", external: true })
    .addResource({ id: "lights", descriptor: "clustered-lights-v1", external: true })
    .addResource({ id: "previous-hiz", descriptor: "r32float-mip-chain", external: true })
    .addResource({ id: "deformed-vertices", descriptor: "vertex-storage-v1" })
    .addResource({ id: "visible-draws", descriptor: "indexed-indirect-v1" })
    .addResource({ id: "shadow-atlas", descriptor: "depth32float-array" })
    .addResource({ id: "light-grid", descriptor: "forward-plus-grid-v1" })
    .addResource({ id: "opaque-hdr", descriptor: "rgba16float", aliasKey: "full-rgba16float" })
    .addResource({ id: "linear-depth", descriptor: "r32float" })
    .addResource({ id: "view-normal", descriptor: "rgba8unorm" })
    .addResource({ id: "motion", descriptor: "rg16float" })
    .addResource({ id: "current-hiz", descriptor: "r32float-mip-chain" })
    .addResource({ id: "next-hiz", descriptor: "r32float-mip-chain", external: true })
    .addResource({ id: "surface", descriptor: "swapchain", external: true })
    .addPass({ id: "deform", kind: "compute", inputs: ["animation-state"], outputs: ["deformed-vertices"] })
    .addPass({ id: "visibility", kind: "compute", inputs: ["deformed-vertices", "previous-hiz"], outputs: ["visible-draws"] })
    .addPass({ id: "shadows", kind: "render", inputs: ["visible-draws"], outputs: ["shadow-atlas"] })
    .addPass({ id: "cluster-lights", kind: "compute", inputs: ["lights"], outputs: ["light-grid"] });

  // Brief-GI GI-FIN(2026-10-05)逐 pass 计时登记:features.sdfGi 开启时帧图声明两个
  // sdf-gi compute pass(与 PBR_TIMED_PASS_IDS/MAPPED_EXECUTORS 三文件同切片原子 diff;
  // 关闭 = 拓扑零变化,既有帧 planHash 逐位一致)。资源全部 external:真实分配由
  // SdfGiProductionRuntime 槽位承担(烘焙域 field buffer / 追踪输出 / 96B 记录行),
  // 计划层只声明身份与读写面;声明位置与真实 dispatch 位置一致(主 encoder 上
  // opaque 之前,pbrRendererFrames 的 host.sdfGi.encodeFrame)。records 无图内消费者
  // (主 pass group3 绑定在图外采样)→ external 保持 pass 存活。
  if (features.sdfGi) graph
    .addResource({ id: "sdf-gi-field", descriptor: "sdf-gi-field-buffer-v1", external: true })
    .addResource({ id: "sdf-gi-visibilities", descriptor: "sdf-gi-visibilities-buffer-v1", external: true })
    .addResource({ id: "sdf-gi-hit-distances", descriptor: "sdf-gi-hit-distances-buffer-v1", external: true })
    .addResource({ id: "sdf-gi-records", descriptor: "sdf-gi-records-buffer-v1", external: true })
    .addPass({ id: "sdf-gi-sky-trace", kind: "compute", inputs: ["sdf-gi-field"],
      outputs: ["sdf-gi-visibilities", "sdf-gi-hit-distances"] })
    .addPass({ id: "sdf-gi-probe-update", kind: "compute",
      inputs: ["sdf-gi-visibilities", "sdf-gi-hit-distances"], outputs: ["sdf-gi-records"] });
  const opaquePass = graph
    .addPass({ id: "opaque", kind: "render", inputs: ["visible-draws", "shadow-atlas", "light-grid"],
      outputs: geometry ? ["opaque-hdr", "linear-depth", "view-normal", "motion"] : ["opaque-hdr"] });
  void opaquePass;

  if (features.occlusionCulling && geometry) graph
    .addPass({ id: "build-hiz", kind: "compute", inputs: ["linear-depth"], outputs: ["current-hiz"] })
    .addPass({ id: "publish-hiz", kind: "history", inputs: ["current-hiz"], outputs: ["next-hiz"] });
  if (features.ambientOcclusion) graph
    .addResource({ id: "ao-half", descriptor: "r32float-half" })
    .addResource({ id: "ao-hdr", descriptor: "rgba16float", aliasKey: "full-rgba16float" })
    .addPass({ id: "ambient-occlusion", kind: "compute", inputs: ["linear-depth", "view-normal"], outputs: ["ao-half"] })
    .addPass({ id: "apply-ambient-occlusion", kind: "compute", inputs: ["opaque-hdr", "linear-depth", "view-normal", "ao-half"], outputs: ["ao-hdr"] });

  let temporalInput = features.ambientOcclusion ? "ao-hdr" : "opaque-hdr";
  if (options.transparency) {
    graph
      .addResource({ id: "oit-accumulation", descriptor: "rgba16float" })
      .addResource({ id: "oit-revealage", descriptor: "r16float" })
      .addResource({ id: "composited-hdr", descriptor: "rgba16float", aliasKey: "full-rgba16float" })
      .addPass({ id: "transparent-oit", kind: "render", inputs: ["visible-draws", ...(geometry ? ["linear-depth"] : []), "shadow-atlas", "light-grid"],
        outputs: ["oit-accumulation", "oit-revealage"] })
      .addPass({ id: "composite-oit", kind: "render", inputs: [temporalInput, "oit-accumulation", "oit-revealage"], outputs: ["composited-hdr"] });
    temporalInput = "composited-hdr";
  }
  if (features.volumetricFog) {
    graph.addResource({ id: "volumetric-fog-scatter", descriptor: "rgba16float-half" })
      .addResource({ id: "volumetric-fog-hdr", descriptor: "rgba16float", aliasKey: "full-rgba16float" })
      .addPass({ id: "volumetric-fog-march", kind: "compute", inputs: ["linear-depth", ...(options.godRays ? ["shadow-atlas"] : [])], outputs: ["volumetric-fog-scatter"] })
      .addPass({ id: "volumetric-fog-composite", kind: "compute", inputs: [temporalInput, "volumetric-fog-scatter"], outputs: ["volumetric-fog-hdr"] });
    temporalInput = "volumetric-fog-hdr";
  }
  // P2 SSGI 屏空间漫射一次反弹:插在雾/环境合成之后、SSR 之前(SSR 反射含 GI 的
  // 表面;TAA 在后顺带平滑逐帧旋转采样噪声)。与 PBR_TIMED_PASS_IDS / MAPPED_EXECUTORS /
  // PBR_FRAME_RESOURCE_CONTRACTS / describePasses 同切片原子 diff;关闭 = 拓扑零变化。
  if (features.ssgi) {
    graph.addResource({ id: "ssgi-trace", descriptor: "rgba16float-half" })
      .addResource({ id: "ssgi-hdr", descriptor: "rgba16float" })
      .addPass({ id: "screen-space-gi-trace", kind: "compute", inputs: [temporalInput, "linear-depth", "view-normal"], outputs: ["ssgi-trace"] })
      .addPass({ id: "screen-space-gi-composite", kind: "compute", inputs: [temporalInput, "ssgi-trace"], outputs: ["ssgi-hdr"] });
    temporalInput = "ssgi-hdr";
  }
  // P2 投影纹理光(three r186 ProjectorLight gobo 纹理半部):单 pass 解析直接光加性
  // 层,插在 SSGI 之后、SSR 之前(SSR 命中 UV 采色即携带投影贡献)。与
  // PBR_TIMED_PASS_IDS / MAPPED_EXECUTORS / PBR_FRAME_RESOURCE_CONTRACTS / describePasses
  // 同切片原子 diff;场景未供给投影器时帧逐位零变化,关闭 = 拓扑零变化。
  if (features.projectedTextures) {
    graph.addResource({ id: "projected-texture-hdr", descriptor: "rgba16float", aliasKey: "full-rgba16float" })
      .addPass({ id: "projected-texture-light", kind: "compute",
        inputs: [temporalInput, "linear-depth", "view-normal"], outputs: ["projected-texture-hdr"] });
    temporalInput = "projected-texture-hdr";
  }
  if (features.screenSpaceReflection) {
    graph.addResource({ id: "ssr-trace", descriptor: "rgba16float-half" })
      .addResource({ id: "ssr-hdr", descriptor: "rgba16float" })
      .addPass({ id: "screen-space-reflection-trace", kind: "compute", inputs: [temporalInput, "linear-depth", "view-normal"], outputs: ["ssr-trace"] })
      .addPass({ id: "screen-space-reflection-composite", kind: "compute", inputs: [temporalInput, "ssr-trace"], outputs: ["ssr-hdr"] });
    temporalInput = "ssr-hdr";
  }
  if (features.temporalAa) {
    graph.addResource({ id: "temporal-hdr", descriptor: "rgba16float", aliasKey: "full-rgba16float" })
      .addPass({ id: "temporal-aa", kind: "compute", inputs: [temporalInput, "linear-depth", "motion"], outputs: ["temporal-hdr"] });
    temporalInput = "temporal-hdr";
  }
  if (features.bloom) {
    graph.addResource({ id: "bloom-hdr", descriptor: "rgba16float", aliasKey: "full-rgba16float" })
      .addPass({ id: "bloom", kind: "compute", inputs: [temporalInput], outputs: ["bloom-hdr"] });
    temporalInput = "bloom-hdr";
  }
  if (features.contactShadows) graph
    .addResource({ id: "contact-shadow-mask", descriptor: "rgba16float-half" })
    .addResource({ id: "contact-hdr", descriptor: "rgba16float", aliasKey: "full-rgba16float" })
    .addPass({ id: "contact-shadow", kind: "compute", inputs: ["linear-depth"], outputs: ["contact-shadow-mask"] })
    .addPass({ id: "contact-apply", kind: "compute", inputs: [temporalInput, "contact-shadow-mask"], outputs: ["contact-hdr"] });
  if (features.contactShadows) temporalInput = "contact-hdr";
  // F4 时域上采样:链尾(display 输入)。低分辨率主帧 → 画布全分辨率,替代 surface 直缩拉伸。
  if (features.temporalUpscale) {
    graph.addResource({ id: "upscale-hdr", descriptor: "rgba16float" })
      .addPass({ id: "temporal-upscale", kind: "compute",
        inputs: [temporalInput, "motion", "linear-depth"], outputs: ["upscale-hdr"] });
    temporalInput = "upscale-hdr";
  }
  return graph.addPass({ id: "present", kind: "render", inputs: [temporalInput], outputs: ["surface"] });
}

export function compilePbrFrameGraph(options: PbrFrameGraphOptions): RenderGraphCompileResult {
  // MRT attachments remain written even when their downstream effect is disabled.
  return buildPbrFrameGraph(options).compile({ cullUnusedPasses: options.features !== undefined });
}
