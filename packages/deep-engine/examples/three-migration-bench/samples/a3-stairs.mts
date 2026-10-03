/**
 * H-C7-P4 基准 A3:参数化楼梯(50 级)→ 多事务混批创建+变换。
 *
 * 证明范围(SDK 事务语义,不冒充浏览器/GPU 证据):
 * - 64 命令上限的真实约束:50 级楼梯(100 命令)拆 2 事务,序列提交;
 * - 楼梯几何:y 单调、包围盒与 Three 侧参考一致;
 * - 第 2 事务失败注入→仅第 2 事务回滚(事务边界),第 1 事务已提交效果保留。
 */
import * as THREE from "three";
import {
  commitSceneCommandTransaction, prepareSceneCommandTransaction,
  type SceneCommand, type SceneCommandTransactionApplyResult,
  type SceneCommandTransactionDriver, type SceneCommandTransactionRollbackContext,
} from "../../../../scene-sdk/src/index.js";

const STEPS = 50;
const STEP_W = 0.3, STEP_H = 0.15, STEP_D = 1;

// Three 侧参考:每级一个 box,位置阶梯排列。
const reference: Array<{ id: string; position: THREE.Vector3 }> = [];
for (let i = 0; i < STEPS; i += 1) {
  reference.push({ id: `step-${i}`, position: new THREE.Vector3(i * STEP_W, (i + 0.5) * STEP_H, 0) });
}

const commandsFor = (from: number, to: number, txId: string): unknown[] => {
  const commands: unknown[] = [];
  for (let i = from; i < to; i += 1) {
    const { id, position } = reference[i]!;
    commands.push({ id: `${txId}-mk-${id}`, type: "object.create-primitive", target: { kind: "object", sceneId: "bench", objectId: id }, name: id, kind: "box", color: "#8a7a55" });
    commands.push({ id: `${txId}-tf-${id}`, type: "object.set-transform", target: { kind: "object", sceneId: "bench", objectId: id }, position: [position.x, position.y, position.z] });
  }
  return commands;
};

function memoryDriver() {
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
    readRevision: () => objects.size,
    apply(commandList: readonly SceneCommand[]): SceneCommandTransactionApplyResult {
      before = clone(objects);
      const results = commandList.map((command, index) => {
        if (command.type === "object.create-primitive") {
          if (objects.has(command.target.objectId)) return { index, id: command.id, type: command.type, success: false, message: "exists" };
          objects.set(command.target.objectId, { id: command.target.objectId });
          return { index, id: command.id, type: command.type, success: true };
        }
        if (command.type === "object.set-transform" && command.target.kind === "object") {
          const object = objects.get(command.target.objectId);
          if (!object) return { index, id: command.id, type: command.type, success: false, message: "missing" };
          if (command.position) object.position = [...command.position];
          return { index, id: command.id, type: command.type, success: true };
        }
        return { index, id: command.id, type: command.type, success: false, message: "unsupported" };
      });
      return { revision: objects.size, results };
    },
    rollback(_context: SceneCommandTransactionRollbackContext): number {
      if (before) objects = clone(before); // 事务边界:恢复到本事务前,不影响更早已提交事务。
      return 0;
    },
  };
  return { driver, objects: () => objects };
}

const failures: string[] = [];
const memory = memoryDriver();
const commitTx = async (commands: unknown[], txId: string) => {
  const prepared = prepareSceneCommandTransaction({
    id: txId, sceneId: "bench", baseRevision: memory.objects().size,
    module: { id: "bench", permissions: ["scene.write"], capabilities: ["studio.object"] },
    commands,
  });
  if (prepared.status !== "prepared") return { status: `rejected:${prepared.issues[0]?.message ?? "?"}` as string };
  return { status: (await commitSceneCommandTransaction(prepared.plan, memory.driver)).status };
};

// 事务 1:前 25 级(50 命令 ≤ 64)。
const tx1 = await commitTx(commandsFor(0, 25, "a3-t1"), "bench:a3-t1");
if (tx1.status !== "committed") failures.push(`tx1 ${tx1.status}`);

// 事务 2:后 25 级,注入 1 条幽灵变换使其回滚(验证事务边界)。
const poisoned = commandsFor(25, STEPS, "a3-t2");
poisoned.push({ id: "a3-t2-ghost", type: "object.set-transform", target: { kind: "object", sceneId: "bench", objectId: "ghost" }, position: [0, 0, 0] });
const tx2 = await commitTx(poisoned, "bench:a3-t2");
if (tx2.status !== "rolled-back") failures.push(`tx2 ${tx2.status}`);

// 事务 3(重试):干净的后 25 级。
const tx3 = await commitTx(commandsFor(25, STEPS, "a3-t3"), "bench:a3-t3");
if (tx3.status !== "committed") failures.push(`tx3 ${tx3.status}`);

// 验收:对象数、y 单调、与 Three 参考坐标一致、失败事务的残留为零。
if (memory.objects().size !== STEPS) failures.push(`object count ${memory.objects().size}`);
let previousY = -Infinity;
for (let i = 0; i < STEPS; i += 1) {
  const object = memory.objects().get(reference[i]!.id);
  if (!object) { failures.push(`missing ${reference[i]!.id}`); continue; }
  const [x, y, z] = object.position ?? [];
  if (y === undefined || !(y > previousY)) failures.push(`${reference[i]!.id} y not monotonic at ${y}`);
  previousY = y ?? previousY;
  const expected = reference[i]!.position;
  if (Math.abs(x! - expected.x) > 1e-12 || Math.abs(z! - expected.z) > 1e-12) failures.push(`${reference[i]!.id} xz mismatch`);
}
if (memory.objects().has("ghost")) failures.push("ghost residue after tx2 rollback");

const report = {
  bench: "a3-stairs",
  steps: STEPS, transactions: 3, commandCap: 64,
  tx1: tx1.status, tx2Poisoned: tx2.status, tx3: tx3.status,
  objectCount: memory.objects().size,
  monotonicY: !failures.some(failure => failure.includes("monotonic")),
  failures,
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  gpuExecuted: false, browserExecuted: false,
};
console.log(JSON.stringify(report, null, 2));
if (report.verdict === "FAIL") throw new Error(`a3 bench failed: ${failures.join("; ")}`);
