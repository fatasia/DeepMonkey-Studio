/**
 * H-C7-P4 基准 D4:10k 对象事务提交时延(SDK prepare+commit 吞吐,CPU 级)。
 *
 * 口径如实声明:测量的是 SDK 事务层(prepare 验证/diff + 内存 driver apply)的
 * 纯 CPU 吞吐,与历史"引擎 submit 47.4→2.2ms"是不同层(那是引擎命令层),
 * 不可互换对比。浏览器宿主/CAS/渲染消费不在本样例。
 */
import {
  commitSceneCommandTransaction, prepareSceneCommandTransaction,
  type SceneCommand, type SceneCommandTransactionApplyResult,
  type SceneCommandTransactionDriver, type SceneCommandTransactionRollbackContext,
} from "../../../../scene-sdk/src/index.js";

const TARGET_OBJECTS = 10_000;
const MAX_COMMANDS = 64; // SCENE_COMMAND_TRANSACTION_MAX_COMMANDS
const COMMANDS_PER_TX = 32; // 每盒 create+transform = 2 命令
const TRANSACTIONS = Math.ceil(TARGET_OBJECTS / COMMANDS_PER_TX);

const memoryDriver = (): SceneCommandTransactionDriver => {
  const objects = new Map<string, { id: string; position?: number[] }>();
  return {
    readRevision: () => 0,
    apply(commandList: readonly SceneCommand[]): SceneCommandTransactionApplyResult {
      const results = commandList.map((command, index) => {
        if (command.type === "object.create-primitive") {
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
      return { revision: 1, results };
    },
    rollback(_context: SceneCommandTransactionRollbackContext): number { return 0; },
  };
};

const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
};

const prepareMs: number[] = [];
const commitMs: number[] = [];
let committedCount = 0;
const runStart = performance.now();
for (let tx = 0; tx < TRANSACTIONS; tx += 1) {
  const commands: unknown[] = [];
  for (let k = 0; k < COMMANDS_PER_TX; k += 1) {
    const index = tx * COMMANDS_PER_TX + k / 2 | 0;
    const id = `obj-${index}`;
    if (k % 2 === 0) {
      commands.push({ id: `mk-${id}`, type: "object.create-primitive", target: { kind: "object", sceneId: "bench", objectId: id }, name: id, kind: "box", color: "#778899" });
    } else {
      commands.push({ id: `tf-${id}`, type: "object.set-transform", target: { kind: "object", sceneId: "bench", objectId: id }, position: [index * 0.1, 0, 0] });
    }
  }
  let t0 = performance.now();
  const prepared = prepareSceneCommandTransaction({
    id: `bench:d4-${tx}`, sceneId: "bench", baseRevision: 0,
    module: { id: "bench", permissions: ["scene.write"], capabilities: ["studio.object"] },
    commands, maxCommands: MAX_COMMANDS,
  });
  prepareMs.push(performance.now() - t0);
  if (prepared.status !== "prepared") throw new Error(`tx ${tx} rejected: ${JSON.stringify(prepared.issues)}`);
  t0 = performance.now();
  const outcome = await commitSceneCommandTransaction(prepared.plan, memoryDriver());
  commitMs.push(performance.now() - t0);
  if (outcome.status === "committed") committedCount += 1;
}
const wallMs = performance.now() - runStart;

const report = {
  bench: "d4-transaction-throughput",
  transactions: TRANSACTIONS,
  commandsPerTransaction: COMMANDS_PER_TX * 2,
  committedTransactions: committedCount,
  totalObjects: TRANSACTIONS * COMMANDS_PER_TX,
  prepareMs: { p50: +percentile(prepareMs, 0.5).toFixed(4), p95: +percentile(prepareMs, 0.95).toFixed(4), max: +Math.max(...prepareMs).toFixed(4) },
  commitMs: { p50: +percentile(commitMs, 0.5).toFixed(4), p95: +percentile(commitMs, 0.95).toFixed(4), max: +Math.max(...commitMs).toFixed(4) },
  wallMs: +wallMs.toFixed(2),
  objectsPerSecond: Math.round(TRANSACTIONS * COMMANDS_PER_TX / (wallMs / 1000)),
  caliber: "sdk-transaction-layer-cpu (not engine-submit-layer)",
  gpuExecuted: false, browserExecuted: false,
};
console.log(JSON.stringify(report, null, 2));
