import { describe, expect, it } from "vitest";
import type { ModelTransform, SceneAnimationState, SceneLayerState, SceneMaterialState } from "@bim-studio/contracts";
import type { SceneCommandPort, SceneCommandPortOutcome } from "../behavior/SceneCommandExecutor";
import { SCENE_COMMAND_APPLIED } from "../behavior/SceneCommandExecutor";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { runEditorSceneTransaction, sceneMetadataDraftPatch, type EditorDriverTransactionRequest } from "./editorSceneWriteDriver";

/** 结构化伪 viewer：只实现 driver 读取面与逆算子写入面，不触三方引擎。 */
function createFakeViewer() {
  const visibility = new Map<string, boolean>([["pump", true]]);
  const transforms = new Map<string, ModelTransform>([["pump", {
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
  }]]);
  const materials = new Map<string, SceneMaterialState>();
  const selection = { modelId: undefined as string | undefined, meshId: undefined as string | undefined };
  const camera = { position: { x: 0, y: 0, z: 10 }, target: { x: 0, y: 1, z: 0 } };
  // H-C7-P3:引擎权威态动画(含状态机锚);伪实现 getSceneAnimation 只读出、setSceneAnimation 全量替换。
  let sceneAnimation: SceneAnimationState = {
    duration: 1, loop: false, camera: [], models: [],
    stateMachine: {
      enabled: true, initialStateId: "idle", activeStateId: "idle", transitionDuration: 0.25,
      states: [
        { id: "idle", name: "Idle", modelId: "pump", clipId: "Idle", loop: true },
        { id: "work", name: "Work", modelId: "pump", clipId: "Work", loop: false }
      ]
    }
  };
  return {
    visibility, transforms, materials, selection, camera,
    getSceneAnimation: (): SceneAnimationState => structuredClone(sceneAnimation),
    setSceneAnimation: (next: SceneAnimationState) => { sceneAnimation = structuredClone(next); },
    listModels: () => [...visibility.entries()].map(([id, visible]) => ({ id, visible })),
    getSelected: () => (selection.modelId ? { id: selection.modelId } : undefined),
    getSelectedLayerId: () => selection.meshId,
    getModelTransform: (id: string) => transforms.get(id),
    getModelMaterialState: (id: string) => materials.get(id),
    getLayerStates: (_modelId: string): SceneLayerState[] => [],
    getCameraState: () => camera,
    getGlobalLighting: () => ({ enabled: true, intensity: 1, shadowsEnabled: true }),
    getSceneEnvironment: () => ({ backgroundColor: "#112233", environmentIntensity: 1 }),
    getWeather: () => "sunny" as const,
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
    setLighting: (_sceneId, patch): SceneCommandPortOutcome => {
      applied.push(`lighting:${JSON.stringify(patch)}`);
      return SCENE_COMMAND_APPLIED;
    },
    setEnvironment: (_sceneId, patch): SceneCommandPortOutcome => {
      applied.push(`environment:${JSON.stringify(patch)}`);
      return SCENE_COMMAND_APPLIED;
    },
    // H-C7-P3:锚迁移伪宿主消费——读权威态校验后全量回写(与 ViewerSceneCommandPort 同构)。
    setAnimationAnchor: (_sceneId, anchor): SceneCommandPortOutcome => {
      const current = viewer.getSceneAnimation();
      const machine = current.stateMachine;
      if (!machine) return { status: "unsupported", message: "fake: 无状态机" };
      const stateIds = new Set(machine.states.map(state => state.id));
      if (anchor.initialStateId !== undefined && !stateIds.has(anchor.initialStateId)) {
        return { status: "unsupported", message: `fake: 初始锚 ${anchor.initialStateId} 不是已声明状态` };
      }
      if (anchor.activeStateId !== undefined && !stateIds.has(anchor.activeStateId)) {
        return { status: "unsupported", message: `fake: 活动锚 ${anchor.activeStateId} 不是已声明状态` };
      }
      viewer.setSceneAnimation({
        ...current,
        stateMachine: {
          ...machine,
          ...(anchor.initialStateId !== undefined ? { initialStateId: anchor.initialStateId } : {}),
          ...(anchor.activeStateId !== undefined ? { activeStateId: anchor.activeStateId } : {}),
        },
      });
      applied.push(`anchor:${JSON.stringify(anchor)}`);
      return SCENE_COMMAND_APPLIED;
    },
  };
  return { port, applied };
}

