/**
 * H-C7-P4 基准 A2:6 节机械臂层级组装 → graph set-parent(CLI 同执行路径)。
 *
 * 证明范围(graph 权威层级,不冒充浏览器/GPU 证据):
 * - base→link1..5→tool 链 build;重父级 keepWorldTransform:false 后 graph 末端
 *   worldMatrix 与 Three 侧等价 reparent+updateMatrixWorld 的 matrixWorld 逐值一致;
 * - keepWorldTransform:true 重父级前后 tool 世界矩阵逐位不变;
 * - 循环父级拒绝。
 * 复用已验 SceneGraphTransactionDriver(native-author-parent 同路径)。
 */
import * as THREE from "three";
import { SceneTransformGraph } from "../../../src/scene/index.js";
import { prepareSceneCommandTransaction, commitSceneCommandTransaction, parseSceneCommand } from "../../../../scene-sdk/src/index.js";
import { SceneGraphTransactionDriver } from "../../../../../apps/web/src/commands/SceneGraphTransactionDriver.js";

const CHAIN = ["base", "link1", "link2", "link3", "link4", "link5", "tool"] as const;

// Three 侧等价:6 节局部变换(每节沿 y 1.0 + 绕 z 递增)。
const threeNodes = new Map<string, THREE.Object3D>();
const scene = new THREE.Scene();
const parent: Record<string, string | null> = {};
let previous: THREE.Object3D | null = null;
for (const [index, id] of CHAIN.entries()) {
  const node = new THREE.Object3D();
  node.position.set(0, index === 0 ? 0 : 1, 0);
  node.rotation.z = index * 0.2;
  if (previous) previous.add(node); else scene.add(node);
  threeNodes.set(id, node);
  parent[id] = previous ? (previous.name || null) : null;
  node.name = id;
  previous = node;
}
scene.updateMatrixWorld(true);

// graph 权威层级:局部矩阵从 Three 侧导入(与迁移例同形态)。
const graph = new SceneTransformGraph<string>();
for (const id of CHAIN) {
  const node = threeNodes.get(id)!;
  graph.create({
    id, parent: id === "base" ? null : parent[id] ?? null,
    localTransform: { kind: "matrix", matrix: [...node.matrix.elements] as unknown as import("../../../src/scene/index.js").SceneMatrix4 },
  });
}
graph.flush();

const driverFor = (transactionId: string, baseRevision: number) =>
  new SceneGraphTransactionDriver(graph, { sceneId: "world", transactionId, baseRevision, parser: { parse: parseSceneCommand } });

const failures: string[] = [];
const worldOf = (graph_: SceneTransformGraph<string>, id: string): number[] => [...graph_.getNode(id)!.worldMatrix];

// 1. keepWorldTransform:false:link3 从 link2 改挂 link1,末端世界矩阵对拍 Three 等价 reparent。
const detachPrepared = prepareSceneCommandTransaction({
  id: "bench:a2-detach", sceneId: "world", baseRevision: graph.revision,
  module: { id: "bench", permissions: ["scene.write"], capabilities: ["studio.object"] },
  commands: [{ id: "reparent-link3", type: "object.set-parent", target: { kind: "object", sceneId: "world", objectId: "link3" }, parentId: "link1", keepWorldTransform: false }],
});
if (detachPrepared.status !== "prepared") failures.push(`prepare ${JSON.stringify(detachPrepared.status)}`);
const detachOutcome = detachPrepared.status === "prepared"
  ? await commitSceneCommandTransaction(detachPrepared.plan, driverFor("bench:a2-detach", detachPrepared.plan.baseRevision))
  : undefined;
if (detachOutcome?.status !== "committed") failures.push(`commit ${detachOutcome?.status ?? "skipped"}`);
else {
  // Three 侧等价重父级:link3 及其子树挂到 link1(局部变换保持)。
  const link3 = threeNodes.get("link3")!; const link1 = threeNodes.get("link1")!;
  link1.add(link3); scene.updateMatrixWorld(true);
  for (const id of ["link3", "tool"] as const) {
    const graphWorld = worldOf(graph, id);
    const threeWorld = [...threeNodes.get(id)!.matrixWorld.elements];
    const delta = Math.max(...graphWorld.map((value, axis) => Math.abs(value - threeWorld[axis]!)));
    if (!(delta <= 1e-9)) failures.push(`${id} worldMatrix delta ${delta}`);
  }
}

// 2. keepWorldTransform:true:tool 重挂 base,世界矩阵重父级前后逐位不变。
const toolWorldBefore = worldOf(graph, "tool");
const keepPrepared = prepareSceneCommandTransaction({
  id: "bench:a2-keep", sceneId: "world", baseRevision: graph.revision,
  module: { id: "bench", permissions: ["scene.write"], capabilities: ["studio.object"] },
  commands: [{ id: "keep-tool", type: "object.set-parent", target: { kind: "object", sceneId: "world", objectId: "tool" }, parentId: "base", keepWorldTransform: true }],
});
const keepOutcome = keepPrepared.status === "prepared"
  ? await commitSceneCommandTransaction(keepPrepared.plan, driverFor("bench:a2-keep", keepPrepared.plan.baseRevision))
  : undefined;
if (keepOutcome?.status !== "committed") failures.push(`keep commit ${keepOutcome?.status ?? "skipped"}`);
else {
  const toolWorldAfter = worldOf(graph, "tool");
  const delta = Math.max(...toolWorldAfter.map((value, axis) => Math.abs(value - toolWorldBefore[axis]!)));
  if (!(delta <= 1e-12)) failures.push(`keep-world tool delta ${delta}`);
}

// 3. 循环父级拒绝。
const cyclePrepared = prepareSceneCommandTransaction({
  id: "bench:a2-cycle", sceneId: "world", baseRevision: graph.revision,
  module: { id: "bench", permissions: ["scene.write"], capabilities: ["studio.object"] },
  commands: [{ id: "cycle", type: "object.set-parent", target: { kind: "object", sceneId: "world", objectId: "base" }, parentId: "tool", keepWorldTransform: false }],
});
const cycleOutcome = cyclePrepared.status === "prepared"
  ? await commitSceneCommandTransaction(cyclePrepared.plan, driverFor("bench:a2-cycle", cyclePrepared.plan.baseRevision))
  : undefined;
if (cycleOutcome?.status !== "rolled-back" && cycleOutcome?.status !== "failed" && cycleOutcome?.status !== "rejected") {
  failures.push(`cycle not rejected: ${cycleOutcome?.status ?? "skipped"}`);
}

const report = {
  bench: "a2-hierarchy",
  chain: [...CHAIN],
  detachOutcome: detachOutcome?.status ?? "skipped",
  keepOutcome: keepOutcome?.status ?? "skipped",
  cycleOutcome: cycleOutcome?.status ?? "skipped",
  failures,
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  gpuExecuted: false, browserExecuted: false,
};
console.log(JSON.stringify(report, null, 2));
if (report.verdict === "FAIL") throw new Error(`a2 bench failed: ${failures.join("; ")}`);
