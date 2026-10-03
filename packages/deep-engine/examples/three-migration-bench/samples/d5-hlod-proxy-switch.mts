/**
 * H-C7-P4 基准 D5:HLOD 代理切换(CPU 决策面,10k 实例)。
 *
 * 证明范围(纯 CPU 决策,不冒充 GPU 绘制证据):
 * - buildHlodTree 10k 实例 → 代理批生成,削减率登记(对照 T26 底座口径);
 * - decideHlodFrame 双相机档:远档折叠(代理列表)+近档展开(实例叶),
 *   两档的 renderedInstances/hiddenInstances/proxyCoverage 与切面语义一致;
 * - 滞回:同档重复决策稳定(previousCollapsed 传入不抖动)。
 * GPU 绘制收益归 T26/渲染统计域,本样例不冒充。
 */
import { buildHlodTree } from "../../../src/hlod/hlodCluster.js";
import { decideHlodFrame } from "../../../src/hlod/hlodDecision.js";
import { generateHlodClusterProxies } from "../../../src/hlod/hlodProxyBatch.js";
import type { ClusterLodCamera } from "../../../src/rayTracing/clusterLodSelection.js";

const COUNT = 10_000;
const SPACING = 2;

const instances = [];
for (let index = 0; index < COUNT; index += 1) {
  instances.push({
    id: `inst-${index}`,
    position: [(index % 100) * SPACING, Math.floor(index / 100) % 100 * SPACING, Math.floor(index / 10_000) * SPACING] as const,
    radius: 0.5,
  });
}

const failures: string[] = [];
const tree = buildHlodTree(instances);

// 代理批:全叶簇的父层节点生成代理(取树中非叶节点为代理目标)。
const nonLeafIds = [...tree.nodes.values()].filter(node => node.children.length > 0).map(node => node.id);
const shapes = instances.map(instance => ({
  instanceId: instance.id,
  min: [instance.position[0] - instance.radius, instance.position[1] - instance.radius, instance.position[2] - instance.radius] as const,
  max: [instance.position[0] + instance.radius, instance.position[1] + instance.radius, instance.position[2] + instance.radius] as const,
}));
const proxyBatch = generateHlodClusterProxies(tree, shapes, nonLeafIds);
const reductionRatio = 1 - proxyBatch.entries.length / COUNT;

const cameraFor = (position: readonly [number, number, number], pixelThreshold: number): ClusterLodCamera => ({
  position, forward: [-0.55, -0.35, -0.55], viewportHeightPixels: 1080,
  tanHalfFovY: Math.tan((50 / 2) * Math.PI / 180), pixelThreshold,
});

// 近档:低阈值(实例级展开);远档:高阈值(簇折叠)。
const nearCamera = cameraFor([5, 5, 5], 0.5);
const farCamera = cameraFor([300, 220, 300], 8);

const nearDecision = decideHlodFrame(tree, nearCamera);
const farDecision = decideHlodFrame(tree, farCamera);

if (nearDecision.renderedInstances <= farDecision.renderedInstances) {
  failures.push(`near rendered ${nearDecision.renderedInstances} should exceed far ${farDecision.renderedInstances}`);
}
if (nearDecision.hiddenInstances + nearDecision.renderedInstances !== COUNT) failures.push(`near total ${nearDecision.renderedInstances + nearDecision.hiddenInstances}`);
if (farDecision.hiddenInstances + farDecision.renderedInstances !== COUNT) failures.push(`far total ${farDecision.renderedInstances + farDecision.hiddenInstances}`);
if (farDecision.proxyCoverage <= 0) failures.push(`far coverage ${farDecision.proxyCoverage}`);

// 滞回:同相机重复决策稳定(折叠集一致)。
const repeat = decideHlodFrame(tree, farCamera, {}, new Set(farDecision.collapsedNodes.map(node => node.nodeId)));
if (repeat.collapsedNodes.length !== farDecision.collapsedNodes.length) failures.push(`hysteresis ${repeat.collapsedNodes.length} vs ${farDecision.collapsedNodes.length}`);

const report = {
  bench: "d5-hlod-proxy-switch",
  instanceCount: COUNT,
  clusterNodes: tree.nodes.size,
  proxyTargets: nonLeafIds.length,
  proxyBatchEntries: proxyBatch.entries.length,
  reductionRatio: +reductionRatio.toFixed(4),
  near: { rendered: nearDecision.renderedInstances, hidden: nearDecision.hiddenInstances, coverage: +nearDecision.proxyCoverage.toFixed(4) },
  far: { rendered: farDecision.renderedInstances, hidden: farDecision.hiddenInstances, coverage: +farDecision.proxyCoverage.toFixed(4) },
  hysteresisStable: repeat.collapsedNodes.length === farDecision.collapsedNodes.length,
  failures,
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  caliber: "cpu-decision (not gpu draw evidence)",
  gpuExecuted: false, browserExecuted: false,
};
console.log(JSON.stringify(report, null, 2));
if (report.verdict === "FAIL") throw new Error(`d5 bench failed: ${failures.join("; ")}`);
