/// <reference types="@webgpu/types" />
/**
 * G1-S1 真机 GPU 探针（scripts/clusterLodCadGpuTest.mjs 驱动，headless Chrome + WebGPU；
 * 模式沿用 clusterLodGpuTest/clusterLodDrawProbe 先例）。与旁路重建不同：本探针在真实设备上
 * 驱动**产品槽位类本体**（ClusterLodRenderSlot），链路 = 静态 CAD 夹具 → bakeClusterLodDag →
 * slot stage → GPU select_cluster_lod → slot 读回 → planClusterLodIndirect →
 * ClusterLodIndirectExecutor 命令/RenderBundle → render pass executeBundles → 像素读回。
 * 槽位管线与 PBR 帧签名同格式（PBR_HDR_FORMAT + PBR_DEPTH_FORMAT），探针 pass 附件逐字对应。
 * Node 侧用同一 bundle 的 CPU 参考（selectClusterLod/rasterizeSilhouetteMask/measure…）仲裁。
 */

import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { ClusterLodRenderSlot, type ClusterLodSceneStaging, type ClusterLodSlotMetrics,
} from "../src/webgpu/clusterLodRenderSlot.js";
import { bakeClusterLodDag } from "../src/rayTracing/clusterLodBake.js";
import { selectClusterLod } from "../src/rayTracing/clusterLodSelection.js";
import { PBR_DEPTH_FORMAT, PBR_HDR_FORMAT } from "../src/webgpu/renderTargets.js";
import { buildClusterLodCadCameraCases, buildClusterLodCadGeometry, CLUSTER_LOD_CAD_VIEWPORT,
  type ClusterLodCadCameraCase } from "../src/webgpu/clusterLodCadFixture.js";

export { bakeClusterLodDag } from "../src/rayTracing/clusterLodBake.js";
export { selectClusterLod } from "../src/rayTracing/clusterLodSelection.js";
export { deriveClusterLodFrontier, planClusterLodIndirect } from "../src/rayTracing/clusterLodIndirectPlan.js";
export { rasterizeSilhouetteMask, measureSilhouetteDeviation } from "../src/rayTracing/clusterLodSilhouette.js";
export { buildClusterLodCadGeometry, buildClusterLodCadCameraCases, CLUSTER_LOD_CAD_VIEWPORT,
} from "../src/webgpu/clusterLodCadFixture.js";

export interface ClusterLodCadCase {
  readonly stage: ClusterLodSceneStaging;
  readonly cameras: readonly ClusterLodCadCameraCase[];
}

/** 单一来源案例：Node（CPU 仲裁）与浏览器（真机腿）共用同一构建，防口径分叉。 */
export function buildClusterLodCadCase(): ClusterLodCadCase {
  const geometry = buildClusterLodCadGeometry();
  const baked = bakeClusterLodDag({ geometryId: "cluster-lod-cad-flange-gpu", vertices: geometry.vertices,
    indices: geometry.indices, level0ClusterSize: 128, levelCount: 3 });
  return { stage: { dag: baked.dag, levelGeometry: baked.levelGeometry },
    cameras: buildClusterLodCadCameraCases() };
}

export interface ClusterLodCadCameraEvidence {
  readonly label: string;
  readonly metrics: ClusterLodSlotMetrics;
  /** GPU 读回选层槽位（与 dag.nodes 同序 u32），Node 侧与 CPU 参考逐位对拍。 */
  readonly selectionBase64: string;
  readonly frontierNodeIds: readonly string[];
  readonly coveredPixels: number;
  readonly totalPixels: number;
  /** 剪影掩码（行主序 1bit/px）base64；由 GPU 像素读回阈值化。 */
  readonly maskBitsBase64: string;
}

