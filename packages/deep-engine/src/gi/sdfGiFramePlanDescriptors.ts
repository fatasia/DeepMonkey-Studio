import type { PbrActualPassDescription, PbrPassResourceClaim } from "../webgpu/pbrFramePlanResources.js";

/**
 * Brief-GI GI-FIN(2026-10-05)计划对拍声明(收尾补齐):帧图(pbrFrameGraph)把
 * sdf-gi 两个 compute pass 经 MAPPED_EXECUTORS 登记为 mapped 后,plan/actual 对拍
 * (diffPlanAgainstActual)要求每个 mapped pass 都有实际执行描述 —— GI-FIN 提交的
 * 三文件原子 diff 漏了第四处(collectActualPbrFramePasses 组装侧),导致任何
 * features.sdfGi 渲染帧在 captureForFrame 的 assertPlanMatchesActual 处抛错
 * (真机像素探针 sdf-gi-m3-gpu.mjs 首帧即暴露)。本文件按真实编码序
 * (SdfGiProductionRuntime.encodeFrame,主 encoder 上 opaque 之前,
 * pbrRendererFrames host.sdfGi 分支)补齐两条纯数据描述,不触 GPU、不改渲染行为。
 *
 * claims 合同(sdfGiPacking 单源):四个 sdf-gi 资源在 PBR_FRAME_RESOURCE_CONTRACTS
 * 全部 external 且无纹理格式(format undefined)—— 计划侧 plannedResources 把
 * format 降级为 descriptor 相等,故 claim.format 填 descriptor 字符串逐字对拍;
 * usages 空集(纯 storage buffer,无纹理绑定面)、sizeRole independent(不入尺寸表)。
 */

/** buffer 资源 claim:format 取合同 descriptor(= `${id}-buffer-v1`,计划侧 ?? 兜底口径),usages 空集。 */
const bufferClaim = (id: string, access: "read" | "write"): PbrPassResourceClaim =>
  ({ id, access, format: `${id}-buffer-v1`, sampleCount: 1, usages: [], sizeRole: "independent" });

/** 天光圆锥追踪 dispatch 的实际描述:读距离场,写可见度 + 命中距离两路输出。 */
export function describeSdfGiSkyTracePass(): PbrActualPassDescription {
  return {
    passId: "sdf-gi-sky-trace",
    executor: "SdfGiProductionRuntime.encodeFrame (sky visibility trace dispatch)",
    kind: "compute",
    reads: ["sdf-gi-field"],
    writes: ["sdf-gi-visibilities", "sdf-gi-hit-distances"],
    claims: [bufferClaim("sdf-gi-field", "read"), bufferClaim("sdf-gi-visibilities", "write"),
      bufferClaim("sdf-gi-hit-distances", "write")],
    gpuPassCount: 1,
  };
}

/** 探针 SH 更新 dispatch 的实际描述:读可见度+命中距离,归约写 96B 记录行(vec4[1].xy 含 GI-FIN 统计)。 */
export function describeSdfGiProbeUpdatePass(): PbrActualPassDescription {
  return {
    passId: "sdf-gi-probe-update",
    executor: "SdfGiProductionRuntime.encodeFrame (probe SH update dispatch)",
    kind: "compute",
    reads: ["sdf-gi-visibilities", "sdf-gi-hit-distances"],
    writes: ["sdf-gi-records"],
    claims: [bufferClaim("sdf-gi-visibilities", "read"), bufferClaim("sdf-gi-hit-distances", "read"),
      bufferClaim("sdf-gi-records", "write")],
    gpuPassCount: 1,
  };
}
