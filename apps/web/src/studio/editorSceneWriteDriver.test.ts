import { describe, expect, it } from "vitest";
import type { ModelTransform, SceneLayerState, SceneMaterialState } from "@bim-studio/contracts";
import type { SceneCommandPort, SceneCommandPortOutcome } from "../behavior/SceneCommandExecutor";
import { SCENE_COMMAND_APPLIED } from "../behavior/SceneCommandExecutor";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { runEditorSceneTransaction, type EditorDriverTransactionRequest } from "./editorSceneWriteDriver";

/** 结构化伪 viewer：只实现 driver 读取面与逆算子写入面，不触三方引擎。 */
function createFakeViewer() {
  const visibility = new Map<string, boolean>([["pump", true]]);
  const transforms = new Map<string, ModelTransform>([["pump", {
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
  }]]);
  const materials = new Map<string, SceneMaterialState>();
  const selection = { modelId: undefined as string | undefined, meshId: undefined as string | undefined };
  const camera = { position: { x: 0, y: 0, z: 10 }, target: { x: 0, y: 1, z: 0 } };
  return {
    visibility, transforms, materials, selection, camera,
    listModels: () => [...visibility.entries()].map(([id, visible]) => ({ id, visible })),
    getSelected: () => (selection.modelId ? { id: selection.modelId } : undefined),
    getSelectedLayerId: () => selection.meshId,
    getModelTransform: (id: string) => transforms.get(id),
    getModelMaterialState: (id: string) => materials.get(id),
    getLayerStates: (_modelId: string): SceneLayerState[] => [],
    getCameraState: () => camera,
    setVisible: (id: string, visible: boolean) => { visibility.set(id, visible); },
    setLayerVisible: () => undefined,
    setModelTransform: (id: string, patch: { position?: [number, number, number] }) => {
      const base = transforms.get(id)!;
      transforms.set(id, { ...base, ...(patch.position ? { position: { x: patch.position[0]!, y: patch.position[1]!, z: patch.position[2]! } } : {}) });
    },
    setModelMaterial: (id: string, material: SceneMaterialState) => { materials.set(id, material); },
    select: (id: string | undefined) => { selection.modelId = id; selection.meshId = undefined; },
    selectLayer: (modelId: string, meshId: string) => { selection.modelId = modelId; selection.meshId = meshId; },
    setCameraPose: (pose: { position: [number, number, number]; target: [number, number, number] }) => {
      camera.position = { x: pose.position[0]!, y: pose.position[1]!, z: pose.position[2]! };
      camera.target = { x: pose.target[0]!, y: pose.target[1]!, z: pose.target[2]! };
    },
  };
}

type FakeViewer = ReturnType<typeof createFakeViewer>;

/** 伪端口：可见性真实落到伪 viewer；mesh 变换同真实端口语义返回 unsupported。 */
function createFakePort(viewer: FakeViewer) {
  const applied: string[] = [];
  const port: SceneCommandPort = {
    setObjectVisibility: (target, visible): SceneCommandPortOutcome => {
      if (target.kind !== "object") return { status: "unsupported", message: "fake: 仅对象" };
      viewer.setVisible(target.objectId, visible);
      applied.push(`visibility:${target.objectId}=${visible}`);
      return SCENE_COMMAND_APPLIED;
    },
    setObjectTransform: (target): SceneCommandPortOutcome => {
      if (target.kind !== "object") return { status: "unsupported", message: "fake: mesh 变换未开放" };
      viewer.setModelTransform(target.objectId, {});
      applied.push(`transform:${target.objectId}`);
      return SCENE_COMMAND_APPLIED;
    },
    setObjectMaterial: (): SceneCommandPortOutcome => SCENE_COMMAND_APPLIED,
    setSelection: (targets): SceneCommandPortOutcome => {
      applied.push(`selection:${targets.length}`);
      return SCENE_COMMAND_APPLIED;
    },
    setCamera: (): SceneCommandPortOutcome => SCENE_COMMAND_APPLIED,
    flyCamera: (): SceneCommandPortOutcome => SCENE_COMMAND_APPLIED,
    controlAnimation: (): SceneCommandPortOutcome => ({ status: "unsupported", message: "fake: 无动画" }),
    applyData: (): SceneCommandPortOutcome => SCENE_COMMAND_APPLIED,
    updateComponent: (): SceneCommandPortOutcome => SCENE_COMMAND_APPLIED,
  };
  return { port, applied };
}

