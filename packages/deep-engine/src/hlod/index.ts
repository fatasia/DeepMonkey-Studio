export { HLOD_ALGORITHM_VERSION, HLOD_CLUSTER_DEFAULTS, HLOD_DECISION_DEFAULTS, HlodError } from "./hlodTypes.js";
export type {
  HlodCell,
  HlodClusterConfiguration,
  HlodClusterDecision,
  HlodClusterNode,
  HlodClusterOptions,
  HlodClusterStats,
  HlodClusterTree,
  HlodDecisionConfiguration,
  HlodDecisionOptions,
  HlodErrorCode,
  HlodFrameDecision,
  HlodInstanceInput,
  HlodTreeChangeSet,
  HlodTreeDelta,
} from "./hlodTypes.js";
export type { ClusterLodCamera } from "../rayTracing/clusterLodSelection.js";
export {
  buildHlodTree,
  contentHash64,
  enclosingSphere,
  resolveHlodClusterOptions,
  validateHlodInstances,
} from "./hlodCluster.js";
export { decideHlodCluster, decideHlodFrame, hlodScreenErrorPixels, resolveHlodDecisionOptions } from "./hlodDecision.js";
export { updateHlodTree } from "./hlodIncremental.js";
export { HLOD_PROXY_ALGORITHM_VERSION, HLOD_PROXY_DEFAULTS } from "./hlodProxyTypes.js";
export type {
  HlodInstanceShape,
  HlodProxyBudgetEvidence,
  HlodProxyConfiguration,
  HlodProxyErrorMetrics,
  HlodProxyMesh,
  HlodProxyOptions,
  HlodProxyResult,
} from "./hlodProxyTypes.js";
export {
  compareShape,
  generateClusterProxyGeometry,
  resolveHlodProxyOptions,
  validateHlodShapes,
} from "./hlodProxyGeometry.js";
export { boxesFromProxyMesh, distancePointToBox, measureHlodProxyError } from "./hlodProxyMetrics.js";
export type { HlodProxyBatch, HlodProxyBatchEntry, HlodProxyBatchOptions, HlodProxyBatchTotals } from "./hlodProxyBatch.js";
export { generateHlodClusterProxies, generateHlodProxiesForFrame } from "./hlodProxyBatch.js";
export { decodeHlodProxyGeometries, encodeHlodProxyGeometries } from "./hlodProxyBinary.js";

export * from "./hlodPackageTypes.js";
export { parseHlodPackageManifest, serializeHlodPackageManifest, validateHlodPackageManifest, hlodTreeFromManifest } from "./hlodPackageManifest.js";
