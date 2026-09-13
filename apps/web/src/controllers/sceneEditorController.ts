import type {
  CameraConstraintsState,
  CameraViewState,
  ClippingState,
  ExplosionMode,
  GlobalLightingState,
  IndustrialPrefabDefinition,
  MeasurementState,
  ModelRecord,
  ModelTransform,
  NavigationSettingsState,
  PrimitiveKind,
  ProjectRecord,
  RvtConversionMode,
  SceneAnnotationState,
  SceneCoordinateSystemState,
  SceneDataBindingState,
  SceneEnvironmentState,
  SceneFloorState,
  SceneInteractionScriptState,
  SceneLightState,
  SceneMaterialState,
  SceneModelEffectsState,
  ScenePhysicsBodyState,
  ScenePhysicsState,
  ScenePostProcessingState,
  WeatherMode,
} from "@bim-studio/contracts";
import { api } from "../api";
import { normalizeNavigationSettings } from "../navigationSettings";
import { explosionModeName, lightTypeName, primitiveKindLabel } from "../appPresentation";
import { translate as tr, type AppLocale } from "../i18n";
import { normalizeCameraConstraints } from "../appDefaults";
import { projectToWorld, worldToProject } from "../viewer/sceneCoordinates";
import type { DeviceBoxDraft } from "../deviceLayout/deviceLayout";
import type { ComponentRecord, LoadedSceneModel, MeasureMode, NavigationMode, TransformMode, ViewerEngine } from "../viewer/ViewerEngine";
import { createBrowserCooperativeWorkScheduler } from "../cooperativeWorkScheduler";
import type { SceneEditorControllerContext } from "./sceneEditorControllerContext";
import { createSceneAnimationCommands } from "./sceneAnimationCommands";
import { createSceneAppearanceCommands } from "./sceneAppearanceCommands";
import { createSceneOrganizationCommands } from "./sceneOrganizationCommands";
import { layoutSceneSelection, type SceneSelectionLayoutAxis, type SceneSelectionLayoutMode } from "./sceneSelectionLayout";
import { createIndustrialPrefabInstance, industrialPrefabPrimitiveVisual } from "../prefabs/industrialPrefabInstance";
import { waitForOptimizerModel } from "../optimizer/modelOptimizerAssets";

function isModelLoadSuperseded(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "ModelLoadSupersededError";
}

