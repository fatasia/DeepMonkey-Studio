import fs from "node:fs/promises";
import { SceneTransformGraph, type SceneTransformFlushResult } from "../packages/deep-engine/src/scene/index.js";
import { prepareSceneCommandTransaction, commitSceneCommandTransaction, parseSceneCommand, type SceneCommandTransactionPlan } from "../packages/scene-sdk/src/index.js";
import { SceneGraphTransactionDriver } from "../apps/web/src/commands/SceneGraphTransactionDriver.js";
import { ScenePrimitiveOwner, restoreSceneFromSnapshot } from "../apps/web/src/commands/ScenePrimitiveOwnerPort.js";
import { SceneReferenceRegistry, SceneReferenceResolutionError, resolveSceneReferenceIntegrity } from "../apps/web/src/commands/SceneReferenceCleanupPort.js";
import type { SceneAnimationState, SceneSnapshot, SimulationEntityState } from "../packages/contracts/src/index.js";

// H-C7-P3 第六批 CLI:动画/仿真引用消费化轮。
// 1) author:victim+keeper 双图元 committed;
// 2) delete-victim:携 referenceCleanup(动画时间线+状态机+clip 事件+仿真实体,锚在 keeper 状态 s2)
//    committed——动画帧/状态机状态/触及转移/被删对象 clip 事件/命中的仿真实体全部消费,
//    序列化容器零悬空 victim 引用;
// 3) reopen:容器随快照 JSON 往返 → restoreSceneFromSnapshot 解析门通过(引用→运行时资源);
// 4) dangling-refuse:篡改快照注入悬空引用(动画帧 ghost / 仿真实体 ghost)→ 解析门以显式
//    错误码拒绝重开(fail-closed,不静默丢弃)。receipt 落盘
//    test-output/hc7p3-graph-owner-20261002/cli-reference-consumption-receipt.json。
const args = process.argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const sceneId = value("--scene") ?? "native-author";
const outPath = value("--out");

const graph = new SceneTransformGraph<string>();
graph.flush();
const owner = new ScenePrimitiveOwner({ sceneId });

const driver = (plan: SceneCommandTransactionPlan, refs?: SceneReferenceRegistry) =>
  new SceneGraphTransactionDriver(graph, {
    sceneId, transactionId: plan.id, baseRevision: plan.baseRevision, parser: { parse: parseSceneCommand },
    primitiveOwner: owner, ...(refs ? { referenceCleanup: refs } : {}),
  });
const request = (id: string, commands: unknown[]) => ({ id, sceneId, baseRevision: graph.revision,
  module: { id: "hc7p3-ref-cli", capabilities: ["studio.object"], permissions: ["scene.write"] }, commands });
const phase = async (name: string, commands: unknown[], refs?: SceneReferenceRegistry) => {
  const prepared = prepareSceneCommandTransaction(request(name, commands));
  if (prepared.status !== "prepared") throw Error(`prepare rejected: ${JSON.stringify(prepared.issues)}`);
  const host = driver(prepared.plan, refs);
  const outcome = await commitSceneCommandTransaction(prepared.plan, host);
  if (outcome.status !== "committed") throw Error(`commit ${name}: ${outcome.status} ${JSON.stringify(outcome.issue)}`);
  return { receipt: outcome.receipt, finalFlush: host.finalFlush as SceneTransformFlushResult<string> };
};

// 阶段 1:author——victim+keeper 双图元。
const authorPhase = await phase("author", [
  { id: "create-victim", type: "object.create-primitive", target: { kind: "object", sceneId, objectId: "victim-box" }, name: "victim", kind: "box", color: "#ff8844" },
  { id: "create-keeper", type: "object.create-primitive", target: { kind: "object", sceneId, objectId: "keeper-box" }, name: "keeper", kind: "cylinder", color: "#00ff00" },
]);

