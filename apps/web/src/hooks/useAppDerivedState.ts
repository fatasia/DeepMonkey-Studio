import { useEffect, useMemo } from "react";
import type { SceneFloorState } from "@bim-studio/contracts";
import type { SceneOrganizationObject } from "../components/SceneOrganizationPanel";
import { buildSceneScriptContext } from "../studio/sceneScriptContext";
import { worldToProject } from "../viewer/sceneCoordinates";
import type { AppState } from "./useAppState";

/** 由引擎和选中对象计算出的只读视图数据，避免在主应用重复查询引擎。 */
export function useAppDerivedState(state: AppState) {
  const {
    engine,
    revision,
    activeApplication,
    selected,
    sceneCoordinates,
    activeScene,
    sceneName,
    lighting,
    selectedLightId,
    componentQuery,
    componentLevel,
    componentCategory,
    annotations,
    selectedAnnotationId,
    clipping,
    infoEnabled,
    setNavigationDiagnostics,
  } = state;

  const loadedModels = useMemo(() => engine?.listModels() ?? [], [engine, revision]);
  const loadedModelNames = useMemo(() => new Map(loadedModels.map((model) => [model.id, model.name])), [loadedModels]);
  const sceneOrganizationObjects = useMemo<SceneOrganizationObject[]>(
    () => loadedModels.map((model) => ({ id: model.id, name: model.name, kind: model.kind, visible: model.visible, locked: engine?.isModelLocked(model.id) ?? false })),
    [engine, loadedModels],
  );
  useEffect(() => {
    if (engine) setNavigationDiagnostics(engine.getNavigationCollisionDiagnostics());
  }, [engine, revision]);
  const behaviorScriptContext = useMemo(() => buildSceneScriptContext(activeApplication), [activeApplication]);
  const behaviorCodeTargets = behaviorScriptContext.targets;
  const scenePrimitives = loadedModels.filter((item) => item.kind === "primitive");
  const selectedTransform = selected && engine ? engine.getSelectionTransform() : undefined;
  const selectedProjectPosition = useMemo(
    () => (selectedTransform ? worldToProject(selectedTransform.position, sceneCoordinates) : undefined),
    [selectedTransform, sceneCoordinates],
  );
  const selectionName = selected && engine ? engine.getSelectionName() : "";
  const selectionVisible = selected && engine ? engine.getSelectionVisible() : false;
  const selectionOpacity = selected && engine ? engine.getSelectionOpacity() : 1;
  const selectionColor = selected && engine ? engine.getSelectionColor() : "#d4a84f";
  const selectionMaterial = useMemo(() => (selected && engine ? engine.getSelectionMaterial() : {}), [engine, selected, revision]);
  const selectedEffects = useMemo(() => (selected && engine ? engine.getModelEffects(selected.id) : undefined), [engine, selected, revision]);
  const selectedPhysics = useMemo(() => (selected && engine ? engine.getPhysicsBodyState(selected.id) : undefined), [engine, selected, revision]);
  const selectionProperties = useMemo(() => engine?.getSelectionProperties() ?? {}, [engine, selected, revision]);
  const selectedLayerId = engine?.getSelectedLayerId();
  const selectedComponent = engine?.getSelectedComponentRecord();
  const selectedBehaviorTarget = selected
    ? { id: selectedComponent?.stableId ?? selected.id, name: selectionName || selected.name, kind: "object" as const, context: activeScene?.name ?? sceneName }
    : undefined;
  const selectionLocked = engine?.isSelectionLocked() ?? false;
  const componentFacets = useMemo(() => engine?.getComponentFacets() ?? { levels: [], categories: [], specialties: [] }, [engine, revision]);
  const floorStates = useMemo(() => engine?.getFloorStates() ?? [], [engine, revision]);
  const floorStatesByModel = useMemo(() => {
    const grouped = new Map<string, SceneFloorState[]>();
    for (const floor of floorStates) grouped.set(floor.modelId, [...(grouped.get(floor.modelId) ?? []), floor]);
    return grouped;
  }, [floorStates]);
  const selectedLight = lighting.lights?.find((light) => light.id === selectedLightId) ?? lighting.lights?.[0];
  const componentResults = useMemo(
    () => engine?.searchComponents({ query: componentQuery, level: componentLevel, category: componentCategory }, 80) ?? [],
    [engine, revision, componentQuery, componentLevel, componentCategory],
  );
  const bindingComponents = useMemo(() => engine?.searchComponents({}, 10_000) ?? [], [engine, revision]);
  const componentSearchActive = Boolean(componentQuery.trim() || componentLevel || componentCategory);
  const collisions = useMemo(() => engine?.getCollisionRecords() ?? [], [engine, revision]);
  const spaces = useMemo(() => engine?.getSpaces() ?? [], [engine, revision]);
  const selectedAnnotation = annotations.find((item) => item.id === selectedAnnotationId);
  const clippingRange = engine?.getClippingRange(clipping.axis) ?? { min: -10, max: 10 };
  const clippingSceneBounds = engine?.getClippingBounds() ?? { min: { x: -10, y: -10, z: -10 }, max: { x: 10, y: 10, z: 10 } };
  const explosionFactor = selected && engine ? engine.getExplosionFactor(selected.id) : 0;
  const explosionMode = selected && engine ? engine.getExplosionMode(selected.id) : "radial";
  const sceneStatistics = useMemo(
    () => (infoEnabled && engine ? engine.getSceneStatistics() : { modelCount: 0, primitiveCount: 0, componentCount: 0, triangleCount: 0, vertexCount: 0 }),
    [engine, revision, infoEnabled],
  );
  return {
    loadedModels,
    loadedModelNames,
    sceneOrganizationObjects,
    behaviorScriptContext,
    behaviorCodeTargets,
    scenePrimitives,
    selectedTransform,
    selectedProjectPosition,
    selectionName,
    selectionVisible,
    selectionOpacity,
    selectionColor,
    selectionMaterial,
    selectedEffects,
    selectedPhysics,
    selectionProperties,
    selectedLayerId,
    selectedComponent,
    selectedBehaviorTarget,
    selectionLocked,
    componentFacets,
    floorStates,
    floorStatesByModel,
    selectedLight,
    componentResults,
    bindingComponents,
    componentSearchActive,
    collisions,
    spaces,
    selectedAnnotation,
    clippingRange,
    clippingSceneBounds,
    explosionFactor,
    explosionMode,
    sceneStatistics,
  };
}

export type AppDerivedState = ReturnType<typeof useAppDerivedState>;
