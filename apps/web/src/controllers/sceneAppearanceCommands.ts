import type {
  GlobalLightingState,
  SceneCharacterControllerState,
  SceneEngineeringAnalysisState,
  SceneEnvironmentState,
  SceneLightState,
  SceneMaterialState,
  SceneModelEffectsState,
  ScenePhysicsBodyState,
  ScenePhysicsState,
  ScenePostProcessingState,
  WeatherMode,
} from "@bim-studio/contracts";
import { api } from "../api";
import { lightTypeName } from "../appPresentation";
import { dispatchEngineEditCommand } from "../commands/engineCommandApplier";
import { globalLightingCommand, modelEffectsCommand, modelMaterialCommand, physicsStateCommand,
  sceneEnvironmentCommand, selectionMaterialCommand, selectionVisibilityCommand } from "../commands/engineEditCommand";
import { translate as tr } from "../i18n";
import { applyGroupedOrSelected } from "./sceneAppearanceDispatch";
import type { SceneEditorControllerContext } from "./sceneEditorControllerContext";
import { mergeModelEffectsPatch, type ModelEffectsPatch } from "../viewer/modelEffectState";

const materialTextureSlotTargets = new WeakMap<object, { modelId: string; slotId: string }>();

type SetSceneObjectsVisible = (ids: string[], visible: boolean) => void;

type ScenePhysicsBodyPatch = Omit<Partial<ScenePhysicsBodyState>, "character"> & {
  character?: SceneCharacterControllerState | undefined;
};

/** Applies an editor patch while keeping character settings valid only on kinematic bodies. */
export function mergeScenePhysicsBodyPatch(current: ScenePhysicsBodyState, patch: ScenePhysicsBodyPatch): ScenePhysicsBodyState {
  const { character, ...bodyPatch } = patch;
  const next: ScenePhysicsBodyState = { ...current, ...bodyPatch };
  if (Object.prototype.hasOwnProperty.call(patch, "character")) {
    if (character === undefined) delete next.character;
    else next.character = character;
  }
  if (next.type !== "kinematic") delete next.character;
  return next;
}

