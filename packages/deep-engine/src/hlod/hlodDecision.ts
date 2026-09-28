/**
 * T26 HLOD 代理决策模型(纯函数,可单测)。
 *
 * == 决策规则(单一定义;屏幕误差公式复用 clusterLodSelection 的 CPU 参考) ==
 *   depth       = max(dot(center − camPos, forward), MIN_VIEW_DEPTH)   ← clusterScreenError 内置
 *   screenError = geometricError × viewportHeightPixels / (2 × depth × tanHalfFovY)
 *   geometricError = 簇包围球半径(聚合代理替换子树的最坏几何偏差的保守界)
 *   叶(level 0)恒渲染实例;内节点 screenError ≤ targetPixelError → 整簇折叠为聚合代理。
 *   迟滞:上一帧已折叠的簇在 screenError ≤ targetPixelError × (1 + hysteresisRatio)
 *   内保持折叠(防阈值抖动);下钻方向始终用严格阈值。
 *
 * 阈值显式:targetPixelError(默认 8px)与 hysteresisRatio(默认 0.12,与
 * packetBoundsHlod 同源)都是决策合同的必显参数;违反取值域 fail-closed。
 * 视锥/遮挡闭合不在此层(与 T11 可见闭包联动留联测)。
 */

import {
  clusterScreenError,
  type ClusterLodCamera,
} from "../rayTracing/clusterLodSelection.js";
import {
  HLOD_DECISION_DEFAULTS,
  HlodError,
  type HlodClusterDecision,
  type HlodClusterNode,
  type HlodClusterTree,
  type HlodDecisionConfiguration,
  type HlodDecisionOptions,
  type HlodFrameDecision,
} from "./hlodTypes.js";

export function resolveHlodDecisionOptions(options: HlodDecisionOptions = {}): HlodDecisionConfiguration {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new HlodError("invalid-options", "HLOD decision options must be an object.");
  }
  const targetPixelError = options.targetPixelError ?? HLOD_DECISION_DEFAULTS.targetPixelError;
  const hysteresisRatio = options.hysteresisRatio ?? HLOD_DECISION_DEFAULTS.hysteresisRatio;
  if (!Number.isFinite(targetPixelError) || targetPixelError <= 0) {
    throw new HlodError("invalid-options", "HLOD targetPixelError must be finite and positive.");
  }
  if (!Number.isFinite(hysteresisRatio) || hysteresisRatio < 0 || hysteresisRatio > 0.49) {
    throw new HlodError("invalid-options", "HLOD hysteresisRatio must be finite in [0, 0.49].");
  }
  return Object.freeze({ targetPixelError, hysteresisRatio });
}

/** 单节点屏幕误差(像素)= 簇半径的投影。与 clusterScreenError 同式,这里只做形状适配。 */
export function hlodScreenErrorPixels(node: HlodClusterNode, camera: ClusterLodCamera): number {
  return clusterScreenError({
    boundsMin: [node.center[0] - node.radius, node.center[1] - node.radius, node.center[2] - node.radius],
    boundsMax: [node.center[0] + node.radius, node.center[1] + node.radius, node.center[2] + node.radius],
    error: node.radius,
  }, camera);
}

/** 单簇决策(公式化核心,单测直击):叶恒渲染;内节点按阈值(+迟滞)折叠。 */
export function decideHlodCluster(node: HlodClusterNode, camera: ClusterLodCamera,
  options: HlodDecisionConfiguration, wasCollapsed = false): HlodClusterDecision {
  const screenErrorPixels = hlodScreenErrorPixels(node, camera);
  if (node.children.length === 0) {
    return Object.freeze({ nodeId: node.id, level: node.level, screenErrorPixels,
      collapsed: false, heldByHysteresis: false });
  }
  const heldByHysteresis = wasCollapsed
    && options.hysteresisRatio > 0
    && screenErrorPixels <= options.targetPixelError * (1 + options.hysteresisRatio);
  const collapsed = screenErrorPixels <= options.targetPixelError || heldByHysteresis;
  return Object.freeze({ nodeId: node.id, level: node.level, screenErrorPixels,
    collapsed, heldByHysteresis });
}

/**
 * 一帧决策:从根下钻,折叠即停(子树不访问,代价 O(展开前沿));输出 id 升序,
 * 与遍历序解耦——同输入逐位同结果。
 */
export function decideHlodFrame(tree: HlodClusterTree, camera: ClusterLodCamera,
  options: HlodDecisionOptions = {}, previousCollapsed?: ReadonlySet<string>): HlodFrameDecision {
  const config = resolveHlodDecisionOptions(options);
  validateCamera(camera);
  const collapsedNodes: HlodClusterDecision[] = [];
  const renderedLeaves: string[] = [];
  let visitedNodes = 0;
  const visit = (node: HlodClusterNode): void => {
    visitedNodes += 1;
    const decision = decideHlodCluster(node, camera, config, previousCollapsed?.has(node.id) ?? false);
    if (node.children.length === 0) {
      renderedLeaves.push(node.id);
      return;
    }
    if (decision.collapsed) {
      collapsedNodes.push(decision);
      return;
    }
    for (const childId of node.children) {
      const child = tree.nodes.get(childId);
      if (!child) throw new HlodError("unknown-node", `HLOD tree node ${node.id} references unknown child ${childId}.`);
      visit(child);
    }
  };
  if (tree.rootId !== null) {
    const root = tree.nodes.get(tree.rootId);
    if (!root) throw new HlodError("unknown-node", `HLOD tree root ${tree.rootId} is missing.`);
    visit(root);
  }
  collapsedNodes.sort((left, right) => compareText(left.nodeId, right.nodeId));
  renderedLeaves.sort(compareText);
  const hiddenInstances = collapsedNodes.reduce((sum, decision) =>
    sum + (tree.nodes.get(decision.nodeId)?.instanceCount ?? 0), 0);
  const total = tree.stats.leafCount;
  return Object.freeze({
    collapsedNodes: Object.freeze(collapsedNodes),
    renderedLeaves: Object.freeze(renderedLeaves),
    renderedInstances: renderedLeaves.length,
    hiddenInstances,
    visitedNodes,
    proxyCoverage: total === 0 ? 0 : hiddenInstances / total,
  });
}

/** 决策结果只依赖 (树内容, 相机, 选项, 上一帧折叠集)——供增量/回放一致性断言。 */
function validateCamera(camera: ClusterLodCamera): void {
  if (!camera || typeof camera !== "object") throw new HlodError("invalid-camera", "HLOD decision camera must be an object.");
  const finite = (value: number): boolean => Number.isFinite(value);
  if (!Array.isArray(camera.position) || camera.position.length !== 3 || !camera.position.every(finite)
    || !Array.isArray(camera.forward) || camera.forward.length !== 3 || !camera.forward.every(finite)) {
    throw new HlodError("invalid-camera", "HLOD decision camera position/forward must be 3 finite numbers.");
  }
  if (Math.hypot(camera.forward[0], camera.forward[1], camera.forward[2]) === 0) {
    throw new HlodError("invalid-camera", "HLOD decision camera forward must be nonzero.");
  }
  if (!finite(camera.viewportHeightPixels) || camera.viewportHeightPixels <= 0
    || !finite(camera.tanHalfFovY) || camera.tanHalfFovY <= 0
    || !finite(camera.pixelThreshold) || camera.pixelThreshold <= 0) {
    throw new HlodError("invalid-camera", "HLOD decision camera viewport/tanHalfFov/pixelThreshold must be finite and positive.");
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
