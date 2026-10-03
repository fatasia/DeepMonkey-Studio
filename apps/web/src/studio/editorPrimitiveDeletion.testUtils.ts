import { vi } from "vitest";
import { primitiveCreationHarness } from "./editorPrimitiveCreation.testUtils";
import { fixture as recoveryContext } from "../controllers/sceneRendererRecoveryDomainFixture.testUtils";
import { createSceneEditorController } from "../controllers/sceneEditorController";
import type { SceneEditorControllerContext } from "../controllers/sceneEditorControllerContext";
import { createScenePersistenceController } from "../controllers/scenePersistenceController";
import { SceneAuthoringHistory } from "./sceneAuthoringHistory";
import { createSceneEditTransaction } from "../hooks/useSceneHistoryState";
import { runSceneHistoryTransaction } from "./sceneHistoryTransaction";
import { ViewerSnapshotReadiness } from "../viewer/viewerSnapshotReadiness";
import { normalizeInteractionScripts } from "../interactionState";
import { normalizeSceneDataBindings } from "../sceneDataBindings";
import type { SceneAnnotationState, SceneSnapshot } from "@bim-studio/contracts";

export function deletionFixture() {
  const f = primitiveCreationHarness(), base = recoveryContext(), context = base.context;
  f.engine.removeModel("instance");
  for (const id of ["victim", "keep"]) f.engine.createPrimitive(id, id, "box", id === "victim" ? "#1683ff" : "#55aa77");
  const original = f.models.get("victim")!, sharedGeometry = f.mesh("victim").geometry;
  const ignoredEngineMethods = ["setReadOnly", "setFastRuntime", "setInteractionScripts", "clearMeasurements", "addMeasurementVisual",
    "setCameraConstraints", "setNavigationSettings", "setWeather", "setGlobalLighting", "applyFloorStates", "setPostProcessing",
    "setPhysicsState", "setSceneAnimation", "seekSceneAnimation", "setClipping", "selectAnnotation", "requestRender", "applyCamera", "setSceneEnvironment"];
  for (const key of ignoredEngineMethods) Reflect.set(f.engine, key, Reflect.get(base.engine, key));
  const annotations = new Map<string, SceneAnnotationState>(["victim", "keep"].map((modelId, index) => [modelId, {
    id: modelId, modelId, name: modelId, visible: true, locked: false, position: { x: index, y: 2, z: 0 }, color: "#ffffff", size: 1,
  }]));
  Object.assign(f.engine, {
    snapshotReadiness: new ViewerSnapshotReadiness(), measurementPoints: [], measurementTargets: [],
    originalMaterialTextures: new WeakMap(), modelScreenOriginals: new WeakMap(), updatePostProcessingSelection: vi.fn(),
    getAuthorRendererBackend: () => "webgl", getRendererBackend: () => "webgl",
    clearAnnotations: () => annotations.clear(), listAnnotations: () => [...annotations.values()],
    addAnnotation: (annotation: SceneAnnotationState) => annotations.set(annotation.id, structuredClone(annotation)),
    removeAnnotation: (id: string) => annotations.delete(id),
  });
  f.engine.completeSceneSnapshotRestore(f.engine.beginSceneSnapshotRestore("s"));
  Object.assign(context, { engine: f.engine, project: { id: "p", models: [] }, activeScene: { id: "s", createdAt: "" },
    sceneName: "SDK删除", primitiveColors: { current: new Map([["victim", "#1683ff"], ["keep", "#55aa77"]]) },
    annotations: [...annotations.values()], selectedAnnotationId: "victim", selectionSets: [], rootLayerOrder: undefined,
    sceneAssetBindings: [], selected: undefined, selectedLayerId: undefined,
    sceneInteractions: normalizeInteractionScripts(["victim", "keep"].map(id => ({ id, name: id, enabled: true,
      target: { kind: "object", modelId: id }, trigger: "click", code: "ctx.target.object.visible=false" }))),
    sceneDataBindings: normalizeSceneDataBindings(["victim", "keep"].map(id => ({ id, name: id, enabled: true,
      pipelineId: `${id}-pipe`, field: "opacity", target: { modelId: id }, action: "opacity", refreshSeconds: 5 }))),
    recordSceneEdit: vi.fn(), setSelectedAnnotationId: (update: unknown) => {
      context.selectedAnnotationId = typeof update === "function" ? update(context.selectedAnnotationId) : update as string | undefined;
    },
  });
  for (const [setter, field] of [["setSceneInteractions", "sceneInteractions"], ["setSceneDataBindings", "sceneDataBindings"], ["setAnnotations", "annotations"]]) {
    Reflect.set(context, setter!, (update: unknown) => Reflect.set(context, field!, typeof update === "function" ? update(Reflect.get(context, field!)) : update));
  }
  const persistence = createScenePersistenceController(context), capture = () => persistence.makeSnapshot()!;
  const history = new SceneAuthoringHistory(); history.reset(capture());
  const open = { current: undefined as ReturnType<typeof createSceneEditTransaction> | undefined };
  const flush = () => { if (!open.current) history.record(capture(), "作者编辑"); };
  const controller = createSceneEditorController(context as unknown as SceneEditorControllerContext);
  const authoring = {
    begin: (label: string) => { if (open.current) throw Error("existing author transaction"); return createSceneEditTransaction(open, { flush, capture, record: (snapshot, name) => history.record(snapshot, name) }, label); },
    remove: (id: string) => runSceneHistoryTransaction(() => controller.deletePrimitive(id), flush, change => change()),
    restore: vi.fn(async (snapshot: SceneSnapshot) => persistence.applyScene(snapshot, false, context.project, false, false, false, true)),
  };
  return { ...f, context, original, sharedGeometry, authoring, capture, history, open, annotations };
}