/** 三维作者操作的统一控制器；UI 只表达意图，场景副作用集中在此处。 */
export function createSceneEditorController(context: SceneEditorControllerContext) {
  const {
    engine,
    project,
    locale,
    selected,
    selectedLayerId,
    selectedEffects,
    selectedPhysics,
    sceneCoordinates,
    sceneEnvironment,
    lighting,
    clipping,
    explosionMode,
    floorStatesByModel,
    sceneOrganizationSelection,
    annotations,
    annotationEnabled,
    measureEnabled,
    measureMode,
    navigationSettings,
    cameraViews,
    cameraConstraints,
    rvtConversionMode,
    rvtRevitVersion,
    uploadRef,
    environmentMapRef,
    materialTextureRef,
    materialTextureKindRef,
    primitiveColors,
    refreshProject,
    showError,
    setUploading,
    setBusy,
    setMessage,
    setRevision,
    setSelected,
    setMeasurements,
    setAnnotations,
    setAnnotationEnabled,
    setSelectedAnnotationId,
    setSceneInteractions,
    setSceneDataBindings,
    setNavigationMode,
    setTransformMode,
    setMeasureEnabled,
    setMeasureMode,
    setClippingState,
    setWeather,
    setLighting,
    setSceneEnvironment,
    setPostProcessing,
    setPhysics,
    setEnvironmentOpen,
    setSelectedLightId,
    setCameraViews,
    setCameraConstraints,
    setDefaultCameraViewId,
    setNavigationSettings,
    setFloorExpansionByModel,
    setExpandedModels,
    setSceneOrganizationSelection,
    setXrPanelOpen,
    recordSceneEdit,
  } = context;
  const organizationCommands = createSceneOrganizationCommands(context);
  const animationCommands = createSceneAnimationCommands(context);
  const { setSceneObjectsVisible } = organizationCommands;
  const appearanceCommands = createSceneAppearanceCommands(context, setSceneObjectsVisible);

  async function loadModel(model: ModelRecord, silent = false, instanceId = model.id): Promise<LoadedSceneModel | undefined> {
    if (!engine) return;
    const occupied = engine.listModels().find(item => item.id === instanceId);
    // 替换后旧资源 ID 仍是另一素材的稳定实例 ID；再插入旧资源必须建立独立实例。
    if (!silent && instanceId === model.id && occupied && (occupied.assetModelId ?? occupied.id) !== model.id) instanceId = crypto.randomUUID();
    if (model.status !== "ready" || !model.manifest) {
      setMessage(model.message);
      return;
    }
    if (!silent) {
      setBusy(true);
      setMessage(`正在加载 ${model.name}`);
    }
    try {
      const existed = engine.listModels().some(item => item.id === instanceId);
      const loaded = instanceId === model.id ? await engine.loadManifest(model.manifest) : await engine.loadManifest(model.manifest, instanceId);
      if (!silent) {
        engine.select(instanceId);
        setSceneOrganizationSelection(new Set([instanceId]));
      }
      setRevision((value) => value + 1);
      if (!silent) setMessage(`${model.name} 已加载`);
      if (!silent && !existed) { engine.focusModel(instanceId); recordSceneEdit(`添加模型“${model.name}”`); }
      return loaded;
    } catch (reason) {
      if (isModelLoadSuperseded(reason)) return;
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function uploadModels(files?: FileList | File[], robotEntries?: ReadonlyMap<File, string>): Promise<ModelRecord[]> {
    if (!files?.length || !project) return [];
    const uploadedModels: ModelRecord[] = [];
    const readyModels: ModelRecord[] = [];
    setUploading(true);
    try {
      for (const [index, file] of [...files].entries()) {
        setMessage(`正在上传 ${file.name}（${index + 1}/${files.length}）`);
        uploadedModels.push(await api.uploadModel(project.id, file, rvtConversionMode, rvtRevitVersion, undefined, robotEntries?.get(file)));
      }
      for (const [index, uploaded] of uploadedModels.entries()) {
        const authoritativeProject = await waitForOptimizerModel(
          project.id,
          uploaded.id,
          (message) => setMessage(`${uploaded.name}（${index + 1}/${uploadedModels.length}）：${message}`),
        );
        const ready = authoritativeProject.models.find((model) => model.id === uploaded.id);
        if (!ready?.manifest || ready.status !== "ready") throw new Error(`${uploaded.name} 尚未生成可插入资源`);
        readyModels.push(ready);
      }
      await refreshProject();
      setMessage(`${readyModels.length} 个模型已就绪，可直接插入或进入优化`);
      return readyModels;
    } catch (reason) {
      showError(reason);
      return readyModels;
    } finally {
      setUploading(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  }

  async function deleteModel(model: ModelRecord) {
    if (!project) return;
    if (engine?.listModels().some(item => item.kind === "model" && (item.assetModelId ?? item.id) === model.id)) {
      setMessage("此素材仍在当前场景使用，请先移除实例并保存场景；素材未删除");
      return;
    }
    try {
      await api.deleteModel(project.id, model.id);
      await refreshProject();
      setMessage(`${model.name} 已删除`);
      setRevision((value) => value + 1);
    } catch (reason) {
      showError(reason);
    }
  }

  function beginPrimitivePlacement(kind: PrimitiveKind) {
    if (!engine) return;
    engine.startPrimitivePlacement(kind);
    setMessage(`请在模型表面或地面点击，放置${primitiveKindLabel(kind, locale)}`);
  }

  function insertIndustrialPrefab(definition: IndustrialPrefabDefinition) {
    if (!engine) return;
    const usedIds = new Set(engine.listModels().map((model) => model.id));
    const modelId = uniqueSceneObjectId(`prefab:${definition.id}`, usedIds);
    const name = tr(locale, definition.name, definition.englishName);
    const visual = industrialPrefabPrimitiveVisual(definition.kind);
    const target = engine.getCameraState().target;
    const start = { x: target.x, y: target.y, z: target.z };
    engine.createPrimitive(modelId, name, visual.primitive, visual.color);
    engine.setModelTransform(modelId, {
      position: [start.x, start.y + visual.centerHeight, start.z],
      rotation: visual.rotation ?? [0, 0, 0],
      scale: visual.scale,
    });
    engine.setIndustrialPrefabState(modelId, createIndustrialPrefabInstance(definition, start));
    primitiveColors.current.set(modelId, visual.color);
    engine.select(modelId);
    setSceneOrganizationSelection(new Set([modelId]));
    engine.focusModel(modelId);
    setRevision((value) => value + 1);
    recordSceneEdit(tr(locale, `插入资源“${name}”`, `Inserted resource “${name}”`));
    setMessage(tr(locale, `已插入“${name}”，可在右侧配置参数、动作与数据口`, `Inserted “${name}”; configure parameters, actions and data ports in the inspector`));
  }

  async function createDeviceLayout(devices: DeviceBoxDraft[], createLabels: boolean) {
    if (!engine || devices.length === 0) return;
    const usedIds = new Set(engine.listModels().map((model) => model.id));
    const newAnnotations: SceneAnnotationState[] = [];
    const workScheduler = createBrowserCooperativeWorkScheduler();
    let lastModelId: string | undefined;
    for (const [index, device] of devices.entries()) {
      const modelId = uniqueSceneObjectId(`equipment:${device.id}`, usedIds);
      engine.createPrimitive(modelId, device.name, "box", device.color);
      engine.setModelTransform(modelId, {
        position: [device.position.x, device.position.y + device.size.height / 2, device.position.z],
        rotation: [0, (device.rotationY * Math.PI) / 180, 0],
        // 基础 box 的边长为 2，因此缩放值为实际尺寸的一半。
        scale: [device.size.width / 2, device.size.height / 2, device.size.depth / 2],
      });
      primitiveColors.current.set(modelId, device.color);
      lastModelId = modelId;
      if (createLabels) {
        const annotation: SceneAnnotationState = {
          id: `annotation:${modelId}`,
          name: device.name,
          description: `${device.category} · ${device.id}`,
          position: { x: device.position.x, y: device.position.y + device.size.height + 0.3, z: device.position.z },
          color: device.color,
          visible: true,
          locked: false,
          size: 0.85,
          modelId,
          anchorName: device.id,
        };
        engine.addAnnotation(annotation);
        newAnnotations.push(annotation);
      }
      if (await workScheduler.checkpoint()) {
        setMessage(tr(locale, `正在创建设备 ${index + 1}/${devices.length}`, `Creating devices ${index + 1}/${devices.length}`));
      }
    }
    if (newAnnotations.length > 0) setAnnotations((items) => [...items, ...newAnnotations]);
    if (lastModelId) {
      engine.select(lastModelId);
      setSceneOrganizationSelection(new Set([lastModelId]));
    }
    engine.fitAll();
    setRevision((value) => value + 1);
    recordSceneEdit(tr(locale, `批量创建设备 ${devices.length} 台`, `Created ${devices.length} devices`));
    setMessage(tr(locale, `已创建 ${devices.length} 台设备${createLabels ? "及关联标签" : ""}`, `Created ${devices.length} devices${createLabels ? " with linked labels" : ""}`));
  }

  function deletePrimitive(id: string) {
    engine?.removeModel(id);
    removeObjectInteractions(id);
    primitiveColors.current.delete(id);
    const linkedAnnotationIds = annotations.filter((item) => item.modelId === id).map((item) => item.id);
    for (const annotationId of linkedAnnotationIds) engine?.removeAnnotation(annotationId);
    if (linkedAnnotationIds.length > 0) {
      const removedIds = new Set(linkedAnnotationIds);
      setAnnotations((items) => items.filter((item) => !removedIds.has(item.id)));
      setSelectedAnnotationId((current) => (current && removedIds.has(current) ? undefined : current));
    }
    setRevision((value) => value + 1);
    recordSceneEdit("删除基础元素及关联标签");
    setMessage(linkedAnnotationIds.length > 0 ? `基础元素及 ${linkedAnnotationIds.length} 个关联标签已删除` : "基础元素已从场景删除");
  }

  function removeObjectInteractions(modelId: string, layerId?: string) {
    setSceneInteractions((items) =>
      items.filter((script) => script.target.kind !== "object" || script.target.modelId !== modelId || (layerId !== undefined && script.target.layerId !== layerId)),
    );
    setSceneDataBindings((items) => items.filter((binding) => binding.target.modelId !== modelId || (layerId !== undefined && binding.target.layerId !== layerId)));
  }

  function deleteMeasurement(id: string) {
    engine?.deleteMeasurement(id);
    setMeasurements((items) => items.filter((measurement) => measurement.id !== id));
    setMessage("标尺已从场景删除");
  }

  function toggleAnnotationPlacement() {
    if (!engine) return;
    const next = !annotationEnabled;
    setAnnotationEnabled(next);
    engine.setAnnotationPlacementEnabled(next);
    if (next) {
      setMeasureEnabled(false);
      engine.setMeasureEnabled(false);
      setNavigationMode("orbit");
      engine.setNavigationMode("orbit");
    }
    setMessage(next ? "标签工具：点击模型表面或地面放置标签" : "已退出标签放置");
  }

  function updateAnnotation(id: string, patch: Partial<Omit<SceneAnnotationState, "id">>) {
    const next = engine?.updateAnnotation(id, patch);
    if (!next) return;
    setAnnotations((items) => items.map((item) => (item.id === id ? next : item)));
    setRevision((value) => value + 1);
    recordSceneEdit("更新模型标签");
  }

  function updateAnnotationPosition(annotation: SceneAnnotationState, axis: "x" | "y" | "z", rawValue: string) {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || annotation.locked) return;
    updateAnnotation(annotation.id, { position: { ...annotation.position, [axis]: value } });
  }

  function deleteAnnotation(id: string) {
    const annotation = annotations.find((item) => item.id === id);
    if (!annotation || annotation.locked) return;
    engine?.removeAnnotation(id);
    setAnnotations((items) => items.filter((item) => item.id !== id));
    setSelectedAnnotationId(undefined);
    recordSceneEdit("删除模型标签");
    setMessage("标签已从场景删除");
  }

  function changeNavigation(mode: NavigationMode) {
    engine?.setNavigationMode(mode);
    setNavigationMode(mode);
    setMeasureEnabled(false);
    engine?.setMeasureEnabled(false);
    setAnnotationEnabled(false);
    engine?.setAnnotationPlacementEnabled(false);
    setMessage(
      mode === "orbit"
        ? tr(locale, "已回到轨道浏览，可继续选择和编辑对象", "Orbit mode restored; object editing is available")
        : mode === "firstPerson"
          ? tr(
              locale,
              cameraConstraints.collisionEnabled ? "第一人称已开启，双击画面开始行走" : "第一人称已开启；防穿模当前关闭",
              cameraConstraints.collisionEnabled ? "First person ready; double-click the viewport to walk" : "First person ready; collision protection is off",
            )
          : tr(locale, "第三人称已开启，可自由巡检场景", "Third person ready for free-flight inspection"),
    );
  }

  function changeTransform(mode: TransformMode) {
    engine?.setTransformMode(mode);
    setTransformMode(mode);
  }

  function toggleMeasurement() {
    const next = !measureEnabled;
    setMeasureEnabled(next);
    engine?.setMeasureEnabled(next, measureMode);
    if (next) {
      setAnnotationEnabled(false);
      engine?.setAnnotationPlacementEnabled(false);
    }
    setMessage(next ? "依次点击两个位置进行测量" : "已退出测量");
  }

  function changeMeasureMode(mode: MeasureMode) {
    setMeasureMode(mode);
    setMeasureEnabled(true);
    engine?.setMeasureEnabled(true, mode);
    setAnnotationEnabled(false);
    engine?.setAnnotationPlacementEnabled(false);
    setMessage(
      mode === "elevation"
        ? "标高测量：点击模型上的位置"
        : mode === "angle"
          ? "角度测量：依次点击顶点、第一条边、第二条边"
          : mode === "minimum"
            ? "最小距离：依次点击两个构件"
            : "距离测量：依次点击起点和终点",
    );
  }

  function focusComponent(record: ComponentRecord) {
    setExpandedModels((current) => new Set(current).add(record.modelId));
    engine?.focusComponent(record);
    setMessage(`已定位构件“${record.name}”`);
    setRevision((value) => value + 1);
  }

  function updateClipping(patch: Partial<ClippingState>) {
    if (!engine) return;
    const next = { ...clipping, ...patch };
    if (patch.axis && patch.offset === undefined) {
      const range = engine.getClippingRange(patch.axis);
      next.offset = (range.min + range.max) / 2;
    }
    setClippingState(next);
    engine.setClipping(next);
  }

  function changeClippingMode(mode: NonNullable<ClippingState["mode"]>) {
    if (!engine) return;
    const range = engine.getClippingRange(clipping.axis);
    const next: ClippingState = {
      ...clipping,
      enabled: true,
      mode,
      ...(mode === "axis" ? { offset: (range.min + range.max) / 2 } : {}),
      ...(mode === "box" ? { box: clipping.box ?? engine.getClippingBounds(), showHelper: true } : {}),
    };
    if (mode === "face") delete next.face;
    setClippingState(next);
    engine.setClipping(next);
    setMeasureEnabled(false);
    engine.setMeasureEnabled(false);
    setAnnotationEnabled(false);
    engine.setAnnotationPlacementEnabled(false);
    setMessage(mode === "box" ? "剖切盒已开启，调整六个边界" : mode === "face" ? "点击模型表面建立剖切面" : "轴向剖切已开启");
  }

  function updateClippingBox(axis: "x" | "y" | "z", side: "min" | "max", value: number) {
    if (!engine) return;
    const bounds = clipping.box ?? engine.getClippingBounds();
    const opposite = side === "min" ? bounds.max[axis] : bounds.min[axis];
    const safeValue = side === "min" ? Math.min(value, opposite - 0.001) : Math.max(value, opposite + 0.001);
    updateClipping({ box: { ...bounds, [side]: { ...bounds[side], [axis]: safeValue } } });
  }

  function toggleClipping() {
    if (!engine) return;
    const enabled = !clipping.enabled;
    const range = engine.getClippingRange(clipping.axis);
    updateClipping({ enabled, mode: clipping.mode ?? "axis", ...(enabled ? { offset: (range.min + range.max) / 2 } : {}) });
    if (enabled) {
      setMeasureEnabled(false);
      engine.setMeasureEnabled(false);
      setAnnotationEnabled(false);
      engine.setAnnotationPlacementEnabled(false);
    }
    setMessage(enabled ? "剖切工具已开启" : "已关闭剖切");
  }

  function updateExplosion(factor: number, mode: ExplosionMode = explosionMode) {
    if (!engine || !selected || selected.kind !== "model") return;
    engine.setExplosion(selected.id, factor, mode);
    setRevision((value) => value + 1);
    setMessage(
      factor > 0
        ? `${tr(locale, "模型爆炸", "Model explosion")} ${Math.round(factor * 100)}% · ${explosionModeName(mode, locale)}`
        : tr(locale, "已恢复模型组合", "Model restored"),
    );
  }

  function updateSelectedTransform(group: keyof ModelTransform, axis: "x" | "y" | "z", rawValue: string) {
    if (!engine || !selected) return;
    const current = engine.getSelectionTransform();
    if (!current) return;
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) return;
    const value = group === "rotation" ? (numeric * Math.PI) / 180 : numeric;
    const projectPosition = worldToProject(current.position, sceneCoordinates);
    const transform: ModelTransform = {
      position: { ...current.position },
      rotation: { ...current.rotation },
      scale: { ...current.scale },
      [group]: { ...current[group], [axis]: value },
    };
    if (group === "position") transform.position = projectToWorld({ ...projectPosition, [axis]: numeric }, sceneCoordinates);
    const groupedIds =
      (!selectedLayerId || selectedLayerId === "root") && sceneOrganizationSelection.has(selected.id) && sceneOrganizationSelection.size > 1 ? [...sceneOrganizationSelection] : [];
    if (groupedIds.length > 1 && !engine.isSelectionLocked()) {
      const selectedRoot = engine.getModelTransform(selected.id);
      const positionDelta =
        selectedRoot && group === "position"
          ? { x: transform.position.x - selectedRoot.position.x, y: transform.position.y - selectedRoot.position.y, z: transform.position.z - selectedRoot.position.z }
          : undefined;
      const rotationDelta = selectedRoot && group === "rotation" ? value - selectedRoot.rotation[axis] : 0;
      const scaleRatio = selectedRoot && group === "scale" && Math.abs(selectedRoot.scale[axis]) > 1e-6 ? value / selectedRoot.scale[axis] : 1;
      for (const id of groupedIds) {
        const root = engine.getModelTransform(id);
        if (!root || engine.isModelLocked(id)) continue;
        const next: ModelTransform = { position: { ...root.position }, rotation: { ...root.rotation }, scale: { ...root.scale } };
        if (positionDelta) next.position = { x: root.position.x + positionDelta.x, y: root.position.y + positionDelta.y, z: root.position.z + positionDelta.z };
        if (group === "rotation") next.rotation = { ...root.rotation, [axis]: root.rotation[axis] + rotationDelta };
        if (group === "scale") next.scale = { ...root.scale, [axis]: root.scale[axis] * scaleRatio };
        engine.setModelTransform(id, {
          position: [next.position.x, next.position.y, next.position.z],
          rotation: [next.rotation.x, next.rotation.y, next.rotation.z],
          scale: [next.scale.x, next.scale.y, next.scale.z],
        });
      }
      setMessage(tr(locale, `已同步更新编组 ${groupedIds.length} 个对象`, `Updated ${groupedIds.length} grouped objects`));
    } else {
      engine.applySelectionTransform(transform);
    }
    setRevision((item) => item + 1);
  }

  function layoutSelectedObjects(mode: SceneSelectionLayoutMode, axis: SceneSelectionLayoutAxis) {
    if (!engine || sceneOrganizationSelection.size < (mode === "distribute" ? 3 : 2)) return;
    const selectedItems = [...sceneOrganizationSelection]
      .filter((id) => !engine.isModelLocked(id))
      .flatMap((id) => {
        const transform = engine.getModelTransform(id);
        if (!transform) return [];
        return [{
          id,
          transform: {
            ...transform,
            position: worldToProject(transform.position, sceneCoordinates),
          },
        }];
      });
    if (selectedItems.length < (mode === "distribute" ? 3 : 2)) {
      setMessage(tr(locale, "可编辑对象数量不足；已锁定对象不会移动", "Not enough editable objects; locked objects are not moved"));
      return;
    }
    const next = layoutSceneSelection(selectedItems, mode, axis, selected?.id);
    for (const item of next) {
      const world = projectToWorld(item.transform.position, sceneCoordinates);
      engine.setModelTransform(item.id, {
        position: [world.x, world.y, world.z],
        rotation: [item.transform.rotation.x, item.transform.rotation.y, item.transform.rotation.z],
        scale: [item.transform.scale.x, item.transform.scale.y, item.transform.scale.z],
      });
    }
    const operation = mode === "align" ? "对齐" : "等距分布";
    setRevision((value) => value + 1);
    recordSceneEdit(`${operation} ${axis.toUpperCase()} 轴对象`);
    setMessage(tr(
      locale,
      `已将 ${next.length} 个对象沿 ${axis.toUpperCase()} 轴${operation}${next.length < sceneOrganizationSelection.size ? "；已跳过锁定对象" : ""}`,
      `${operation === "对齐" ? "Aligned" : "Distributed"} ${next.length} objects on ${axis.toUpperCase()}${next.length < sceneOrganizationSelection.size ? "; locked objects were skipped" : ""}`,
    ));
  }

  function addCameraView() {
    if (!engine) return;
    const createdAt = new Date().toISOString();
    const next: CameraViewState = {
      id: crypto.randomUUID(),
      name: `${tr(locale, "视角", "View")} ${cameraViews.length + 1}`,
      camera: engine.getCameraState(),
      createdAt,
    };
    setCameraViews((items) => [...items, next]);
    setDefaultCameraViewId((current) => current ?? next.id);
    setMessage(`已保存相机视角“${next.name}”`);
  }

  function changeCameraConstraints(patch: Partial<CameraConstraintsState>) {
    const next = normalizeCameraConstraints({ ...cameraConstraints, ...patch });
    setCameraConstraints(next);
    engine?.setCameraConstraints(next);
  }

  function changeNavigationSettings(patch: Partial<NavigationSettingsState>) {
    const next = normalizeNavigationSettings({ ...navigationSettings, ...patch });
    setNavigationSettings(next);
    engine?.setNavigationSettings(next);
  }

  function updateCameraViewName(id: string, name: string) {
    setCameraViews((items) => items.map((item) => (item.id === id ? { ...item, name: name.trim() || item.name } : item)));
  }

  function replaceCameraView(id: string) {
    if (!engine) return;
    setCameraViews((items) => items.map((item) => (item.id === id ? { ...item, camera: engine.getCameraState() } : item)));
    setMessage(tr(locale, "相机视角已更新", "Camera view updated"));
  }

  function removeCameraView(id: string) {
    setCameraViews((items) => items.filter((item) => item.id !== id));
    setDefaultCameraViewId((current) => (current === id ? undefined : current));
  }

  function updateFloor(state: SceneFloorState) {
    engine?.setFloorState(state.modelId, state.level, state.visible, state.expansion);
    setRevision((value) => value + 1);
  }

  function expandFloors(modelId: string, value: number) {
    setFloorExpansionByModel((current) => ({ ...current, [modelId]: value }));
    (floorStatesByModel.get(modelId) ?? []).forEach((state, index) => engine?.setFloorState(modelId, state.level, state.visible, index * value));
    setRevision((item) => item + 1);
  }

  function selectLightForTransform(light: SceneLightState, handle: "position" | "target") {
    setSelectedLightId(light.id);
    setEnvironmentOpen(true);
    setSelected(undefined);
    const selectedHandle = engine?.selectSceneLight(light.id, handle) ?? false;
    if (selectedHandle) {
      setTransformMode("translate");
      setMessage(
        handle === "position"
          ? tr(locale, "拖动坐标轴移动光源", "Drag the gizmo to move the light")
          : tr(locale, "拖动目标点改变光照方向", "Drag the target to change light direction"),
      );
    }
  }

  async function startXR(mode: "immersive-vr" | "immersive-ar") {
    try {
      const started = await engine?.startXR(mode);
      if (!started) return;
      setXrPanelOpen(false);
      setMessage(mode === "immersive-vr" ? "已进入 VR" : "已进入 AR");
    } catch (reason) {
      showError(reason);
    }
  }

  return {
    recordSceneEdit,
    loadModel,
    uploadModels,
    deleteModel,
    beginPrimitivePlacement,
    insertIndustrialPrefab,
    createDeviceLayout,
    deletePrimitive,
    removeObjectInteractions,
    deleteMeasurement,
    toggleAnnotationPlacement,
    updateAnnotation,
    updateAnnotationPosition,
    deleteAnnotation,
    changeNavigation,
    changeTransform,
    toggleMeasurement,
    changeMeasureMode,
    focusComponent,
    updateClipping,
    changeClippingMode,
    updateClippingBox,
    toggleClipping,
    updateExplosion,
    updateSelectedTransform,
    layoutSelectedObjects,
    ...appearanceCommands,
    addCameraView,
    changeCameraConstraints,
    changeNavigationSettings,
    updateCameraViewName,
    replaceCameraView,
    removeCameraView,
    updateFloor,
    expandFloors,
    ...organizationCommands,
    selectLightForTransform,
    startXR,
    ...animationCommands,
  };
}

function uniqueSceneObjectId(base: string, usedIds: Set<string>): string {
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) id = `${base}:${suffix++}`;
  usedIds.add(id);
  return id;
}

export type SceneEditorController = ReturnType<typeof createSceneEditorController>;
