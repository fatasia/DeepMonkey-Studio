import type { RenderTargets } from "./renderTargets.js";
import { PBR_HDR_FORMAT, PBR_LINEAR_DEPTH_FORMAT, PBR_MAIN_SAMPLE_COUNT, PBR_MOTION_FORMAT,
  PBR_VIEW_NORMAL_FORMAT } from "./renderTargets.js";
import type { PbrActualPassDescription } from "./pbrFramePlanResources.js";

interface PbrOpaquePassOptions {
  readonly targets: RenderTargets;
  readonly background: readonly [number, number, number];
  readonly writeGeometryBuffers: boolean;
  readonly directDisplayView?: GPUTextureView;
  readonly timestampWrites?: GPURenderPassTimestampWrites;
  readonly drawBackground?: ((pass: GPURenderPassEncoder) => void) | undefined;
}

/** Keeps the render-pass attachments identical to the selected opaque pipeline outputs. */
export function beginPbrOpaquePass(encoder: GPUCommandEncoder,
  options: PbrOpaquePassOptions): GPURenderPassEncoder {
  const { targets } = options;
  const colorAttachments: GPURenderPassColorAttachment[] = [
    { view: options.directDisplayView ?? targets.hdr,
      clearValue: [...options.background, 1], loadOp: "clear", storeOp: "store" },
  ];
  if (options.writeGeometryBuffers) colorAttachments.push(
    { view: targets.linearDepth, clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" },
    { view: targets.normal, clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" },
    { view: targets.motion, clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" },
  );
  const pass = encoder.beginRenderPass({
    label: options.directDisplayView ? "Deep direct display opaque"
      : options.writeGeometryBuffers ? "Deep HDR opaque MRT" : "Deep HDR opaque color",
    ...(options.timestampWrites ? { timestampWrites: options.timestampWrites } : {}),
    colorAttachments,
    depthStencilAttachment: { view: targets.depth, depthClearValue: 1,
      depthLoadOp: "clear", depthStoreOp: "store" },
  });
  options.drawBackground?.(pass);
  return pass;
}

/** 第一切片计划对拍声明(DE26/B03):主 opaque MRT 的实际写集;纯函数,不触 GPU。 */
export function describePbrOpaquePass(): PbrActualPassDescription {
  const geometryWrite = (id: string, format: string): PbrActualPassDescription["claims"][number] => ({
    id, access: "write", format, sampleCount: PBR_MAIN_SAMPLE_COUNT,
    usages: ["render-attachment", "texture-binding"], sizeRole: "surface",
  });
  return {
    passId: "opaque", executor: "beginPbrOpaquePass (PbrRenderer main opaque MRT)", kind: "render",
    reads: [], writes: ["opaque-hdr", "linear-depth", "view-normal", "motion"],
    claims: [geometryWrite("opaque-hdr", PBR_HDR_FORMAT), geometryWrite("linear-depth", PBR_LINEAR_DEPTH_FORMAT),
      geometryWrite("view-normal", PBR_VIEW_NORMAL_FORMAT), geometryWrite("motion", PBR_MOTION_FORMAT)],
    unplannedAttachments: [{ id: "hardware-depth", reason: "主 pass 硬件深度附件(depth32float clear/store),第一切片未入图" }],
    gpuPassCount: 1,
  };
}
