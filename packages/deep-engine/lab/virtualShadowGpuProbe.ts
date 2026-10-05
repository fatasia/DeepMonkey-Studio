// B1 Brief-VSM 真机验收探针入口(sourceSizeGate 拆分,2026-10-04:自 1029 行单文件按职责
// 分文件,代码逐行同源仅改可见性,语义零变化;本文件保留 runner 合同入口——
// virtual-shadow-gpu.mjs / vsm-liveness.mjs / vsm-resolve-diag.mjs 以 esbuild entryPoints
// 打包本文件并在页内 import("/probe.mjs") 消费具名导出,入口路径与导出面保持不变)。
//
// 场景合同与验收映射(①锯齿能量 ≤0.40 ②Δp50 ≤2.5ms ③动态延迟 ≤2 帧 ④零洞):
//   场景构建 + 能量度量 → virtualShadowProbeScene.ts(PROBE 常量/VIEW·VIEW_FAR/
//     buildProbeScene/buildDeviceUpdate/snapshotToLuma/edgeAliasingEnergy/holeCheck/
//     meanAbsDiff/frameDistance/LumaField/ShadowEdgeStats);
//   腿会话与结果合同 → virtualShadowProbeSession.ts(SETTLE/TIMING/FEATURES 常量、
//     active/activeView 单例状态、setActiveView/beginLeg/settleLeg/timeLeg/captureStill/
//     dynamicLatencyLeg/finishLeg/ProbeLegResult/ShadowBandField;诊断模块经 getActiveLeg
//     读取同一份状态,不复制);
//   诊断安装与资源转储 → virtualShadowProbeDiag.ts(installPipelineTracing/
//     installErrorCapture/drainCapturedErrors/probeAdapterInfo/probeDeviceRequest/
//     dumpShadowAtlasLayer/dumpVirtualShadowResidency/dumpShadowPageTable);
//   M2 虚拟解析重放 → virtualShadowProbeResolveDiag.ts(VirtualResolveSample/diagVirtualResolve);
//   M2 带采样策略对分 → virtualShadowProbeBandDiag.ts(VirtualBandSample/VirtualBandReport/
//     diagVirtualBand)。
export {
  PROBE_HEIGHT,
  PROBE_WIDTH,
  buildDeviceUpdate,
  buildProbeScene,
  edgeAliasingEnergy,
  frameDistance,
  holeCheck,
  meanAbsDiff,
  snapshotToLuma,
  VIEW_FAR,
} from "./virtualShadowProbeScene.js";
export type {
  LumaField,
  ShadowEdgeStats,
} from "./virtualShadowProbeScene.js";
export {
  beginLeg,
  captureStill,
  dynamicLatencyLeg,
  finishLeg,
  setActiveView,
  settleLeg,
  timeLeg,
} from "./virtualShadowProbeSession.js";
export type {
  ProbeLegResult,
  ShadowBandField,
} from "./virtualShadowProbeSession.js";
export {
  drainCapturedErrors,
  dumpShadowAtlasLayer,
  dumpShadowPageTable,
  dumpVirtualShadowResidency,
  installErrorCapture,
  installPipelineTracing,
  probeAdapterInfo,
  probeDeviceRequest,
} from "./virtualShadowProbeDiag.js";
export {
  diagVirtualResolve,
} from "./virtualShadowProbeResolveDiag.js";
export type {
  VirtualResolveSample,
} from "./virtualShadowProbeResolveDiag.js";
export {
  diagVirtualBand,
} from "./virtualShadowProbeBandDiag.js";
export type {
  VirtualBandReport,
  VirtualBandSample,
} from "./virtualShadowProbeBandDiag.js";