// 引用容器:动画域锚在 keeper 状态 s2(victim 可删),仿真域两类实体引用两对象。
const animation: SceneAnimationState = {
  duration: 4, loop: false, camera: [],
  models: [
    { id: "f1", time: 0, modelId: "victim-box", transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
    { id: "f2", time: 2, modelId: "victim-box", transform: { position: { x: 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
    { id: "f3", time: 3, modelId: "keeper-box", transform: { position: { x: 3, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
  ],
  stateMachine: {
    enabled: true, initialStateId: "s2", activeStateId: "s2", transitionDuration: 0.2,
    states: [
      { id: "s1", name: "victim-spin", modelId: "victim-box", clipId: "c1", loop: true },
      { id: "s2", name: "keeper-idle", modelId: "keeper-box", clipId: "c2", loop: false },
    ],
    transitions: [
      { id: "t1", fromStateId: "s1", toStateId: "s2", parameter: "go", equals: true },
      { id: "t2", fromStateId: "s2", toStateId: "s1", parameter: "back", equals: true },
    ],
    events: [
      { clipId: "c1", eventId: "e-victim", time: 0.5 },
      { clipId: "c2", eventId: "e-keeper", time: 0.2 },
    ],
  },
};
const simulationEntities: SimulationEntityState[] = [
  { id: "node-k", kind: "flowNode", targetModelId: "keeper-box", node: { id: "node-k", name: "库", kind: "sink" } },
  { id: "link-1", kind: "flowLink", fromModelId: "victim-box", toModelId: "keeper-box" },
  { id: "path-1", kind: "path", name: "巡检", targetModelId: "victim-box", points: [[0, 0, 0], [1, 0, 0]], loopMode: "once", speed: 1 },
  { id: "pair-1", kind: "collisionPair", name: "碰撞", a: { modelId: "victim-box" }, b: { modelId: "keeper-box" }, tolerance: 0.01 },
];
const refs = new SceneReferenceRegistry({ sceneId, containers: {
  selectionSets: [{ id: "g1", name: "机组", objectIds: ["victim-box", "keeper-box"] }],
  rootLayerOrder: [{ kind: "object", id: "victim-box" }, { kind: "object", id: "keeper-box" }],
  animation, simulationEntities,
} });
resolveSceneReferenceIntegrity({ animation, simulationEntities, isKnownObject: id => owner.has(id) });

// 阶段 2:delete-victim——删除流消费动画/仿真引用。
const deletePhase = await phase("delete-victim",
  [{ id: "delete-victim", type: "object.delete-primitive", target: { kind: "object", sceneId, objectId: "victim-box" } }], refs);
const animationAfter = refs.state.animation!;
const consumedProven =
  JSON.stringify(animationAfter.models.map(frame => frame.id)) === JSON.stringify(["f3"])
  && JSON.stringify(animationAfter.stateMachine!.states.map(state => state.id)) === JSON.stringify(["s2"])
  && JSON.stringify(animationAfter.stateMachine!.transitions) === JSON.stringify([])
  && JSON.stringify(animationAfter.stateMachine!.events!.map(event => event.eventId)) === JSON.stringify(["e-keeper"])
  && animationAfter.stateMachine!.initialStateId === "s2"
  && JSON.stringify(refs.state.simulationEntities!.map(entity => entity.id)) === JSON.stringify(["node-k"])
  && JSON.stringify(refs.state.selectionSets[0]!.objectIds) === JSON.stringify(["keeper-box"]);
if (!consumedProven) throw Error(`reference consumption drifted: ${JSON.stringify({ animationAfter, simulation: refs.state.simulationEntities })}`);
const serializedConsumed = JSON.stringify({ animation: animationAfter, simulationEntities: refs.state.simulationEntities });
if (serializedConsumed.includes("victim-box")) throw Error("consumed containers still serialize dangling victim references");

// 阶段 3:reopen——消费态容器随快照 JSON 往返,解析门通过(引用→运行时资源)。
const snapshot: SceneSnapshot = owner.snapshotScene();
snapshot.selectionSets = refs.state.selectionSets;
snapshot.rootLayerOrder = refs.state.rootLayerOrder;
snapshot.animation = structuredClone(animationAfter);
snapshot.simulationEntities = structuredClone(refs.state.simulationEntities!);
const serialized = JSON.stringify(snapshot);
const reopenedSnapshot = JSON.parse(serialized) as SceneSnapshot;
const reopened = restoreSceneFromSnapshot({ snapshot: reopenedSnapshot, sceneId });
if (reopened.owner.list().length !== 1 || !reopened.owner.has("keeper-box")) throw Error("reopen lost keeper-box");
const reopenGateProven = reopened.snapshot.animation!.models.length === 1;

// 阶段 4:dangling-refuse——注入悬空引用,解析门 fail-closed 拒绝。
const danglingAnimation = structuredClone(reopenedSnapshot);
danglingAnimation.animation!.models.push({ id: "f-ghost", time: 4, modelId: "ghost-box",
  transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } });
let animationDanglingCode = "";
try { restoreSceneFromSnapshot({ snapshot: danglingAnimation, sceneId }); }
catch (error) { animationDanglingCode = error instanceof SceneReferenceResolutionError ? error.code : `unexpected:${String(error)}`; }
const danglingSimulation = structuredClone(reopenedSnapshot);
danglingSimulation.simulationEntities!.push({ id: "link-ghost", kind: "flowLink", fromModelId: "ghost-box", toModelId: "keeper-box" });
let simulationDanglingCode = "";
try { restoreSceneFromSnapshot({ snapshot: danglingSimulation, sceneId }); }
catch (error) { simulationDanglingCode = error instanceof SceneReferenceResolutionError ? error.code : `unexpected:${String(error)}`; }
if (animationDanglingCode !== "ANIMATION_REF_DANGLING") throw Error(`animation dangling not refused: ${animationDanglingCode}`);
if (simulationDanglingCode !== "SIMULATION_REF_DANGLING") throw Error(`simulation dangling not refused: ${simulationDanglingCode}`);

const receipt: Record<string, unknown> = {
  sceneId, schema: "hc7p3-graph-owner-reference-consumption/1",
  phases: [
    { phase: "author", receipt: authorPhase.receipt, finalFlush: {
        revision: authorPhase.finalFlush.revision, changedNodeIds: authorPhase.finalFlush.changedNodeIds, removedNodeIds: authorPhase.finalFlush.removedNodeIds },
      containers: { animationFrames: animation.models.map(frame => frame.id),
        stateMachineStates: animation.stateMachine!.states.map(state => state.id),
        simulationEntities: simulationEntities.map(entity => entity.id) } },
    { phase: "delete-victim", receipt: deletePhase.receipt, finalFlush: {
        revision: deletePhase.finalFlush.revision, changedNodeIds: deletePhase.finalFlush.changedNodeIds, removedNodeIds: deletePhase.finalFlush.removedNodeIds },
      consumption: { animationFramesAfter: animationAfter.models.map(frame => frame.id),
        stateMachineStatesAfter: animationAfter.stateMachine!.states.map(state => state.id),
        transitionsAfter: animationAfter.stateMachine!.transitions?.length ?? 0,
        eventsAfter: animationAfter.stateMachine!.events!.map(event => event.eventId),
        anchorAfter: { initialStateId: animationAfter.stateMachine!.initialStateId, activeStateId: animationAfter.stateMachine!.activeStateId },
        simulationEntitiesAfter: refs.state.simulationEntities!.map(entity => entity.id),
        serializedDanglingReferenceFree: !serializedConsumed.includes("victim-box") } },
    { phase: "reopen", serializedBytes: serialized.length, reopenedPrimitiveCount: reopened.owner.list().length,
      resolvedAnimationFrames: reopened.snapshot.animation!.models.map(frame => frame.id),
      resolvedSimulationEntities: reopened.snapshot.simulationEntities!.map(entity => entity.id) },
    { phase: "dangling-refuse", animationDanglingCode, simulationDanglingCode },
  ],
  final: {
    graphRevision: graph.revision, graphNodeCount: graph.size,
    referenceConsumptionProven: consumedProven,
    reopenGateProven,
    danglingRefusedProven: animationDanglingCode === "ANIMATION_REF_DANGLING" && simulationDanglingCode === "SIMULATION_REF_DANGLING",
  },
};
const json = JSON.stringify(receipt, null, 2) + "\n";
if (outPath) await fs.writeFile(outPath, json);
console.log(json);
