import { RenderGraphBuilder, type RenderGraphCompileResult } from "../renderGraph.js";

export interface PbrFrameGraphOptions {
  readonly transparency: boolean;
}

/**
 * The production frame contract. GPU deformation, visibility and lighting must feed the same
 * geometry pass; post effects consume its real attachments and current Hi-Z is published for
 * the next frame instead of creating a same-frame depth dependency.
 */
export function compilePbrFrameGraph(options: PbrFrameGraphOptions): RenderGraphCompileResult {
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
    .addResource({ id: "ao-half", descriptor: "r32float-half" })
    .addResource({ id: "ao-hdr", descriptor: "rgba16float", aliasKey: "full-rgba16float" })
    .addResource({ id: "temporal-hdr", descriptor: "rgba16float", aliasKey: "full-rgba16float" })
    .addResource({ id: "bloom-hdr", descriptor: "rgba16float", aliasKey: "full-rgba16float" })
    .addResource({ id: "surface", descriptor: "swapchain", external: true })
    .addPass({ id: "deform", kind: "compute", inputs: ["animation-state"], outputs: ["deformed-vertices"] })
    .addPass({ id: "visibility", kind: "compute", inputs: ["deformed-vertices", "previous-hiz"], outputs: ["visible-draws"] })
    .addPass({ id: "shadows", kind: "render", inputs: ["visible-draws"], outputs: ["shadow-atlas"] })
    .addPass({ id: "cluster-lights", kind: "compute", inputs: ["lights"], outputs: ["light-grid"] })
    .addPass({ id: "opaque", kind: "render", inputs: ["visible-draws", "shadow-atlas", "light-grid"],
      outputs: ["opaque-hdr", "linear-depth", "view-normal", "motion"] })
    .addPass({ id: "build-hiz", kind: "compute", inputs: ["linear-depth"], outputs: ["current-hiz"] })
    .addPass({ id: "publish-hiz", kind: "history", inputs: ["current-hiz"], outputs: ["next-hiz"] })
    .addPass({ id: "ambient-occlusion", kind: "compute", inputs: ["linear-depth", "view-normal"], outputs: ["ao-half"] })
    .addPass({ id: "apply-ambient-occlusion", kind: "compute", inputs: ["opaque-hdr", "linear-depth", "ao-half"], outputs: ["ao-hdr"] });

  let temporalInput = "ao-hdr";
  if (options.transparency) {
    graph
      .addResource({ id: "oit-accumulation", descriptor: "rgba16float" })
      .addResource({ id: "oit-revealage", descriptor: "r16float" })
      .addResource({ id: "composited-hdr", descriptor: "rgba16float", aliasKey: "full-rgba16float" })
      .addPass({ id: "transparent-oit", kind: "render", inputs: ["visible-draws", "linear-depth", "shadow-atlas", "light-grid"],
        outputs: ["oit-accumulation", "oit-revealage"] })
      .addPass({ id: "composite-oit", kind: "render", inputs: ["ao-hdr", "oit-accumulation", "oit-revealage"], outputs: ["composited-hdr"] });
    temporalInput = "composited-hdr";
  }
  return graph
    .addPass({ id: "temporal-aa", kind: "compute", inputs: [temporalInput, "linear-depth", "motion"], outputs: ["temporal-hdr"] })
    .addPass({ id: "bloom", kind: "compute", inputs: ["temporal-hdr"], outputs: ["bloom-hdr"] })
    .addPass({ id: "present", kind: "render", inputs: ["bloom-hdr"], outputs: ["surface"] })
    .compile();
}
