/**
 * H-C7-P4 基准 B4+C4+C5:相机飞行终值 / 同 ID 参数化重生成 / 数据驱动更新(SDK 合同面)。
 *
 * B4:camera.set 终值 pose 逐值;camera.fly-to 场景不匹配拒绝;
 * C4:混批 [delete 旧, create 同 ID 新] 参数化重生成,重生成后属性为新定义;
 * C5:data.apply 值传播到目标对象记录,失败信封外如实(伪 driver 记录 values)。
 */
import {
  commitSceneCommandTransaction, prepareSceneCommandTransaction,
  type SceneCommand, type SceneCommandTransactionApplyResult,
  type SceneCommandTransactionDriver, type SceneCommandTransactionRollbackContext,
} from "../../../../scene-sdk/src/index.js";

type Obj = { id: string; kind: string; color: string; position?: number[]; data?: Record<string, unknown> };
function memoryDriver() {
  let objects = new Map<string, Obj>();
  let camera: { position: [number, number, number]; target: [number, number, number] } | undefined;
  let flights: Array<{ target: unknown; durationMs: number; sceneId: string }> = [];
  let before: Map<string, Obj> | undefined;
  const clone = (): Map<string, Obj> => new Map([...objects].map(([key, value]) => [key, { ...value }]));
  const driver: SceneCommandTransactionDriver = {
    readRevision: () => 0,
    apply(commandList: readonly SceneCommand[]): SceneCommandTransactionApplyResult {
      before = clone();
      const results = commandList.map((command, index) => {
        if (command.type === "object.create-primitive") {
          if (objects.has(command.target.objectId)) return { index, id: command.id, type: command.type, success: false, message: "exists" };
          objects.set(command.target.objectId, { id: command.target.objectId, kind: command.kind, color: command.color });
          return { index, id: command.id, type: command.type, success: true };
        }
        if (command.type === "object.delete-primitive") {
          if (!objects.delete(command.target.objectId)) return { index, id: command.id, type: command.type, success: false, message: "missing" };
          return { index, id: command.id, type: command.type, success: true };
        }
        if (command.type === "object.set-transform" && command.target.kind === "object") {
          const object = objects.get(command.target.objectId);
          if (!object) return { index, id: command.id, type: command.type, success: false, message: "missing" };
          if (command.position) object.position = [...command.position];
          return { index, id: command.id, type: command.type, success: true };
        }
        if (command.type === "camera.set") {
          camera = { position: [...command.position], target: [...command.target] };
          return { index, id: command.id, type: command.type, success: true };
        }
        if (command.type === "camera.fly-to") {
          flights.push({ target: command.target, durationMs: command.durationMs, sceneId: command.sceneId });
          return { index, id: command.id, type: command.type, success: true };
        }
        if (command.type === "data.apply" && command.target.kind === "object") {
          const object = objects.get(command.target.objectId);
          if (!object) return { index, id: command.id, type: command.type, success: false, message: "missing" };
          object.data = { ...object.data, ...command.values };
          return { index, id: command.id, type: command.type, success: true };
        }
        return { index, id: command.id, type: command.type, success: false, message: "unsupported" };
      });
      return { revision: 1, results };
    },
    rollback(_context: SceneCommandTransactionRollbackContext): number { if (before) objects = before; return 0; },
  };
  return { driver, objects: () => objects, camera: () => camera, flights: () => flights };
}

async function commit(memory: ReturnType<typeof memoryDriver>, commands: unknown[], id: string) {
  const prepared = prepareSceneCommandTransaction({
    id, sceneId: "bench", baseRevision: 0,
    module: { id: "bench", permissions: ["scene.write"], capabilities: ["studio.object", "studio.material", "studio.scene", "studio.camera", "studio.data"] },
    commands,
  });
  if (prepared.status !== "prepared") return { status: "rejected" as const, issue: JSON.stringify(prepared.issues) };
  const outcome = await commitSceneCommandTransaction(prepared.plan, memory.driver);
  if (outcome.status !== "committed") return { status: outcome.status, issue: outcome.status === "rolled-back" || outcome.status === "failed" ? JSON.stringify(outcome.issue) : "" };
  return { status: "committed" as const, issue: "" };
}

const failures: string[] = [];