function transactionRequest(overrides: {
  id?: string; baseRevision?: number; sceneId?: string; commands: readonly unknown[];
}): EditorDriverTransactionRequest {
  return {
    requestId: "req-1",
    transaction: {
      id: overrides.id ?? "tx-test-1",
      sceneId: overrides.sceneId ?? "scene-1",
      baseRevision: overrides.baseRevision ?? 5,
      module: { id: "test-module", capabilities: ["studio.object"], permissions: ["scene.write"] },
      commands: overrides.commands,
    },
  };
}

const hidePump = { id: "cmd-1", type: "object.set-visibility", target: { kind: "object", sceneId: "scene-1", objectId: "pump" }, visible: false };

function createHarness(baseRevision = 5) {
  const viewer = createFakeViewer();
  const { port, applied } = createFakePort(viewer);
  let revision = baseRevision;
  const run = (request: EditorDriverTransactionRequest) => runEditorSceneTransaction({
    sceneId: "scene-1",
    viewer: () => viewer as unknown as ViewerEngine,
    port,
    readRevision: () => revision,
    bumpRevision: () => { revision += 1; },
  }, request);
  return { viewer, applied, run, revision: () => revision };
}

describe("editor scene write driver", () => {
  it("prepare 失败：命令结构非法时整批拒绝，不触碰场景", async () => {
    const harness = createHarness();
    const result = await harness.run(transactionRequest({
      commands: [{ id: "cmd-bad", type: "object.set-visibility", target: { kind: "object", sceneId: "scene-1", objectId: "pump" } }],
    }));
    expect(result.status).toBe("rejected");
    expect(result.issues?.some(issue => (issue as { reason?: string }).reason === "parse-error")).toBe(true);
    expect(harness.applied).toEqual([]);
    expect(harness.viewer.visibility.get("pump")).toBe(true);
    expect(harness.revision()).toBe(5);
  });

  it("apply 冲突：baseRevision 与当前 revision 漂移时拒绝且不执行", async () => {
    const harness = createHarness(8);
    const result = await harness.run(transactionRequest({ baseRevision: 5, commands: [hidePump] }));
    expect(result.status).toBe("rejected");
    expect((result.issue as { reason?: string }).reason).toBe("revision-conflict");
    expect(harness.applied).toEqual([]);
    expect(harness.viewer.visibility.get("pump")).toBe(true);
  });

  it("rollback：批次内部分命令失败时，已应用命令按逆算子回退", async () => {
    const harness = createHarness();
    const meshTransform = { id: "cmd-2", type: "object.set-transform", target: { kind: "mesh", sceneId: "scene-1", objectId: "pump", meshId: "shell" }, position: [1, 2, 3] };
    const result = await harness.run(transactionRequest({ commands: [hidePump, meshTransform] }));
    expect(result.status).toBe("rolled-back");
    expect((result.issue as { reason?: string }).reason).toBe("driver-error");
    const receipt = result.receipt as { finalRevision: number; status: string };
    expect(receipt.status).toBe("rolled-back");
    expect(receipt.finalRevision).toBe(7);
    expect(harness.applied).toEqual(["visibility:pump=false"]);
    expect(harness.viewer.visibility.get("pump")).toBe(true);
  });

  it("committed：全部命令成功时 receipt 记录前进后的 revision", async () => {
    const harness = createHarness();
    const second = { id: "cmd-2", type: "object.set-visibility", target: { kind: "object", sceneId: "scene-1", objectId: "fan" }, visible: false };
    const result = await harness.run(transactionRequest({ commands: [hidePump, second] }));
    expect(result.status).toBe("committed");
    const receipt = result.receipt as { finalRevision: number; baseRevision: number; commandIds: string[] };
    expect(receipt.baseRevision).toBe(5);
    expect(receipt.finalRevision).toBe(6);
    expect(receipt.commandIds).toEqual(["cmd-1", "cmd-2"]);
    expect(harness.viewer.visibility.get("pump")).toBe(false);
    expect(harness.viewer.visibility.get("fan")).toBe(false);
  });

  it("fail-closed：事务场景与活跃场景不一致时直接拒绝", async () => {
    const harness = createHarness();
    const result = await harness.run(transactionRequest({ sceneId: "scene-9", commands: [hidePump] }));
    expect(result.status).toBe("rejected");
    expect((result.issue as { reason?: string }).reason).toBe("scene-mismatch");
    expect(harness.applied).toEqual([]);
  });
});
