import { Box, Braces, ChevronRight, Layers3, Lock, MousePointer2, Trash2 } from "lucide-react";
import { explosionModeName } from "../appPresentation";
import { publishLocalSceneData } from "../sceneDataBridge";
import { translate as tr } from "../i18n";
import { InteractionEditor } from "../components/InteractionEditor";
import { IndustrialPrefabInspector } from "../components/IndustrialPrefabInspector";
import { ModelAnimationControl } from "../components/ModelAnimationControl";
import { ModelRigControl } from "../components/ModelRigControl";
import { ObjectAppearanceEditor } from "../components/ObjectAppearanceEditor";
import { SceneAnnotationInspector } from "../components/SceneAnnotationInspector";
import { SceneDataBindingEditor } from "../components/SceneDataBindingEditor";
import { SceneInspectorInfo } from "../components/SceneInspectorInfo";
import { SceneResultLists } from "../components/SceneResultLists";
import { SceneSpaceInspector } from "../components/SceneSpaceInspector";
import { SpatialAudioEditor } from "../components/SpatialAudioEditor";
import { StructuredProperties, TransformFields } from "../components/AppFormControls";
import type { AppStudioController } from "./AppStudioShell";

export function AppStudioInspector({ controller }: { controller: AppStudioController }) {
  const {
    activeApplication,
    activeScene,
    behaviorScriptContext,
    bindings,
    cameraInfo,
    cameraViews,
    chooseMaterialTexture,
    collisions,
    deleteAnnotation,
    deleteMeasurement,
    engine,
    explosionFactor,
    explosionMode,
    focusComponent,
    frameRate,
    infoEnabled,
    inspectorTab,
    interactionTargetOptions,
    locale,
    measurements,
    message,
    openDataCenter,
    openDocs,
    pointerInfo,
    project,
    removeObjectInteractions,
    rendererBackend,
    sceneCoordinates,
    sceneDataBindingRuntime,
    sceneDataBindings,
    sceneInteractions,
    sceneStatistics,
    scenes,
    selected,
    selectedAnnotation,
    selectedBehaviorTarget,
    selectedComponent,
    selectedEffects,
    selectedLayerId,
    selectedProjectPosition,
    selectedSpace,
    selectedTransform,
    selectionColor,
    selectionLocked,
    selectionMaterial,
    selectionName,
    selectionOpacity,
    selectionProperties,
    selectionVisible,
    setInspectorTab,
    setMeasurements,
    setMessage,
    setNavigationMode,
    setRevision,
    setSceneBehaviorOpen,
    setSceneDataBindingRuntime,
    setSceneDataBindings,
    setSceneInteractions,
    setSelectedSpace,
    updateAnnotation,
    updateAnnotationPosition,
    updateExplosion,
    updateSelectedEffects,
    updateSelectedTransform,
    updateSelectionColor,
    updateSelectionMaterial,
    updateSelectionOpacity,
    updateSelectionVisibility,
  } = controller;

  return (
    <aside className="right-panel">
      <div className="panel-heading inspector-heading">
        <div>
          <span className="eyebrow">{tr(locale, "对象检查器", "INSPECTOR")}</span>
          <h2>{tr(locale, "属性检查器", "Inspector")}</h2>
        </div>
      </div>
      {infoEnabled && <SceneInspectorInfo locale={locale} statistics={sceneStatistics} frameRate={frameRate} camera={cameraInfo} pointer={pointerInfo} />}
      {selectedAnnotation ? (
        <SceneAnnotationInspector
          locale={locale}
          annotation={selectedAnnotation}
          onChange={(patch) => updateAnnotation(selectedAnnotation.id, patch)}
          onPositionChange={(axis, value) => updateAnnotationPosition(selectedAnnotation, axis, value)}
          onFocus={() => engine?.focusAnnotation(selectedAnnotation.id)}
          onDelete={() => deleteAnnotation(selectedAnnotation.id)}
        />
      ) : selectedSpace ? (
        <SceneSpaceInspector
          locale={locale}
          space={selectedSpace}
          visible={engine?.isSpaceVisible(selectedSpace) ?? false}
          onClose={() => setSelectedSpace(undefined)}
          onFocus={() => {
            engine?.focusSpace(selectedSpace);
            setNavigationMode("orbit");
          }}
          onVisibilityChange={(visible) => {
            engine?.setSpaceVisible(selectedSpace, visible);
            setRevision((value) => value + 1);
          }}
        />
      ) : selected && selectedTransform ? (
        <div className="inspector-content">
          <div className="inspector-selection-context">
            <span className="inspector-selection-icon">{selectedLayerId && selectedLayerId !== "root" ? <Layers3 size={16} /> : <Box size={16} />}</span>
            <span>
              <strong title={selectionName || selected.name}>{selectionName || selected.name}</strong>
              <small>
                {selectedLayerId && selectedLayerId !== "root"
                  ? tr(locale, "模型构件", "Model component")
                  : selected.kind === "primitive"
                    ? tr(locale, "基础元素", "Primitive")
                    : tr(locale, "场景模型", "Scene model")}
              </small>
            </span>
            {selectionLocked && <Lock size={13} aria-label={tr(locale, "已锁定", "Locked")} />}
          </div>
          <nav className="inspector-context-tabs" aria-label={tr(locale, "对象检查器视图", "Object inspector view")}>
            <button className={inspectorTab === "overview" ? "active" : ""} onClick={() => setInspectorTab("overview")}>
              {tr(locale, "概览", "Overview")}
            </button>
            <button className={inspectorTab === "data" ? "active" : ""} onClick={() => setInspectorTab("data")}>
              {tr(locale, "数据", "Data")}
              <small>
                {sceneDataBindings.filter((binding) => binding.target.modelId === selected.id && (!binding.target.layerId || binding.target.layerId === selectedLayerId)).length}
              </small>
            </button>
            <button className={inspectorTab === "behavior" ? "active" : ""} onClick={() => setInspectorTab("behavior")}>
              {tr(locale, "行为", "Behavior")}
              <small>{activeApplication?.scripts.filter((script) => script.target?.kind !== "scene" && script.target?.id === selectedBehaviorTarget?.id).length ?? 0}</small>
            </button>
          </nav>
          {inspectorTab === "overview" && (
            <>
              <label className="field">
                <span>{selectedLayerId && selectedLayerId !== "root" ? tr(locale, "图层名称", "Layer name") : tr(locale, "名称", "Name")}</span>
                <input
                  disabled={selectionLocked}
                  value={selectionName}
                  onChange={(event) => {
                    engine?.renameSelection(event.target.value);
                    setRevision((value) => value + 1);
                  }}
                />
              </label>
              <label className="field color-field">
                <span>{tr(locale, "图层颜色", "Layer color")}</span>
                <div>
                  <input disabled={selectionLocked} type="color" value={selectionColor} onChange={(event) => updateSelectionColor(event.target.value)} />
                  <output>{selectionColor.toUpperCase()}</output>
                </div>
              </label>
              <div className="two-column">
                <label className="field">
                  <span>{tr(locale, "可见性", "Visibility")}</span>
                  <button className={`toggle ${selectionVisible ? "on" : ""}`} onClick={() => updateSelectionVisibility(!selectionVisible)}>
                    <i />
                    {selectionVisible ? tr(locale, "显示", "Visible") : tr(locale, "隐藏", "Hidden")}
                  </button>
                </label>
                <label className="field">
                  <span>{tr(locale, "锁定", "Lock")}</span>
                  <button
                    className={`toggle ${selectionLocked ? "on" : ""}`}
                    onClick={() => {
                      if (!engine || !selected) return;
                      if (selectedLayerId && selectedLayerId !== "root") engine.setLayerLocked(selected.id, selectedLayerId, !selectionLocked);
                      else engine.setModelLocked(selected.id, !selectionLocked);
                      setRevision((value) => value + 1);
                    }}
                  >
                    <i />
                    {selectionLocked ? tr(locale, "已锁定", "Locked") : tr(locale, "未锁定", "Unlocked")}
                  </button>
                </label>
              </div>
              <label className="field compact-opacity">
                <span>{tr(locale, "透明度", "Opacity")}</span>
                <output>{Math.round(selectionOpacity * 100)}%</output>
              </label>
              <input
                disabled={selectionLocked}
                className="range"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={selectionOpacity}
                onChange={(event) => updateSelectionOpacity(Number(event.target.value))}
              />
            </>
          )}
          {inspectorTab === "data" && project && activeScene && (
            <SceneDataBindingEditor
              locale={locale}
              projectId={project.id}
              sceneId={activeScene.id}
              target={{ modelId: selected.id, ...(selectedLayerId && selectedLayerId !== "root" ? { layerId: selectedLayerId } : {}) }}
              targetName={selectionName || selected.name}
              bindings={sceneDataBindings}
              runtimeStates={sceneDataBindingRuntime}
              disabled={selectionLocked}
              onChange={setSceneDataBindings}
              onTest={(bindingId, message) => {
                publishLocalSceneData(message);
                setSceneDataBindingRuntime((current) => ({ ...current, [bindingId]: { status: "ready", value: message.value, updatedAt: message.timestamp } }));
                setMessage(tr(locale, "绑定测试已应用到当前对象", "The binding test was applied to the current object"));
              }}
              onOpenData={openDataCenter}
            />
          )}
          {inspectorTab === "data" && (
            <StructuredProperties
              locale={locale}
              entries={Object.entries(selectionProperties).map(([name, value]) => ({ name, value }))}
              emptyText={tr(locale, "该对象没有 BIM 属性", "This object has no BIM properties")}
            />
          )}
          {inspectorTab === "overview" && (
            <details className="inspector-collapsible inspector-appearance-settings">
              <summary>{tr(locale, "外观、特效与动画", "Appearance, effects & animation")}</summary>
              <div className="inspector-collapsible-body">
                <ObjectAppearanceEditor
                  locale={locale}
                  rendererBackend={rendererBackend}
                  disabled={selectionLocked}
                  material={selectionMaterial}
                  projectAssets={project?.assets ?? []}
                  {...(selectedEffects ? { effects: selectedEffects } : {})}
                  onMaterialChange={updateSelectionMaterial}
                  onEffectsChange={updateSelectedEffects}
                  onChooseTexture={chooseMaterialTexture}
                />
                {selected.kind === "model" && (
                  <div className="field explosion-field">
                    <span>{tr(locale, "模型爆炸", "Model explosion")}</span>
                    <output>{Math.round(explosionFactor * 100)}%</output>
                    <input
                      disabled={selectionLocked}
                      className="range"
                      type="range"
                      min="0"
                      max="2"
                      step="0.01"
                      value={explosionFactor}
                      onChange={(event) => updateExplosion(Number(event.target.value))}
                    />
                    <div className="explosion-modes">
                      {(["radial", "vertical", "x", "y", "z"] as const).map((mode) => (
                        <button
                          disabled={selectionLocked}
                          key={mode}
                          className={explosionMode === mode ? "active" : ""}
                          onClick={() => updateExplosion(Math.max(explosionFactor, 0.55), mode)}
                        >
                          {explosionModeName(mode, locale)}
                        </button>
                      ))}
                      <button disabled={selectionLocked} onClick={() => updateExplosion(0)}>
                        {tr(locale, "复位", "Reset")}
                      </button>
                    </div>
                  </div>
                )}
                {selected.kind === "model" && engine && (
                  <SpatialAudioEditor locale={locale} engine={engine} modelId={selected.id} disabled={selectionLocked} onChange={() => setRevision((value) => value + 1)} />
                )}
                {engine?.hasAnimation(selected.id) && (
                  <ModelAnimationControl locale={locale} engine={engine} modelId={selected.id} disabled={selectionLocked} onChange={() => setRevision((value) => value + 1)} />
                )}
                {engine && (
                  <IndustrialPrefabInspector locale={locale} engine={engine} modelId={selected.id} disabled={selectionLocked} onChange={() => setRevision((value) => value + 1)} />
                )}
                {engine?.hasSkeleton(selected.id) && (
                  <ModelRigControl locale={locale} engine={engine} modelId={selected.id} disabled={selectionLocked} onChange={() => setRevision((value) => value + 1)} />
                )}
                {selectedComponent && (
                  <div className="component-actions">
                    <button onClick={() => focusComponent(selectedComponent)}>{tr(locale, "定位", "Focus")}</button>
                    <button
                      onClick={() => {
                        engine?.isolateComponents([selectedComponent]);
                        setRevision((value) => value + 1);
                      }}
                    >
                      {tr(locale, "隔离当前", "Isolate")}
                    </button>
                    {engine?.isIsolationActive() && (
                      <button
                        onClick={() => {
                          engine.clearIsolation();
                          setRevision((value) => value + 1);
                        }}
                      >
                        {" "}
                        {tr(locale, "恢复全部", "Restore all")}{" "}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </details>
          )}
          {inspectorTab === "overview" && (
            <>
              <TransformFields
                disabled={selectionLocked}
                title={`${tr(locale, "位置", "Position")} · ${sceneCoordinates.upAxis.toUpperCase()}↑`}
                transform={selectedProjectPosition ?? selectedTransform.position}
                suffix={sceneCoordinates.unit}
                onChange={(axis, value) => updateSelectedTransform("position", axis, value)}
              />
              <TransformFields
                disabled={selectionLocked}
                title={tr(locale, "旋转", "Rotation")}
                transform={{
                  x: (selectedTransform.rotation.x * 180) / Math.PI,
                  y: (selectedTransform.rotation.y * 180) / Math.PI,
                  z: (selectedTransform.rotation.z * 180) / Math.PI,
                }}
                suffix="°"
                onChange={(axis, value) => updateSelectedTransform("rotation", axis, value)}
              />
              <TransformFields
                disabled={selectionLocked}
                title={tr(locale, "缩放", "Scale")}
                transform={selectedTransform.scale}
                onChange={(axis, value) => updateSelectedTransform("scale", axis, value)}
              />
            </>
          )}
          {inspectorTab === "behavior" && (
            <details className="inspector-collapsible inspector-interaction-settings" open>
              <summary>{tr(locale, "交互与对象属性", "Interactions & object properties")}</summary>
              <div className="inspector-collapsible-body">
                <section className="scene-behavior-entry">
                  <span>
                    <Braces size={15} />
                    <span>
                      <strong>{tr(locale, "行为脚本", "Behavior scripts")}</strong>
                      <small>{tr(locale, "为当前对象挂载生命周期与业务事件", "Attach lifecycle logic and business events")}</small>
                    </span>
                  </span>
                  <button onClick={() => setSceneBehaviorOpen(true)}>
                    {activeApplication?.scripts.filter((script) => script.target?.kind !== "scene" && script.target?.id === selectedBehaviorTarget?.id).length ?? 0}{" "}
                    {tr(locale, "个行为", "behaviors")}
                    <ChevronRight size={13} />
                  </button>
                </section>
                <InteractionEditor
                  locale={locale}
                  target={{ kind: "object", modelId: selected.id, ...(selectedLayerId && selectedLayerId !== "root" ? { layerId: selectedLayerId } : {}) }}
                  targetName={selectionName || selected.name}
                  interactions={sceneInteractions}
                  targetOptions={interactionTargetOptions}
                  sceneOptions={scenes.map((scene) => ({ id: scene.id, name: scene.name }))}
                  pageOptions={activeApplication?.pages.map((page) => ({ id: page.id, name: page.name })) ?? []}
                  cameraViewOptions={cameraViews.map((view) => ({ id: view.id, name: view.name }))}
                  intelligence={behaviorScriptContext}
                  onChange={setSceneInteractions}
                  onTest={(script) => void engine?.runInteractionScript(script, { test: true })}
                  onOpenDocs={() => openDocs("studio-api")}
                />
              </div>
            </details>
          )}
          {inspectorTab === "overview" && (
            <button
              className="button remove-scene"
              disabled={selectionLocked}
              onClick={() => {
                if (selectedLayerId && selectedLayerId !== "root") {
                  engine?.deleteSelectedLayer();
                  removeObjectInteractions(selected.id, selectedLayerId);
                } else {
                  engine?.removeModel(selected.id);
                  removeObjectInteractions(selected.id);
                }
                setRevision((value) => value + 1);
              }}
            >
              <Trash2 size={16} />
              {selectedLayerId && selectedLayerId !== "root" ? tr(locale, "删除当前图层", "Delete layer") : tr(locale, "从场景移除", "Remove from scene")}
            </button>
          )}
        </div>
      ) : (
        <div className="empty-inspector">
          <MousePointer2 size={30} />
          <strong>{tr(locale, "选择一个模型或构件", "Select a model or component")}</strong>
          <span>{tr(locale, "点击画布中的对象查看属性并进行编辑", "Click an object in the viewport to inspect and edit it")}</span>
        </div>
      )}
      <SceneResultLists
        locale={locale}
        measurements={measurements}
        collisions={collisions}
        onMeasurementFocus={(measurement) => engine?.focusMeasurement(measurement)}
        onMeasurementRemove={deleteMeasurement}
        onMeasurementsClear={() => {
          engine?.clearMeasurements();
          setMeasurements([]);
        }}
        onCollisionFocus={(collision) => engine?.focusCollision(collision)}
      />
    </aside>
  );
}