export interface ClusterLodCadProbeResult {
  readonly adapter: Readonly<Record<string, string>>;
  readonly cases: readonly ClusterLodCadCameraEvidence[];
  readonly clearOnlyCoveredPixels: number;
  /** 静止相机 20 帧均值（encode+draw+submit，CPU 墙钟 ms；bundle/命令全复用路径）。 */
  readonly staticFrameCpuMs: number;
  /** 动相机单步均值（encode+submit+ingest 读回派生，CPU 墙钟 ms）。 */
  readonly selectionStepCpuMs: number;
  readonly errors: readonly string[];
  readonly sessionDiagnostics: readonly { readonly kind: string; readonly message: string }[];
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

/** 浏览器腿：真实设备上驱动产品槽位类完成整链，返回逐相机证据。 */
export async function runClusterLodCadProbe(): Promise<ClusterLodCadProbeResult> {
  if (!navigator.gpu) throw new Error("navigator.gpu unavailable.");
  const canvas = document.createElement("canvas");
  canvas.width = CLUSTER_LOD_CAD_VIEWPORT;
  canvas.height = CLUSTER_LOD_CAD_VIEWPORT;
  document.body.append(canvas);
  const session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  const errors: string[] = [];
  session.device.addEventListener?.("uncapturederror", (event) => {
    errors.push((event as GPUUncapturedErrorEvent).error.message);
  });
  const caseSpec = buildClusterLodCadCase();
  const slot = ClusterLodRenderSlot.create(session, caseSpec.stage);
  const owned: Array<GPUBuffer | GPUTexture> = [];
  const own = <T extends GPUBuffer | GPUTexture>(resource: T): T => { owned.push(session.own(resource)); return resource; };
  const device = session.device;
  const side = CLUSTER_LOD_CAD_VIEWPORT, rowBytes = side * 8;
  const target = own(device.createTexture({ label: "Deep cluster LOD CAD probe target",
    size: [side, side, 1], format: PBR_HDR_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }));
  const depth = own(device.createTexture({ label: "Deep cluster LOD CAD probe depth",
    size: [side, side, 1], format: PBR_DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT }));
  const readback = own(device.createBuffer({ label: "Deep cluster LOD CAD probe readback",
    size: rowBytes * side, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  const openPass = (encoder: GPUCommandEncoder, draw: (pass: GPURenderPassEncoder) => void): void => {
    const pass = encoder.beginRenderPass({ label: "Deep cluster LOD CAD probe",
      colorAttachments: [{ view: target.createView(), clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store" }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
    draw(pass);
    pass.end();
  };
  const renderAndReadPixels = async (draw: (pass: GPURenderPassEncoder) => void): Promise<Uint16Array> => {
    device.pushErrorScope("validation");
    const encoder = device.createCommandEncoder({ label: "Deep cluster LOD CAD probe" });
    openPass(encoder, draw);
    encoder.copyTextureToBuffer({ texture: target },
      { buffer: readback, bytesPerRow: rowBytes, rowsPerImage: side }, [side, side, 1]);
    device.queue.submit([encoder.finish()]);
    const validationError = await device.popErrorScope();
    if (validationError) throw new Error(`Cluster LOD CAD probe GPU validation failed: ${validationError.message}`);
    await readback.mapAsync(GPUMapMode.READ);
    try {
      return new Uint16Array(new Uint8Array(readback.getMappedRange() as ArrayBuffer).slice().buffer);
    } finally {
      readback.unmap();
    }
  };
  const evidenceFrom = (pixels: Uint16Array): { covered: number; maskBits: Uint8Array } => {
    const total = side * side, covered = new Uint8Array(total);
    let count = 0;
    for (let index = 0; index < total; index++) {
      if (pixels[index * 4] !== 0) { covered[index] = 1; count += 1; }
    }
    const maskBits = new Uint8Array(Math.ceil(total / 8));
    for (let index = 0; index < total; index++) {
      if (covered[index]) maskBits[index >> 3]! |= 1 << (index & 7);
    }
    return { covered: count, maskBits };
  };
  try {
    // 空白对照：仅 clear 不绘制，覆盖像素必须为 0 —— 防读回垃圾被误判成“已绘制”。
    const clearPixels = await renderAndReadPixels(() => {});
    const clearOnlyCoveredPixels = evidenceFrom(clearPixels).covered;
    if (clearOnlyCoveredPixels !== 0) throw new Error(`Cluster LOD CAD probe clear-only readback is dirty: ${clearOnlyCoveredPixels}`);
    const cases: ClusterLodCadCameraEvidence[] = [];
    for (const cameraCase of caseSpec.cameras) {
      slot.updateCamera(cameraCase.camera);
      slot.setViewProjection(cameraCase.viewProjection);
      // 帧 A：派发选层（warming 不绘制）；submit 后同步等待读回，bundle 就绪。
      device.pushErrorScope("validation");
      const warm = device.createCommandEncoder({ label: "Deep cluster LOD CAD probe warm" });
      slot.encodeFrame(warm);
      openPass(warm, () => {});
      device.queue.submit([warm.finish()]);
      const warmError = await device.popErrorScope();
      if (warmError) throw new Error(`Cluster LOD CAD probe warm validation failed: ${warmError.message}`);
      await slot.ingest();
      if (slot.hasFallback()) throw new Error(`Cluster LOD CAD probe slot fell back: ${slot.metrics().fallbackReason}`);
      // 帧 B：静止相机 → encodeFrame 跳过，bundle 真机 drawIndexedIndirect + 像素读回。
      const pixels = await renderAndReadPixels((pass) => { slot.draw(pass); });
      const { covered, maskBits } = evidenceFrom(pixels);
      const evidence = slot.lastSelectionEvidence();
      if (!evidence) throw new Error("Cluster LOD CAD probe missing selection evidence after ingest.");
      cases.push({ label: cameraCase.label, metrics: slot.metrics(),
        selectionBase64: toBase64(new Uint8Array(evidence.selection.buffer, evidence.selection.byteOffset, evidence.selection.byteLength)),
        frontierNodeIds: [...evidence.frontierNodeIds], coveredPixels: covered,
        totalPixels: side * side, maskBitsBase64: toBase64(maskBits) });
    }
    // 静止相机 20 帧均值（纯 CPU 编码成本，bundle/命令复用路径）。
    const cameraCase = caseSpec.cameras[0]!;
    const staticStart = performance.now();
    for (let frame = 0; frame < 20; frame++) {
      const encoder = device.createCommandEncoder({ label: "Deep cluster LOD CAD probe static" });
      slot.encodeFrame(encoder);
      openPass(encoder, (pass) => { slot.draw(pass); });
      device.queue.submit([encoder.finish()]);
    }
    const staticFrameCpuMs = (performance.now() - staticStart) / 20;
    // 动相机 10 步均值（含读回与命令派生的一次完整闭环）。
    const orbitStart = performance.now();
    for (let step = 0; step < 10; step++) {
      const angle = step * 0.02;
      slot.updateCamera({ ...cameraCase.camera, forward: [
        cameraCase.camera.forward[0] * Math.cos(angle) - cameraCase.camera.forward[2] * Math.sin(angle),
        cameraCase.camera.forward[1],
        cameraCase.camera.forward[0] * Math.sin(angle) + cameraCase.camera.forward[2] * Math.cos(angle)] });
      const encoder = device.createCommandEncoder({ label: "Deep cluster LOD CAD probe orbit" });
      slot.encodeFrame(encoder);
      openPass(encoder, (pass) => { slot.draw(pass); });
      device.queue.submit([encoder.finish()]);
      await slot.ingest();
      if (slot.hasFallback()) throw new Error(`Cluster LOD CAD probe slot fell back during orbit: ${slot.metrics().fallbackReason}`);
    }
    const selectionStepCpuMs = (performance.now() - orbitStart) / 10;
    const info = session.adapterInfo;
    return { adapter: { vendor: info?.vendor ?? "", architecture: info?.architecture ?? "",
      device: info?.device ?? "", description: info?.description ?? "" },
      cases, clearOnlyCoveredPixels, staticFrameCpuMs, selectionStepCpuMs,
      errors, sessionDiagnostics: session.diagnostics };
  } finally {
    slot.dispose();
    for (const resource of owned.reverse()) session.release(resource);
    session.dispose();
    canvas.remove();
  }
}
