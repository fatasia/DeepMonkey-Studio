import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { SceneSelectionSetState, SceneSnapshot } from "@bim-studio/contracts";
import { useSceneHistoryState } from "../src/hooks/useSceneHistoryState";
import { createSceneOrganizationCommands } from "../src/controllers/sceneOrganizationCommands";
import type { SceneEditorControllerContext } from "../src/controllers/sceneEditorControllerContext";

const initialGroup: SceneSelectionSetState = { id: "group", name: "初始", kind: "group", objectIds: ["a", "b"] };
const baseline: SceneSnapshot = {
  schemaVersion: 1, id: "history-test", projectId: "fixture", name: "初始场景",
  camera: { position: { x: 6, y: 5, z: 6 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
  models: [], primitives: [], measurements: [], selectionSets: [initialGroup],
  createdAt: "2026-09-21T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z",
};

/** 本页用真实 React 提交与真实历史栈复验，单次点击内执行两次动作，避免工具延迟掩盖220ms缺陷。 */
function HistoryFixture() {
  const [groups, setGroups] = useState([initialGroup]);
  const [name, setName] = useState(baseline.name);
  const [, setRevision] = useState(0);
  const [result, setResult] = useState("ready");
  const history = useSceneHistoryState({ activeScene: baseline, routeView: "studio", sceneBehaviorActive: false, animationPlaying: false });
  history.sceneSnapshotFactoryRef.current = () => ({ ...baseline, name, selectionSets: groups });
  const commands = createSceneOrganizationCommands({
    locale: "zh-CN", selectionSets: groups, setSelectionSets: setGroups, setRevision,
    sceneOrganizationObjects: ["a", "b"].map(id => ({ id, name: id, kind: "primitive", visible: true, locked: false })),
    sceneOrganizationSelection: new Set(["a", "b"]), setMessage: () => undefined,
    recordSceneEdit: (label: string) => history.sceneHistoryRecordRef.current(label),
    runSceneEdit: history.runSceneHistoryEdit,
  } as unknown as SceneEditorControllerContext);
  function verify() {
    const started = performance.now();
    commands.renameSceneGroup("group", "第一次");
    commands.renameSceneGroup("group", "第二次");
    const elapsedMs = performance.now() - started;
    const stack = history.sceneHistoryRef.current;
    const firstUndo = stack.undo()?.selectionSets?.[0]?.name;
    const secondUndo = stack.undo()?.selectionSets?.[0]?.name;
    const firstRedo = stack.redo()?.selectionSets?.[0]?.name;
    const secondRedo = stack.redo()?.selectionSets?.[0]?.name;
    const noOpBefore = JSON.stringify(stack.getState());
    commands.renameSceneGroup("group", "第二次");
    const noOpPreserved = JSON.stringify(stack.getState()) === noOpBefore;
    const passed = firstUndo === "第一次" && secondUndo === "初始" && firstRedo === "第一次" && secondRedo === "第二次" && noOpPreserved && elapsedMs < 220;
    setResult(JSON.stringify({ passed, elapsedMs, firstUndo, secondUndo, firstRedo, secondRedo, noOpPreserved }));
  }
  return <main>
    <h1>场景历史事务验收</h1>
    <p>编组名称：{groups[0]?.name}</p>
    <button onClick={verify}>验证连续两次离散动作</button>
    <button onClick={() => { setName("连续变化一"); history.sceneHistoryRecordRef.current("连续变换"); setName("连续变化二"); history.sceneHistoryRecordRef.current("连续变换"); }}>执行连续变化</button>
    <button onClick={() => { history.flushSceneHistoryEdit(); const stack = history.sceneHistoryRef.current; const undone = stack.undo(); const exhausted = !stack.getState().canUndo; setResult(JSON.stringify({ continuousUndoName: undone?.name, exhausted })); }}>验证连续变化合并</button>
    <output aria-label="验收结果">{result}</output>
  </main>;
}

if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<HistoryFixture />);
