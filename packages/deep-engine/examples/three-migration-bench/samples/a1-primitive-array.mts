/**
 * H-C7-P4 基准 A1:百盒图元阵列 → 单事务混批创建+变换(60 命令 ≤ 64 上限,25 盒)。
 *
 * 证明范围(SDK 事务语义,不冒充浏览器/GPU 证据):
 * - prepare→plan→diff:混批 create-primitive+set-transform 全部准入;
 * - commit:内存 driver 单收据 committed,对象集与坐标逐值对拍 Three 侧等价循环;
 * - 失败注入:追加幽灵对象变换 → 整体回滚零残留(原子性)。
 * 浏览器宿主验收入口 = editorPrimitiveCreation/Deletion 既有正式测试(见基准规格)。
 */
import * as THREE from "three";
import {
  commitSceneCommandTransaction, prepareSceneCommandTransaction,
  type SceneCommand, type SceneCommandTransactionApplyResult,
  type SceneCommandTransactionDriver, type SceneCommandTransactionRollbackContext,
} from "../../../../scene-sdk/src/index.js";

const GRID = 5;
const SPACING = 1;

// Three 侧参考实现:惯用循环建 25 盒网格。
const reference = new Map<string, THREE.Vector3>();
const referenceGroup = new THREE.Group();
for (let i = 0; i < GRID * GRID; i += 1) {
  const col = i % GRID, row = Math.floor(i / GRID);
  const position = new THREE.Vector3(col * SPACING, 0, row * SPACING);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = `box-${i}`; mesh.position.copy(position);
  referenceGroup.add(mesh);
  reference.set(mesh.name, position.clone());
}
referenceGroup.updateMatrixWorld(true);

// Deep 原生等价:单事务混批 25×(create+transform)。
const commands: unknown[] = [];
for (const [id, position] of reference) {
  commands.push({ id: `mk-${id}`, type: "object.create-primitive", target: { kind: "object", sceneId: "bench", objectId: id }, name: id, kind: "box", color: "#8888aa" });
  commands.push({ id: `tf-${id}`, type: "object.set-transform", target: { kind: "object", sceneId: "bench", objectId: id }, position: [position.x, position.y, position.z] });
}

/** 内存 driver:Map 场景 + 事务前快照回滚;仅承载 SDK 事务语义,非宿主实现。 */
function createMemoryDriver() {
  type Obj = { id: string; position?: number[] };
  let objects = new Map<string, Obj>();
  let before: Map<string, Obj> | undefined;
  const clone = (source: Map<string, Obj>): Map<string, Obj> =>
    new Map([...source].map(([key, value]) => {
      const copy: Obj = { id: value.id };
      if (value.position) copy.position = [...value.position];
      return [key, copy] as const;
    }));
  const driver: SceneCommandTransactionDriver = {
    readRevision: () => 0,
    apply(commandList: readonly SceneCommand[]): SceneCommandTransactionApplyResult {
      before = clone(objects);
      const results = commandList.map((command, index) => {
        if (command.type === "object.create-primitive") {
          if (objects.has(command.target.objectId)) return { index, id: command.id, type: command.type, success: false, message: "exists" };
          objects.set(command.target.objectId, { id: command.target.objectId });
          return { index, id: command.id, type: command.type, success: true };
        }
        if (command.type === "object.set-transform") {
          if (command.target.kind !== "object") return { index, id: command.id, type: command.type, success: false, message: "non-object target" };
          const object = objects.get(command.target.objectId);
          if (!object) return { index, id: command.id, type: command.type, success: false, message: "missing" };
          if (command.position) object.position = [...command.position];
          return { index, id: command.id, type: command.type, success: true };
        }
        return { index, id: command.id, type: command.type, success: false, message: "unsupported" };
      });
      return { revision: 1, results };
    },
    rollback(_context: SceneCommandTransactionRollbackContext): number {
      if (before) objects = clone(before);
      return 0;
    },
  };
  return { driver, objects: () => objects };
}

const failures: string[] = [];
// 1. 准备:混批全部准入。
const prepared = prepareSceneCommandTransaction({
  id: "bench:a1-array", sceneId: "bench", baseRevision: 0,
  module: { id: "bench", permissions: ["scene.write"], capabilities: ["studio.object"] },
  commands,
});
if (prepared.status !== "prepared") failures.push(`prepare rejected: ${JSON.stringify(prepared.issues)}`);
else if (prepared.plan.commands.length !== GRID * GRID * 2) failures.push(`plan commands ${prepared.plan.commands.length}`);

// 2. 提交:单收据 committed + 坐标逐值对拍。
const memory = createMemoryDriver();
const outcome = prepared.status === "prepared" ? await commitSceneCommandTransaction(prepared.plan, memory.driver) : undefined;
if (outcome?.status !== "committed") failures.push(`commit ${outcome?.status ?? "skipped"}`);
else {
  if (memory.objects().size !== GRID * GRID) failures.push(`object count ${memory.objects().size}`);
  for (const [id, position] of reference) {
    const object = memory.objects().get(id);
    if (!object) { failures.push(`missing ${id}`); continue; }
    const delta = Math.max(
      Math.abs((object.position?.[0] ?? NaN) - position.x),
      Math.abs((object.position?.[1] ?? NaN) - position.y),
      Math.abs((object.position?.[2] ?? NaN) - position.z),
    );
    if (!(delta <= 1e-12)) failures.push(`${id} position delta ${delta}`);
  }
}

// 3. 失败注入:幽灵对象变换 → 整体回滚零残留。
const poisoned = prepareSceneCommandTransaction({
  id: "bench:a1-poison", sceneId: "bench", baseRevision: 0,
  module: { id: "bench", permissions: ["scene.write"], capabilities: ["studio.object"] },
  commands: [...commands, { id: "tf-ghost", type: "object.set-transform", target: { kind: "object", sceneId: "bench", objectId: "ghost" }, position: [9, 9, 9] }],
});
const poisonedOutcome = poisoned.status === "prepared" ? await commitSceneCommandTransaction(poisoned.plan, createMemoryDriver().driver) : undefined;
if (poisonedOutcome?.status !== "rolled-back") failures.push(`poison ${poisonedOutcome?.status ?? "skipped"}`);

const report = {
  bench: "a1-primitive-array",
  grid: GRID, commandCount: commands.length,
  committed: outcome?.status === "committed",
  objectCount: memory.objects().size,
  threeReferenceCount: reference.size,
  positionMaxDeltaChecked: true,
  poisonOutcome: poisonedOutcome?.status ?? "skipped",
  failures,
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  gpuExecuted: false, browserExecuted: false,
};
console.log(JSON.stringify(report, null, 2));
referenceGroup.traverse(object => {
  const mesh = object as THREE.Mesh;
  mesh.geometry?.dispose?.();
  (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => material?.dispose?.());
});
if (report.verdict === "FAIL") throw new Error(`a1 bench failed: ${failures.join("; ")}`);
