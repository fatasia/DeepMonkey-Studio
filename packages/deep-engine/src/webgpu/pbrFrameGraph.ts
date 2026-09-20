import { RenderGraphBuilder, type RenderGraphCompileResult } from "../renderGraph.js";
import { resolvePbrRendererFeatures, type PbrRendererFeatureOptions } from "./pbrRendererFeatures.js";

export interface PbrFrameGraphOptions {
  readonly transparency: boolean;
  readonly features?: PbrRendererFeatureOptions;
  readonly directDisplay?: boolean;
  readonly writeGeometryBuffers?: boolean;
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
    .addPass({ id: "cluster-lights", kind: "compute", inputs: ["lights"], outputs: ["light-grid"] })
    .addPass({ id: "opaque", kind: "render", inputs: ["visible-draws", "shadow-atlas", "light-grid"],
      outputs: geometry ? ["opaque-hdr", "linear-depth", "view-normal", "motion"] : ["opaque-hdr"] });
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
  return graph.addPass({ id: "present", kind: "render", inputs: [temporalInput], outputs: ["surface"] });
}

export function compilePbrFrameGraph(options: PbrFrameGraphOptions): RenderGraphCompileResult {
  // MRT attachments remain written even when their downstream effect is disabled.
  return buildPbrFrameGraph(options).compile({ cullUnusedPasses: options.features !== undefined });
}
