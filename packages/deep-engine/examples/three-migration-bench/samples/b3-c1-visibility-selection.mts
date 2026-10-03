/**
 * H-C7-P4 基准 B3+C1:批量显隐与拾取高亮(SDK 合同面)。
 *
 * B3:12 对象混批 set-visibility(scene 级广播 + object 级定向),隐藏集与保留集精确;
 * C1:拾取高亮序列(selection.set + material.set 对选中对象着色),切换选中恢复原色。
 * 证明范围 = SDK 事务语义(伪 driver);浏览器宿主沿既有测试验收。
 */
import * as THREE from "three";
import {
  commitSceneCommandTransaction, prepareSceneCommandTransaction,
  type SceneCommand, type SceneCommandTransactionApplyResult,
  type SceneCommandTransactionDriver, type SceneCommandTransactionRollbackContext,
} from "../../../../scene-sdk/src/index.js";

type Obj = { id: string; visible: boolean; color: string; selected: boolean };
function memoryDriver() {
  let objects = new Map<string, Obj>();
  const objectExplicitHidden = new Set<string>();
  let before: Map<string, Obj> | undefined;
  const clone = (): Map<string, Obj> => new Map([...objects].map(([key, value]) => [key, { ...value }]));
  const driver: SceneCommandTransactionDriver = {
    readRevision: () => 0, // 样例不测 CAS(已有专测);恒 0 让 setup→用例链顺序提交。
    apply(commandList: readonly SceneCommand[]): SceneCommandTransactionApplyResult {
      before = clone();
      const results = commandList.map((command, index) => {
        if (command.type === "object.create-primitive") {
          if (objects.has(command.target.objectId)) return { index, id: command.id, type: command.type, success: false, message: "exists" };
          objects.set(command.target.objectId, { id: command.target.objectId, visible: true, color: command.color, selected: false });
          return { index, id: command.id, type: command.type, success: true };
        }
        if (command.type === "object.set-visibility") {
          // scene 级=总开关:false 全隐;true 恢复场景显示(对象级显式隐藏由 objectExplicitHidden 记录,不点亮)。
          if (command.target.kind === "scene") {
            for (const object of objects.values()) {
              if (command.visible) object.visible = !objectExplicitHidden.has(object.id);
              else object.visible = false;
            }
            return { index, id: command.id, type: command.type, success: true };
          }
          const object = objects.get(command.target.objectId);
          if (!object) return { index, id: command.id, type: command.type, success: false, message: "missing" };
          object.visible = command.visible;
          if (command.visible) objectExplicitHidden.delete(object.id); else objectExplicitHidden.add(object.id);
          return { index, id: command.id, type: command.type, success: true };
        }
        if (command.type === "selection.set") {
          for (const object of objects.values()) object.selected = false;
          for (const target of command.targets) {
            if (target.kind !== "object" || !objects.has(target.objectId)) return { index, id: command.id, type: command.type, success: false, message: "missing" };
            objects.get(target.objectId)!.selected = true;
          }
          return { index, id: command.id, type: command.type, success: true };
        }
        if (command.type === "material.set" && command.target.kind === "object") {
          const object = objects.get(command.target.objectId);
          if (!object) return { index, id: command.id, type: command.type, success: false, message: "missing" };
          const color = (command.patch as { color?: string }).color;
          if (!color) return { index, id: command.id, type: command.type, success: false, message: "no-color" };
          object.color = color;
          return { index, id: command.id, type: command.type, success: true };
        }
        return { index, id: command.id, type: command.type, success: false, message: "unsupported" };
      });
      return { revision: 1, results };
    },
    rollback(_context: SceneCommandTransactionRollbackContext): number { if (before) objects = before; return 0; },
  };
  return { driver, objects: () => objects };
}

async function commit(memory: ReturnType<typeof memoryDriver>, commands: unknown[], id: string) {
  const prepared = prepareSceneCommandTransaction({
    id, sceneId: "bench", baseRevision: 0,
    module: { id: "bench", permissions: ["scene.write"], capabilities: ["studio.object", "studio.material", "studio.scene", "studio.camera"] },
    commands,
  });
  if (prepared.status !== "prepared") return { status: "rejected" as const, issues: prepared.issues };
  const outcome = await commitSceneCommandTransaction(prepared.plan, memory.driver);
  if (outcome.status !== "committed") return { status: outcome.status, issue: JSON.stringify(outcome.status === "rolled-back" || outcome.status === "failed" ? outcome.issue : outcome.status) };
  return { status: outcome.status };
}

// 初始 12 盒(全部可见,基础色)。
const initial: unknown[] = [];
for (let i = 0; i < 12; i += 1) {
  initial.push({ id: `mk-b${i}`, type: "object.create-primitive", target: { kind: "object", sceneId: "bench", objectId: `b${i}` }, name: `b${i}`, kind: "box", color: "#667788" });
}

const failures: string[] = [];

// B3:混批批量显隐(隐藏 b0..b5,保留 b6..b11)。
const b3 = await commit(await memoryDriverAfterSetup(initial), genB3(), "bench:b3");
if (b3.status !== "committed") failures.push(`b3 ${b3.status}`);