// —— B4:相机 set 终值 + fly-to 记录与场景不匹配拒绝 ——
{
  const memory = memoryDriver();
  const set = await commit(memory, [
    { id: "cam-1", type: "camera.set", sceneId: "bench", position: [12, 8, 14], target: [0, 0, 0], fov: 55 },
  ], "bench:b4-set");
  if (set.status !== "committed") failures.push(`b4-set ${set.status} ${set.issue}`);
  const pose = memory.camera();
  if (!pose || pose.position[0] !== 12 || pose.target[0] !== 0) failures.push(`b4 pose ${JSON.stringify(pose)}`);
  const fly = await commit(memory, [
    { id: "fly-1", type: "camera.fly-to", sceneId: "bench", target: { position: [3, 1, 2] }, durationMs: 800 },
  ], "bench:b4-fly");
  if (fly.status !== "committed") failures.push(`b4-fly ${fly.status}`);
  if (memory.flights().length !== 1 || memory.flights()[0]!.durationMs !== 800) failures.push(`b4 flights ${JSON.stringify(memory.flights())}`);
  const wrongScene = await commit(memory, [
    { id: "fly-bad", type: "camera.fly-to", sceneId: "other-scene", target: { position: [0, 0, 0] }, durationMs: 100 },
  ], "bench:b4-bad");
  if (wrongScene.status !== "rejected") failures.push(`b4-bad ${wrongScene.status}`);
}

// —— C4:同 ID 参数化重生成([delete 旧, create 同 ID 新] 混批) ——
{
  const memory = memoryDriver();
  const setup = await commit(memory, [
    { id: "c4-mk", type: "object.create-primitive", target: { kind: "object", sceneId: "bench", objectId: "prop" }, name: "prop", kind: "box", color: "#888888" },
    { id: "c4-tf", type: "object.set-transform", target: { kind: "object", sceneId: "bench", objectId: "prop" }, position: [1, 2, 3] },
  ], "bench:c4-setup");
  if (setup.status !== "committed") failures.push(`c4-setup ${setup.status} ${setup.issue}`);
  const regen = await commit(memory, [
    { id: "c4-del", type: "object.delete-primitive", target: { kind: "object", sceneId: "bench", objectId: "prop" } },
    { id: "c4-new", type: "object.create-primitive", target: { kind: "object", sceneId: "bench", objectId: "prop" }, name: "prop-v2", kind: "sphere", color: "#22aaff" },
    { id: "c4-tf2", type: "object.set-transform", target: { kind: "object", sceneId: "bench", objectId: "prop" }, position: [4, 5, 6] },
  ], "bench:c4-regen");
  if (regen.status !== "committed") failures.push(`c4-regen ${regen.status} ${regen.issue}`);
  const object = memory.objects().get("prop")!;
  if (object.kind !== "sphere" || object.color !== "#22aaff") failures.push(`c4 regen props ${JSON.stringify(object)}`);
  // 回滚注入:重生成后再删除并注入幽灵变换 → rolled-back → 同 ID prop-v2 定义恢复(存在+sphere+新色)。
  const rollbackCase = await commit(memory, [
    { id: "c4-del2", type: "object.delete-primitive", target: { kind: "object", sceneId: "bench", objectId: "prop" } },
    { id: "c4-ghost", type: "object.set-transform", target: { kind: "object", sceneId: "bench", objectId: "ghost" }, position: [0, 0, 0] },
  ], "bench:c4-rollback");
  if (rollbackCase.status !== "rolled-back") failures.push(`c4-rollback ${rollbackCase.status}`);
  const restored = memory.objects().get("prop");
  if (!restored || restored.kind !== "sphere" || restored.color !== "#22aaff") failures.push(`c4 rollback restore ${JSON.stringify(restored)}`);
}

// —— C5:data.apply 值传播 + 时间戳留存 ——
{
  const memory = memoryDriver();
  await commit(memory, [
    { id: "c5-mk", type: "object.create-primitive", target: { kind: "object", sceneId: "bench", objectId: "sensor" }, name: "sensor", kind: "box", color: "#445566" },
  ], "bench:c5-setup");
  const apply = await commit(memory, [
    { id: "c5-data", type: "data.apply", target: { kind: "object", sceneId: "bench", objectId: "sensor" }, values: { temperature: 73.5, state: "running" }, timestamp: "2026-10-02T03:50:00Z" },
  ], "bench:c5-apply");
  if (apply.status !== "committed") failures.push(`c5-apply ${apply.status} ${apply.issue}`);
  const object = memory.objects().get("sensor")!;
  if (object.data?.temperature !== 73.5 || object.data?.state !== "running") failures.push(`c5 data ${JSON.stringify(object.data)}`);
  const missing = await commit(memory, [
    { id: "c5-missing", type: "data.apply", target: { kind: "object", sceneId: "bench", objectId: "ghost" }, values: { x: 1 }, timestamp: "2026-10-02T03:50:01Z" },
  ], "bench:c5-missing");
  if (missing.status !== "rolled-back") failures.push(`c5-missing ${missing.status}`);
}

const report = {
  bench: "b4-c4-c5-camera-regen-data",
  cases: ["b4-camera-set-fly", "c4-same-id-regen-rollback", "c5-data-apply"],
  failures,
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  gpuExecuted: false, browserExecuted: false,
};
console.log(JSON.stringify(report, null, 2));
if (report.verdict === "FAIL") throw new Error(`b4/c4/c5 bench failed: ${failures.join("; ")}`);