function transactionRequest(overrides: {
  id?: string; baseRevision?: number; sceneId?: string; commands: readonly unknown[]; capabilities?: readonly string[];
}): EditorDriverTransactionRequest {
  return {
    requestId: "req-1",
    transaction: {
      id: overrides.id ?? "tx-test-1",
      sceneId: overrides.sceneId ?? "scene-1",
      baseRevision: overrides.baseRevision ?? 5,
      module: { id: "test-module", capabilities: overrides.capabilities ?? ["studio.object"], permissions: ["scene.write"] },
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

  it("B5 场景级命令：lighting.set/environment.set 混批经 capturing 端口透传宿主", async () => {
    const harness = createHarness();
    const result = await harness.run(transactionRequest({
      capabilities: ["studio.object", "studio.scene"],
      commands: [
        { id: "cmd-l1", type: "lighting.set", sceneId: "scene-1", patch: { intensity: 0.4, globalIlluminationEnabled: true } },
        { id: "cmd-e1", type: "environment.set", sceneId: "scene-1", patch: { weather: "fog" } },
      ],
    }));
    expect(result.status).toBe("committed");
    expect(harness.applied).toEqual([
      `lighting:${JSON.stringify({ intensity: 0.4, globalIlluminationEnabled: true })}`,
      `environment:${JSON.stringify({ weather: "fog" })}`,
    ]);
  });

  it("B5 fail-closed：宿主端口未实装场景级方法时，capturing 透传回退为 unsupported 并回滚", async () => {
    const viewer = createFakeViewer();
    // 场景级方法缺省的宿主端口（同真实宿主未实装 B5 前的形态）。
    const noOp: SceneCommandPortOutcome = SCENE_COMMAND_APPLIED;
    const port: SceneCommandPort = {
      deletePrimitive: () => ({ status: "unsupported", message: "fake: 未连接" }),
      createPrimitive: () => ({ status: "unsupported", message: "fake: 未连接" }),
      setObjectVisibility: () => noOp,
      setObjectTransform: () => noOp,
      setObjectMaterial: () => noOp,
      setSelection: () => noOp,
      setCamera: () => noOp,
      flyCamera: () => noOp,
      controlAnimation: () => noOp,
      applyData: () => noOp,
      updateComponent: () => noOp,
    };
    let revision = 5;
    const result = await runEditorSceneTransaction({
      sceneId: "scene-1",
      viewer: () => viewer as unknown as ViewerEngine,
      port,
      readRevision: () => revision,
      bumpRevision: () => { revision += 1; },
    }, transactionRequest({
      capabilities: ["studio.object", "studio.scene"],
      commands: [{ id: "cmd-l2", type: "lighting.set", sceneId: "scene-1", patch: { intensity: 0.4 } }],
    }));
    expect(result.status).toBe("rolled-back");
    const receipt = result.receipt as { results: readonly { success: boolean; message?: string }[] };
    expect(receipt.results[0]?.success).toBe(false);
    expect(receipt.results[0]?.message).toContain("场景灯光");
  });

  it("B5 draft 回写拆分：lighting/environment patch 分离，weather 独立且剥离出 environment 合并面", () => {
    const draft = sceneMetadataDraftPatch([
      { id: "a", type: "lighting.set", sceneId: "s", patch: { intensity: 0.4, globalIlluminationEnabled: true } },
      { id: "b", type: "environment.set", sceneId: "s", patch: { weather: "fog", backgroundColor: "#101418", environmentIntensity: 1.4 } },
      { id: "c", type: "object.set-visibility", target: { kind: "object", sceneId: "s", objectId: "x" }, visible: false },
    ]);
    expect(draft.lightingPatch).toEqual({ intensity: 0.4, globalIlluminationEnabled: true });
    expect(draft.environmentPatch).toEqual({ backgroundColor: "#101418", environmentIntensity: 1.4 });
    expect(draft.weather).toBe("fog");
  });

  it("B5 draft 回写拆分：多命令同轴后写覆盖先写，非法与非场景级命令忽略", () => {
    const draft = sceneMetadataDraftPatch([
      { id: "a", type: "lighting.set", sceneId: "s", patch: { intensity: 1 } },
      { id: "b", type: "lighting.set", sceneId: "s", patch: { intensity: 0.4, shadowsEnabled: true } },
      { id: "c", type: "environment.set", sceneId: "s", patch: { weather: "不存在的天气" } },
      { id: "d", type: "camera.set", sceneId: "s", position: [0, 0, 0], target: [0, 0, 0] },
      "not-an-object",
    ]);
    expect(draft.lightingPatch).toEqual({ intensity: 0.4, shadowsEnabled: true });
    expect(draft.environmentPatch).toBeUndefined();
    expect(draft.weather).toBeUndefined();
  });

  it("H-C7-P3：animation.set-anchor 经 capturing 透传宿主并写引擎权威态，draft 拆出锚合并面", async () => {
    const harness = createHarness();
    const result = await harness.run(transactionRequest({
      capabilities: ["studio.animation"],
      commands: [{ id: "cmd-a1", type: "animation.set-anchor", sceneId: "scene-1", anchor: { initialStateId: "work", activeStateId: "work" } }],
    }));
    expect(result.status).toBe("committed");
    expect(harness.applied).toEqual([`anchor:${JSON.stringify({ initialStateId: "work", activeStateId: "work" })}`]);
    expect(harness.viewer.getSceneAnimation().stateMachine).toMatchObject({ initialStateId: "work", activeStateId: "work" });
    expect(sceneMetadataDraftPatch([
      { id: "cmd-a1", type: "animation.set-anchor", sceneId: "scene-1", anchor: { initialStateId: "work", activeStateId: "work" } },
      { id: "other", type: "object.set-visibility", target: { kind: "object", sceneId: "s", objectId: "x" }, visible: false },
      "not-an-object",
    ]).animationAnchorPatch).toEqual({ initialStateId: "work", activeStateId: "work" });
    // 未给出的锚不进合并面。
    expect(sceneMetadataDraftPatch([
      { id: "cmd-a2", type: "animation.set-anchor", sceneId: "scene-1", anchor: { activeStateId: "idle" } },
    ]).animationAnchorPatch).toEqual({ activeStateId: "idle" });
    expect(sceneMetadataDraftPatch([{ id: "bad", type: "animation.set-anchor", sceneId: "s", anchor: { initialStateId: "  " } }]).animationAnchorPatch).toBeUndefined();
  });

  it("H-C7-P3：批次内后续命令失败时，锚迁移按旧锚逆算子回退", async () => {
    const harness = createHarness();
    const meshTransform = { id: "cmd-bad", type: "object.set-transform", target: { kind: "mesh", sceneId: "scene-1", objectId: "pump", meshId: "shell" }, position: [1, 2, 3] };
    const result = await harness.run(transactionRequest({
      capabilities: ["studio.object", "studio.animation"],
      commands: [
        { id: "cmd-a3", type: "animation.set-anchor", sceneId: "scene-1", anchor: { initialStateId: "work", activeStateId: "work" } },
        meshTransform,
      ],
    }));
    expect(result.status).toBe("rolled-back");
    // 旧锚(idle/idle)被绝对值逆算子恢复。
    expect(harness.viewer.getSceneAnimation().stateMachine).toMatchObject({ initialStateId: "idle", activeStateId: "idle" });
  });

  it("H-C7-P3 fail-closed：宿主端口未实装锚迁移或无捕获面时回退 unsupported 并回滚", async () => {
    const viewer = createFakeViewer();
    const noOp: SceneCommandPortOutcome = SCENE_COMMAND_APPLIED;
    const port: SceneCommandPort = {
      deletePrimitive: () => ({ status: "unsupported", message: "fake: 未连接" }),
      createPrimitive: () => ({ status: "unsupported", message: "fake: 未连接" }),
      setObjectVisibility: () => noOp,
      setObjectTransform: () => noOp,
      setObjectMaterial: () => noOp,
      setSelection: () => noOp,
      setCamera: () => noOp,
      flyCamera: () => noOp,
      controlAnimation: () => noOp,
      applyData: () => noOp,
      updateComponent: () => noOp,
    };
    let revision = 5;
    const result = await runEditorSceneTransaction({
      sceneId: "scene-1",
      viewer: () => viewer as unknown as ViewerEngine,
      port,
      readRevision: () => revision,
      bumpRevision: () => { revision += 1; },
    }, transactionRequest({
      capabilities: ["studio.animation"],
      commands: [{ id: "cmd-a4", type: "animation.set-anchor", sceneId: "scene-1", anchor: { initialStateId: "work" } }],
    }));
    expect(result.status).toBe("rolled-back");
    const receipt = result.receipt as { results: readonly { success: boolean; message?: string }[] };
    expect(receipt.results[0]?.success).toBe(false);
    expect(receipt.results[0]?.message).toContain("状态机锚迁移");
    expect(viewer.getSceneAnimation().stateMachine).toMatchObject({ initialStateId: "idle", activeStateId: "idle" });

    // 捕获面缺失(reader 无 getSceneAnimation):不执行修改,保持旧锚。独立 harness,
    // 复用前一事务 bump 过的 revision 会让 baseRevision 过期而走 rejected。
    const { getSceneAnimation: _omitCapture, ...bareViewer } = createFakeViewer();
    void _omitCapture;
    let bareRevision = 5;
    const captureless = await runEditorSceneTransaction({
      sceneId: "scene-1",
      viewer: () => bareViewer as unknown as ViewerEngine,
      port: { ...port, setAnimationAnchor: () => noOp },
      readRevision: () => bareRevision,
      bumpRevision: () => { bareRevision += 1; },
    }, transactionRequest({
      capabilities: ["studio.animation"],
      commands: [{ id: "cmd-a5", type: "animation.set-anchor", sceneId: "scene-1", anchor: { initialStateId: "work" } }],
    }));
    expect(captureless.status).toBe("rolled-back");
    const capturelessReceipt = captureless.receipt as { results: readonly { success: boolean; message?: string }[] };
    expect(capturelessReceipt.results[0]?.message).toContain("无法捕获可恢复的状态机锚");
  });
});