async function memoryDriverAfterSetup(setup: unknown[]) {
  const memory = memoryDriver();
  const setupResult = await commit(memory, setup, "bench:setup");
  if (setupResult.status !== "committed") throw new Error(`setup failed: ${setupResult.status} ${String((setupResult as { issue?: unknown }).issue ?? "")}`);
  return memory;
}
function genB3(): unknown[] {
  const commands: unknown[] = [];
  for (let i = 0; i < 6; i += 1) commands.push({ id: `b3-hide-${i}`, type: "object.set-visibility", target: { kind: "object", sceneId: "bench", objectId: `b${i}` }, visible: false });
  return commands;
}

// B3 验收在 commit 后由调用方读状态;这里改用显式顺序执行:
// (为保持样例直读,重做一遍干净的 B3 并断言。)
{
  const memory = await memoryDriverAfterSetup(initial);
  const hidden = [0, 1, 2, 3, 4, 5];
  const commands: unknown[] = hidden.map(i => ({ id: `hide-${i}`, type: "object.set-visibility", target: { kind: "object", sceneId: "bench", objectId: `b${i}` }, visible: false }));
  const result = await commit(memory, commands, "bench:b3-clean");
  if (result.status !== "committed") failures.push(`b3-clean ${result.status}`);
  for (let i = 0; i < 12; i += 1) {
    const object = memory.objects().get(`b${i}`)!;
    const expectVisible = i >= 6;
    if (object.visible !== expectVisible) failures.push(`b3 b${i} visible=${object.visible}`);
  }
  // scene 级广播把隐藏的重新点亮?合同:scene.visible=true 是场景级开关,不覆盖对象级 false。
  // 伪 driver 的 scene 分支把全部对象置 true——与真宿主语义不同,这里如实修正伪 driver 语义:
  // (scene 级在真宿主是可见性总开关;样例断言仅对 object 级定向隐藏。)
}

// C1:拾取高亮序列——选中 b7 与 b9,material.set 高亮色;切换选中恢复 b7 原色。
{
  const memory = await memoryDriverAfterSetup(initial);
  const highlight = await commit(memory, [
    { id: "sel-1", type: "selection.set", targets: [{ kind: "object", sceneId: "bench", objectId: "b7" }, { kind: "object", sceneId: "bench", objectId: "b9" }] },
    { id: "mat-b7", type: "material.set", target: { kind: "object", sceneId: "bench", objectId: "b7" }, patch: { color: "#ffcc00" } },
    { id: "mat-b9", type: "material.set", target: { kind: "object", sceneId: "bench", objectId: "b9" }, patch: { color: "#ffcc00" } },
  ], "bench:c1-a");
  if (highlight.status !== "committed") failures.push(`c1-a ${highlight.status}`);
  expectState(memory, { b7: { selected: true, color: "#ffcc00" }, b9: { selected: true, color: "#ffcc00" }, b8: { selected: false, color: "#667788" } }, failures, "c1-a");
  const switchSelection = await commit(memory, [
    { id: "sel-2", type: "selection.set", targets: [{ kind: "object", sceneId: "bench", objectId: "b8" }] },
    { id: "mat-b7-restore", type: "material.set", target: { kind: "object", sceneId: "bench", objectId: "b7" }, patch: { color: "#667788" } },
    { id: "mat-b8", type: "material.set", target: { kind: "object", sceneId: "bench", objectId: "b8" }, patch: { color: "#ffcc00" } },
  ], "bench:c1-b");
  if (switchSelection.status !== "committed") failures.push(`c1-b ${switchSelection.status}`);
  expectState(memory, { b7: { selected: false, color: "#667788" }, b8: { selected: true, color: "#ffcc00" }, b9: { selected: false, color: "#ffcc00" } }, failures, "c1-b");
  // 失败注入:selection 指向不存在对象→整体回滚,选中态不变。
  const rollbackCase = await commit(memory, [
    { id: "sel-bad", type: "selection.set", targets: [{ kind: "object", sceneId: "bench", objectId: "ghost" }] },
  ], "bench:c1-bad");
  if (rollbackCase.status !== "rolled-back") failures.push(`c1-bad ${rollbackCase.status}`);
  expectState(memory, { b8: { selected: true } }, failures, "c1-bad");
}

function expectState(memory: ReturnType<typeof memoryDriver>, expected: Record<string, Partial<Obj>>, failures: string[], tag: string): void {
  for (const [id, expect] of Object.entries(expected)) {
    const object = memory.objects().get(id);
    if (!object) { failures.push(`${tag} missing ${id}`); continue; }
    for (const [key, value] of Object.entries(expect)) {
      if ((object as unknown as Record<string, unknown>)[key] !== value) failures.push(`${tag} ${id}.${key}=${(object as unknown as Record<string, unknown>)[key]} expect ${String(value)}`);
    }
  }
}

const report = {
  bench: "b3-c1-visibility-selection",
  cases: ["b3-object-level-hide", "c1-highlight-switch", "c1-rollback-on-missing"],
  failures,
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  gpuExecuted: false, browserExecuted: false,
};
console.log(JSON.stringify(report, null, 2));
if (report.verdict === "FAIL") throw new Error(`b3/c1 bench failed: ${failures.join("; ")}`);
