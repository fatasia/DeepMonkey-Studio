import { useState } from "react";
import { DEFAULT_ANIMATION, DEFAULT_LIGHTING } from "../appDefaults";
import type { LoadedSceneModel, ViewerEngine } from "../viewer/ViewerEngine";
import { FlatSceneObjectList } from "../components/FlatSceneObjectList";
import type { SceneOrganizationObject } from "../components/SceneOrganizationPanel";
import { SceneOutlinerPanel } from "../components/SceneOutlinerPanel";
import { SceneSelectionBar } from "../components/SceneSelectionBar";
import { SceneTimelinePanel } from "../components/SceneTimelinePanel";
import { ViewOrientationCube } from "../components/ViewOrientationCube";
import "../components/ViewOrientationCube.css";
import "./workspaceChromeVisualQa.css";

const noop = () => {};
const objects: SceneOrganizationObject[] = [
  { id: "assembly", name: "总装线设备组", kind: "model", visible: true, locked: false },
  { id: "pump", name: "循环泵 P-101", kind: "primitive", visible: true, locked: false },
  { id: "cabinet", name: "控制柜 PLC-01", kind: "primitive", visible: true, locked: false },
  { id: "station", name: "检测工位 03", kind: "model", visible: true, locked: true },
];

/** 仅 DEV/显式 QA 构建：验证统一对象管理器、视角工具与可缩放时间线的真实组件组合。 */
export default function WorkspaceChromeVisualQa() {
  const [selectedIds, setSelectedIds] = useState(new Set(["pump", "cabinet"]));
  const [animation, setAnimation] = useState(() => structuredClone(DEFAULT_ANIMATION));
  const [currentTime, setCurrentTime] = useState(1.4);
  const [directorWorkspace, setDirectorWorkspace] = useState<"timeline" | "shots" | "navigation">("timeline");
  const [importSettingsOpen, setImportSettingsOpen] = useState(false);
  const selected = objects.filter((item) => selectedIds.has(item.id));
  const engine = {
    select: (id?: string) => setSelectedIds(new Set(id ? [id] : [])),
    focusModel: noop,
    isModelLocked: (id: string) => objects.find((item) => item.id === id)?.locked ?? false,
    setVisible: noop,
    setModelLocked: noop,
    isCollisionEnabled: () => false,
    isColliding: () => false,
    setCollisionEnabled: noop,
    getSelected: () => ({ id: "pump", name: "循环泵 P-101" }),
    listAnimationClips: () => [{ id: "idle", name: "待机", duration: 2 }, { id: "running", name: "运行", duration: 3 }],
    controlAnimation: () => true,
    transitionAnimationClip: () => true,
    getCameraState: () => ({ position: { x: 12, y: 8, z: 12 }, target: { x: 0, y: 1, z: 0 }, mode: "orbit" as const }),
    getModelTransform: () => ({ position: { x: 2, y: 0, z: -1 }, rotation: { x: 0, y: .4, z: 0 }, scale: { x: 1, y: 1, z: 1 } }),
    orbit: { addEventListener: noop, removeEventListener: noop },
    transform: { addEventListener: noop, removeEventListener: noop },
  } as unknown as ViewerEngine;
  const recordCamera = () => setAnimation((current) => ({
    ...current,
    camera: [...current.camera.filter((frame) => Math.abs(frame.time - currentTime) > .001), {
      id: crypto.randomUUID(), time: currentTime,
      camera: { position: { x: 12, y: 8, z: 12 }, target: { x: 0, y: 1, z: 0 }, mode: "orbit" as const },
    }].sort((left, right) => left.time - right.time),
  }));
  const recordObject = (modelId = "pump") => setAnimation((current) => ({
    ...current,
    models: [...current.models.filter((frame) => frame.modelId !== modelId || Math.abs(frame.time - currentTime) > .001), {
      id: crypto.randomUUID(), time: currentTime, modelId,
      transform: { position: { x: 2, y: 0, z: -1 }, rotation: { x: 0, y: .4, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    }].sort((left, right) => left.time - right.time),
  }));
  return <main className="app-shell workspace-chrome-qa">
    <header className="topbar"><strong>场景编辑器 · 工作区组件验收</strong><span>同一对象目录 · 相机与动画共用上下文</span><button type="button" onClick={() => setImportSettingsOpen(true)}>验收 RVT 设置</button></header>
    <SceneOutlinerPanel
      locale="zh-CN"
      uploading={false}
      importOpen={importSettingsOpen}
      rvtConversionMode="native-glb"
      revitVersion="auto"
      revitRuntime={{ installations: [], defaultVersion: "auto" }}
      query=""
      level=""
      category=""
      facets={{ levels: [], categories: [] }}
      results={[]}
      bindingComponents={[]}
      searchActive={false}
      isolationActive={false}
      objectContent={<>
        <SceneSelectionBar
          locale="zh-CN"
          selectedObjects={selected}
          onGroup={noop}
          onShow={noop}
          onLock={noop}
          onUnlock={noop}
          onIsolate={noop}
          onRestoreIsolation={noop}
          onCollision={noop}
          onClear={() => setSelectedIds(new Set())}
        />
        <FlatSceneObjectList locale="zh-CN" studio engine={engine} modelRows={[]} empty={false} lighting={DEFAULT_LIGHTING}
          selectedLightId="" selectedObjectId={[...selectedIds].at(-1)} selectedObjectIds={selectedIds} primitives={objects.map((item) => ({ ...item, kind: "primitive", opacity: 1 }) as unknown as LoadedSceneModel)}
          measurements={[]} annotations={[]} spaces={[]} groups={[{ id: "group:line", name: "总装线设备组", kind: "group", objectIds: ["assembly", "station"] }]}
          organizationObjects={objects} onRevision={noop} onObjectSelect={(id, options) => setSelectedIds((current) => {
            if (!options.additive) return new Set([id]);
            const next = new Set(current);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
          })} onLightSelect={noop} onLightUpdate={noop} onLightTransform={noop}
          onLightRemove={noop} onEnvironmentOpen={noop} onPrimitiveRemove={noop} onMeasurementRemove={noop} onAnnotationUpdate={noop} onAnnotationRemove={noop}
          onSpaceFocus={noop} onSpaceVisibilityChange={noop} onSelectGroup={() => setSelectedIds(new Set(["assembly", "station"]))} onRenameGroup={noop}
          onGroupVisibilityChange={noop} onGroupLockChange={noop} />
      </>}
      onImportClose={() => setImportSettingsOpen(false)}
      onImportModel={noop}
      onWorkflowClose={noop}
      onRvtConversionModeChange={noop}
      onRevitVersionChange={noop}
      onInsertProjectModel={noop}
      onInsertPrefab={noop}
      onCreateDeviceLayout={noop}
      onConfirmSmartBindings={noop}
      onQueryChange={noop}
      onLevelChange={noop}
      onCategoryChange={noop}
      onResultFocus={noop}
      onResultsIsolate={noop}
      onIsolationRestore={noop}
    />
    <section className="viewport-shell workspace-chrome-qa__viewport">
      <div><span>工业场景视口</span><strong>统一选择状态同时驱动对象列表、编组与属性面板</strong></div>
      <ViewOrientationCube locale="zh-CN" azimuthDeg={-36} elevationDeg={22} activeView="right" hasSelection onStandardView={noop} onFitAll={noop} onFitSelected={noop} onOptimizeView={noop} />
      <SceneTimelinePanel engine={engine} locale="zh-CN" animation={animation} currentTime={currentTime} playing={false} selectedObjectName="循环泵 P-101" selectedObjectLocked={false} modelNames={new Map([["pump", "循环泵 P-101"]])} onClose={noop} onPlayPause={noop} onSeek={setCurrentTime} onChange={setAnimation} onRecordCamera={recordCamera} onRecordObject={recordObject} onDeleteFrame={(id) => setAnimation((current) => ({ ...current, camera: current.camera.filter((frame) => frame.id !== id), models: current.models.filter((frame) => frame.id !== id) }))} workspace={directorWorkspace} onWorkspaceChange={setDirectorWorkspace} cameraWorkspace={<div className="workspace-chrome-qa__camera"><strong>{directorWorkspace === "shots" ? "常用镜头" : "漫游与碰撞"}</strong><span>{directorWorkspace === "shots" ? "保存当前视角 · 设置默认镜头" : "轨道浏览 · 第一人称 · 第三人称"}</span></div>} />
    </section>
    <aside className="right-panel workspace-chrome-qa__inspector"><span className="eyebrow">INSPECTOR</span><h2>循环泵 P-101</h2><p>对象属性、镜头导航与动画关键帧在同一工作区上下文中编辑。</p></aside>
  </main>;
}
