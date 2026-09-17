import { cpus, platform, arch } from "node:os";
import * as THREE from "three";
import { applySceneChangeset, createSceneChangeset } from "../src/scene/SceneChangeset.js";
import { SceneTransformGraph } from "../src/scene/SceneTransformGraph.js";
import { SceneChangesetProjection } from "../src/threeBridge/SceneChangesetProjection.js";
import { accepted, bridge, mesh } from "../src/threeBridge/testFixture.js";

const warmups = 7, samples = 31, leafCount = 100;
const graph = new SceneTransformGraph(), root = new THREE.Group(), bindings = [{ nodeId: "root", object: root }];
graph.create({ id: "root" });
const leaves: THREE.Mesh[] = [];
for (let index = 0; index < leafCount; index++) {
  const id = `node-${index}`, object = mesh(); leaves.push(object); root.add(object);
  graph.create({ id, parent: "root" }); bindings.push({ nodeId: id, object });
}
graph.flush(); root.updateWorldMatrix(true, true);
const incremental = bridge(), full = bridge(), dirty = new SceneChangesetProjection(bindings);
accepted(incremental.project(root, { cameraLayerMask: 1 })).acknowledge();
accepted(full.project(root, { cameraLayerMask: 1 })).acknowledge();

const timings = { incremental: [] as number[], full: [] as number[] };
let work: unknown, checksum = 0;
for (let round = 0; round < warmups + samples; round++) {
  const node = graph.getNode("node-42")!, x = round % 2;
  const changeset = createSceneChangeset(`sample-${round}`, graph.revision, [{ kind: "transform", nodeId: "node-42",
    expectedRevision: node.lastChangedRevision, transform: { kind: "trs", translation: [x, 0, 0],
      rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }]);
  const outcome = applySceneChangeset(graph, changeset), plan = dirty.plan(changeset, outcome);
  if (plan.status !== "ready") throw new Error("Dirty plan was rejected.");
  leaves[42]!.position.x = x; root.updateWorldMatrix(true, true);
  const operations = {
    incremental: () => accepted(incremental.projectDirty(root, plan, { cameraLayerMask: 1 })),
    full: () => accepted(full.project(root, { cameraLayerMask: 1 })),
  };
  for (const name of (round % 2 ? ["full", "incremental"] : ["incremental", "full"]) as (keyof typeof operations)[]) {
    const start = performance.now(), result = operations[name](), elapsed = performance.now() - start;
    if (!result.acknowledge()) throw new Error(`${name} projection acknowledgement failed.`);
    checksum += result.packet.instances.length; if (name === "incremental") work = result.metrics;
    if (round >= warmups) timings[name].push(elapsed);
  }
}
function summary(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], samplesMs: values };
}
console.log(JSON.stringify({ schema: 1, timestamp: new Date().toISOString(),
  scope: "Node CPU Three source projection only; no GPU, browser presentation, renderer upload, or competitor comparison",
  runtime: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  method: { warmupsPerPath: warmups, samplesPerPath: samples, alternatingOrder: true, leafCount, changedLeaves: 1 },
  work, incremental: summary(timings.incremental), full: summary(timings.full), checksum }, null, 2));
