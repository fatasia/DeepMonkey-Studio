import type { RenderTargets } from "./renderTargets.js";
import { PBR_HDR_FORMAT, PBR_LINEAR_DEPTH_FORMAT, PBR_MOTION_FORMAT,
  PBR_VIEW_NORMAL_FORMAT } from "./renderTargets.js";
import type { PbrActualPassDescription } from "./pbrFramePlanResources.js";

interface PbrOpaquePassOptions {
  readonly targets: RenderTargets;
  readonly background: readonly [number, number, number];
  readonly writeGeometryBuffers: boolean;
  readonly directDisplayView?: GPUTextureView;
  readonly timestampWrites?: GPURenderPassTimestampWrites;
  readonly drawBackground?: ((pass: GPURenderPassEncoder) => void) | undefined;
  /**
   * AA-M1:MSAA 主通路下主 pass 后是否仍有硬件深度消费方(Hi-Z/透明/粒子/样条/
   * 网格/描边/display 背景)。true → depthStoreOp "store" 并随后编码深度 resolve
   * pass;false → "discard",MSAA 深度随 pass 丢弃,零还原成本。1x 渲染器忽略
   * (既有 "store" 语义,直显帧的 display 背景仍依赖深度)。
   */
  readonly depthConsumedAfterPass?: boolean;
}