/** 环境、灯光、材质和对象外观命令；统一处理单选与编组语义。 */
export function createSceneAppearanceCommands(context: SceneEditorControllerContext, setSceneObjectsVisible: SetSceneObjectsVisible) {
  const {
    engine,
    project,
    locale,
    selected,
    selectedLayerId,
    selectedEffects,
    selectedPhysics,
    sceneEnvironment,
    lighting,
    sceneOrganizationSelection,
    environmentMapRef,
    materialTextureRef,
    materialTextureKindRef,
    setBusy,
    setMessage,
    setRevision,
    setWeather,
    setLighting,
    setSceneEnvironment,
    setPostProcessing,
    setPhysics,
    setEngineeringAnalysis,
    setSelectedLightId,
    showError,
    recordSceneEdit,
  } = context;

  function changeWeather(mode: WeatherMode) {
    setWeather(mode);
    engine?.setWeather(mode);
    recordSceneEdit("更新场景天气");
    setMessage(`天气已切换为${mode === "sunny" ? "晴天" : mode === "rain" ? "下雨" : "下雪"}`);
  }

  function changeLighting(next: GlobalLightingState) {
    setLighting(next);
    dispatchEngineEditCommand(engine, globalLightingCommand(locale, next));
    recordSceneEdit("更新场景灯光");
  }

  function changeSceneEnvironment(next: SceneEnvironmentState) {
    setSceneEnvironment(next);
    dispatchEngineEditCommand(engine, sceneEnvironmentCommand(locale, next));
    recordSceneEdit("更新场景环境");
  }

  function changePostProcessing(next: ScenePostProcessingState) {
    setPostProcessing(next);
    engine?.setPostProcessing(next);
    recordSceneEdit("更新后处理效果");
  }

  function changePhysics(next: ScenePhysicsState) {
    setPhysics(next);
    dispatchEngineEditCommand(engine, physicsStateCommand(locale, next));
    recordSceneEdit("更新场景物理参数");
  }

  /** P5/P7 规则与 QTO 口径：面板受控更新 → 走场景历史（撤销/自动保存同链路）。 */
  function changeEngineeringAnalysis(next: SceneEngineeringAnalysisState) {
    setEngineeringAnalysis(next);
    recordSceneEdit("更新工程分析规则");
  }

  function changeSelectedPhysics(patch: ScenePhysicsBodyPatch) {
    if (!engine || !selected || !selectedPhysics) return;
    const nextPhysics = mergeScenePhysicsBodyPatch(selectedPhysics, patch);
    void engine
      .setPhysicsBodyState(selected.id, nextPhysics)
      .then(() => {
        setRevision((value) => value + 1);
        recordSceneEdit("更新对象物理参数");
        setMessage(patch.type === "dynamic" ? "已设为动态刚体" : patch.type === "fixed" ? "已设为静态碰撞体" : patch.type === "none" ? "已关闭对象物理" : "物理参数已更新");
      })
      .catch(showError);
  }

  async function uploadEnvironmentMap(file?: File) {
    if (!file || !project) return;
    setBusy(true);
    try {
      const uploaded = await api.uploadEnvironmentMap(project.id, file);
      changeSceneEnvironment({ ...sceneEnvironment, environmentMapUrl: uploaded.url, environmentMapName: uploaded.name });
      setMessage(`环境贴图“${uploaded.name}”已应用`);
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
      if (environmentMapRef.current) environmentMapRef.current.value = "";
    }
  }

  function updateLight(id: string, patch: Partial<SceneLightState>) {
    changeLighting({ ...lighting, lights: (lighting.lights ?? []).map((light) => (light.id === id ? { ...light, ...patch } : light)) });
  }

  function addLight(type: SceneLightState["type"]) {
    const id = crypto.randomUUID();
    const light: SceneLightState = {
      id,
      name: `${lightTypeName(type)} ${(lighting.lights?.length ?? 0) + 1}`,
      type,
      enabled: true,
      color: "#ffffff",
      intensity: type === "ambient" ? 0.3 : 1,
      position: { x: 4, y: 6, z: 4 },
      target: { x: 0, y: 0, z: 0 },
      castShadow: ["directional", "point", "spot"].includes(type),
    };
    changeLighting({ ...lighting, lights: [...(lighting.lights ?? []), light] });
    setSelectedLightId(id);
  }

  function removeLight(id: string) {
    changeLighting({ ...lighting, lights: (lighting.lights ?? []).filter((light) => light.id !== id) });
    setSelectedLightId(lighting.lights?.find((light) => light.id !== id)?.id ?? "");
  }

  function updateSelectionMaterial(patch: SceneMaterialState) {
    if (!engine) return;
    const groupedIds = groupedObjectIds();
    if (groupedIds.length > 1) {
      for (const id of groupedIds) dispatchEngineEditCommand(engine, modelMaterialCommand(locale, id, patch));
    } else {
      dispatchEngineEditCommand(engine, selectionMaterialCommand(locale, { modelId: selected?.id ?? "" }, patch));
    }
    setRevision((value) => value + 1);
  }

  function updateSelectedEffects(patch: Partial<SceneModelEffectsState>) {
    if (!engine || !selected || !selectedEffects) return;
    const groupedIds = groupedObjectIds(true);
    for (const id of groupedIds) {
      dispatchEngineEditCommand(engine, modelEffectsCommand(locale, id,
        mergeModelEffectsPatch(engine.getModelEffects(id), patch as ModelEffectsPatch)));
    }
    setRevision((value) => value + 1);
  }

  function updateSelectionColor(color: string) {
    if (!engine || !selected) return;
    applyGroupedOrSelected(
      groupedObjectIds(),
      (id) => engine.isModelLocked(id),
      (id) => engine.setColor(id, color),
      () => engine.setSelectionColor(color),
    );
    setRevision((value) => value + 1);
  }

  function updateSelectionOpacity(opacity: number) {
    if (!engine || !selected) return;
    applyGroupedOrSelected(
      groupedObjectIds(),
      (id) => engine.isModelLocked(id),
      (id) => engine.setOpacity(id, opacity),
      () => engine.setSelectionOpacity(opacity),
    );
    setRevision((value) => value + 1);
  }

  function updateSelectionVisibility(visible: boolean) {
    if (!engine || !selected) return;
    const groupedIds = groupedObjectIds();
    if (groupedIds.length > 1) setSceneObjectsVisible(groupedIds, visible);
    else {
      // 批 2 收编:selection 模式可见性命令,applier 原样转交 setSelectionVisible
      // (其内部分发 fragment 构件/模型根/图层对象的既有语义;target 仅记录选择身份)。
      dispatchEngineEditCommand(
        engine,
        selectionVisibilityCommand(
          locale,
          { modelId: selected.id, ...(selectedLayerId && selectedLayerId !== "root" ? { layerId: selectedLayerId } : {}) },
          visible,
        ),
      );
      setRevision((value) => value + 1);
    }
  }

  async function uploadMaterialTexture(file?: File) {
    if (!file || !project || !selected) return;
    const kind = materialTextureKindRef.current;
    const slotTarget = materialTextureSlotTargets.get(materialTextureKindRef);
    materialTextureSlotTargets.delete(materialTextureKindRef);
    setBusy(true);
    try {
      const asset = await api.uploadImageAsset(project.id, file);
      const patch: SceneMaterialState =
        kind === "baseColor"
          ? { baseColorMapUrl: asset.url, baseColorMapName: asset.name }
          : kind === "normal"
            ? { normalMapUrl: asset.url, normalMapName: asset.name }
            : kind === "emissive"
              ? { emissiveMapUrl: asset.url, emissiveMapName: asset.name }
              : kind === "ambientOcclusion"
                ? { ambientOcclusionMapUrl: asset.url, ambientOcclusionMapName: asset.name }
                : kind === "roughness"
                  ? { roughnessMapUrl: asset.url, roughnessMapName: asset.name }
                  : { metalnessMapUrl: asset.url, metalnessMapName: asset.name };
      if (slotTarget) {
        if (!engine || !engine.listModels().some(model => model.id === slotTarget.modelId) || engine.isModelLocked(slotTarget.modelId)) {
          throw new Error(tr(locale, "目标对象已删除或锁定，贴图未应用", "The target was deleted or locked; texture was not applied"));
        }
        const saved = engine.getModelMaterialOverride(slotTarget.modelId);
        engine.setModelMaterial(slotTarget.modelId, { slotOverrides: { ...saved?.slotOverrides,
          [slotTarget.slotId]: { ...saved?.slotOverrides?.[slotTarget.slotId], ...patch } } });
        setRevision(value => value + 1);
      } else updateSelectionMaterial(patch);
      setMessage(tr(locale, `材质贴图“${asset.name}”已应用`, `Material texture “${asset.name}” applied`));
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
      if (materialTextureRef.current) materialTextureRef.current.value = "";
    }
  }

  function chooseMaterialTexture(kind: SceneEditorControllerContext["materialTextureKindRef"]["current"], slotId?: string) {
    materialTextureSlotTargets.delete(materialTextureKindRef);
    if (slotId && selected) materialTextureSlotTargets.set(materialTextureKindRef, { modelId: selected.id, slotId });
    materialTextureKindRef.current = kind;
    materialTextureRef.current?.click();
  }

  function groupedObjectIds(includeSelected = false): string[] {
    if (!selected) return [];
    if (selectedLayerId && selectedLayerId !== "root") return includeSelected ? [selected.id] : [];
    const grouped = sceneOrganizationSelection.has(selected.id) && sceneOrganizationSelection.size > 1 ? [...sceneOrganizationSelection] : [];
    return grouped.length ? grouped : includeSelected ? [selected.id] : [];
  }

  return {
    changeWeather,
    changeLighting,
    changeSceneEnvironment,
    changePostProcessing,
    changePhysics,
    changeEngineeringAnalysis,
    changeSelectedPhysics,
    uploadEnvironmentMap,
    updateLight,
    addLight,
    removeLight,
    updateSelectionMaterial,
    updateSelectedEffects,
    updateSelectionColor,
    updateSelectionOpacity,
    updateSelectionVisibility,
    uploadMaterialTexture,
    chooseMaterialTexture,
  };
}