/** Keeps the render-pass attachments identical to the selected opaque pipeline outputs. */
export function beginPbrOpaquePass(encoder: GPUCommandEncoder,
  options: PbrOpaquePassOptions): GPURenderPassEncoder {
  const { targets } = options;
  // AA-M1:MSAA 主通路(directDisplay 之外的 HDR 帧)在 MSAA 附件上渲染,颜色经
  // resolveTarget 硬件下采样到单采样主帧目标;深度无法 resolve(WebGPU 无 depth
  // resolveTarget),由 depthStoreOp 策略 + PbrDepthResolvePass 承接。管线采样数
  // 由构造期 sampleCount 保证与附件一致。
  const msaa = options.directDisplayView === undefined && targets.msaaActive;
  // MSAA 附件 storeOp 恒 "discard":内容只经 resolveTarget 离开 pass(TRANSIENT
  // 附件语义要求不存储多采样面,驱动可省一次全量写回);"store" 在 resolve 存在时
  // 只会写回无人读取的采样面。
  const colorStoreOp: GPURenderPassColorAttachment["storeOp"] = msaa ? "discard" : "store";
  const colorAttachments: GPURenderPassColorAttachment[] = [
    { view: msaa ? targets.hdrMsaa! : options.directDisplayView ?? targets.hdr,
      ...(msaa ? { resolveTarget: targets.hdr } : {}),
      clearValue: [...options.background, 1], loadOp: "clear", storeOp: colorStoreOp },
  ];
  if (options.writeGeometryBuffers) colorAttachments.push(
    { view: msaa ? targets.linearDepthMsaa! : targets.linearDepth,
      // r32float 无硬件 resolve:内容由 linear-depth compute resolve(sample-0)还原,
      // 附件本体必须 store 且不带 resolveTarget。
      ...(msaa ? {} : {}),
      clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" },
    { view: msaa ? targets.normalMsaa! : targets.normal,
      ...(msaa ? { resolveTarget: targets.normal } : {}),
      clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: colorStoreOp },
    { view: msaa ? targets.motionMsaa! : targets.motion,
      ...(msaa ? { resolveTarget: targets.motion } : {}),
      clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: colorStoreOp },
  );
  const depthStoreOp = msaa && !options.depthConsumedAfterPass ? "discard" as const : "store" as const;
  const pass = encoder.beginRenderPass({
    label: options.directDisplayView ? "Deep direct display opaque"
      : options.writeGeometryBuffers ? "Deep HDR opaque MRT" : "Deep HDR opaque color",
    ...(options.timestampWrites ? { timestampWrites: options.timestampWrites } : {}),
    colorAttachments,
    depthStencilAttachment: { view: msaa ? targets.depthMsaa! : targets.depth, depthClearValue: 1,
      depthLoadOp: "clear", depthStoreOp },
  });
  options.drawBackground?.(pass);
  return pass;
}

/** 第一切片计划对拍声明(DE26/B03):主 opaque MRT 的实际写集;纯函数,不触 GPU。
 *  合同声明的是单采样"主帧目标"(AA-M1 起 = MSAA 的 resolve 产物);MSAA 附件与
 *  深度 resolve pass 是图外实现事实,按 unplannedAttachments 显式登记。 */
export function describePbrOpaquePass(options: { readonly directDisplay?: boolean; readonly writeGeometryBuffers?: boolean;
  readonly msaa?: boolean; readonly depthResolved?: boolean } = {}): PbrActualPassDescription {
  const geometryWrite = (id: string, format: string): PbrActualPassDescription["claims"][number] => ({
    id, access: "write", format, sampleCount: 1,
    // linear-depth 与 opaque-hdr 同带 COPY_SRC：R12 白名单诊断快照读回（与 renderTargets 创建一致）。
    usages: id === "opaque-hdr"
      ? ["render-attachment", "texture-binding", "storage-binding", "copy-src"]
      : id === "linear-depth"
        ? ["render-attachment", "texture-binding", "copy-src", "storage-binding"]
        : ["render-attachment", "texture-binding"], sizeRole: "surface",
  });
  const msaa = options.msaa === true;
  const msaaAttachments: PbrActualPassDescription["unplannedAttachments"] = [
    ...(options.directDisplay ? [] : [{
      id: "opaque-hdr-msaa", reason: "AA-M1 主 pass MSAA 颜色附件(RENDER_ATTACHMENT,经 resolveTarget 下采样)",
    }]),
    ...(options.writeGeometryBuffers === false || options.directDisplay ? [] : [
      { id: "linear-depth-msaa", reason: "AA-M1 主 pass MSAA 附件;render pass 采样数一致性要求存在,内容只经 resolve 产出" },
      { id: "view-normal-msaa", reason: "AA-M1 主 pass MSAA 附件;附属目标默认 1x 消费,附件仅 pass 内存在" },
      { id: "motion-msaa", reason: "AA-M1 主 pass MSAA 附件;TAA 消费单采样 resolve 产物" },
    ]),
    { id: "hardware-depth-msaa", reason: "AA-M1 MSAA 硬件深度;无 resolveTarget,由深度 resolve pass(sample-0)还原" },
    ...(options.depthResolved ? [{
      id: "depth-resolve-pass", reason: "depth-only frag_depth 渲染 pass,把 MSAA 深度还原到 1x 主帧深度",
    }] : []),
  ];
  return {
    passId: "opaque", executor: "beginPbrOpaquePass (PbrRenderer main opaque MRT)", kind: "render",
    reads: [], writes: options.directDisplay ? ["surface"] : options.writeGeometryBuffers === false
      ? ["opaque-hdr"] : ["opaque-hdr", "linear-depth", "view-normal", "motion"],
    claims: options.directDisplay ? [{ id: "surface", access: "write", format: "swapchain", sampleCount: 1,
      usages: ["render-attachment"], sizeRole: "independent" }] : [geometryWrite("opaque-hdr", PBR_HDR_FORMAT),
      ...(options.writeGeometryBuffers === false ? [] : [geometryWrite("linear-depth", PBR_LINEAR_DEPTH_FORMAT),
        geometryWrite("view-normal", PBR_VIEW_NORMAL_FORMAT), geometryWrite("motion", PBR_MOTION_FORMAT)])],
    unplannedAttachments: msaa ? msaaAttachments
      : [{ id: "hardware-depth", reason: "主 pass 硬件深度附件(depth32float clear/store),第一切片未入图" }],
    gpuPassCount: msaa && options.depthResolved ? 2 : 1,
  };
}
