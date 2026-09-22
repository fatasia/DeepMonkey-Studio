import { SceneResourceBrowser } from "./SceneResourceBrowser";
export { SceneResourceBrowser } from "./SceneResourceBrowser";
import { ComponentSearch } from "./SceneComponentSearch";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Boxes,
  LoaderCircle,
  Plus,
  X,
} from "lucide-react";
import type {
  RevitRuntimeInfo,
  RvtConversionMode,
  IndustrialPrefabDefinition,
  ProjectAssetRecord,
  ModelRecord,
} from "@bim-studio/contracts";
import { useDialogEscape } from "../hooks/useGlobalDialogEscape";
import { useFloatingPanelDrag } from "../hooks/useFloatingPanelDrag";
import { translate as tr, type AppLocale } from "../i18n";
import type { DeviceBoxDraft } from "../deviceLayout/deviceLayout";
import type { ComponentRecord } from "../viewer/ViewerEngine";
import type { ConfirmedSmartAssetMapping } from "./smartAssetBindingWorkbenchModel";
import { RvtImportSettings } from "./RvtImportSettings";

const DeviceLayoutWorkbench = lazy(() => import("./DeviceLayoutWorkbench").then((module) => ({ default: module.DeviceLayoutWorkbench })));
const SmartAssetBindingWorkbench = lazy(() => import("./SmartAssetBindingWorkbench").then((module) => ({ default: module.SmartAssetBindingWorkbench })));

export interface SceneOutlinerPanelProps {
  locale: AppLocale;
  uploading: boolean;
  importOpen: boolean;
  activeWorkflow?: "device-layout" | "smart-binding" | "model-diff" | null;
  rvtConversionMode: RvtConversionMode;
  revitVersion: string;
  revitRuntime: RevitRuntimeInfo;
  query: string;
  level: string;
  category: string;
  facets: { levels: string[]; categories: string[] };
  results: ComponentRecord[];
  bindingComponents: ComponentRecord[];
  selectedComponentId?: string | undefined;
  searchActive: boolean;
  isolationActive: boolean;
  objectContent: ReactNode;
  projectAssets?: ProjectAssetRecord[];
  projectModels?: ModelRecord[];
  projectId?: string;
  onLibraryImported?: () => Promise<void>;
  onImportClose: () => void;
  onImportModel: () => void;
  onWorkflowClose: () => void;
  onRvtConversionModeChange: (mode: RvtConversionMode) => void;
  onRevitVersionChange: (version: string) => void;
  onInsertProjectModel: (model: ModelRecord) => void;
  onInsertPrefab: (definition: IndustrialPrefabDefinition) => void;
  onCreateDeviceLayout: (devices: DeviceBoxDraft[], createLabels: boolean) => Promise<void> | void;
  onConfirmSmartBindings: (mappings: ConfirmedSmartAssetMapping[]) => void;
  onQueryChange: (query: string) => void;
  onLevelChange: (level: string) => void;
  onCategoryChange: (category: string) => void;
  onResultFocus: (record: ComponentRecord) => void;
  onResultsIsolate: () => void;
  onIsolationRestore: () => void;
}

export function SceneOutlinerPanel(props: SceneOutlinerPanelProps) {
  const [resourceOpen, setResourceOpen] = useState(false);
  const [deviceLayoutBusy, setDeviceLayoutBusy] = useState(false);
  const resourcePanelDrag = useFloatingPanelDrag<HTMLElement>();
  const resourcePanelEscapeRef = useDialogEscape(() => setResourceOpen(false));
  const importSettingsEscapeRef = useDialogEscape(props.onImportClose);
  const activeWorkflow = props.activeWorkflow ?? null;
  const workflowDialogEscapeRef = useDialogEscape(() => {
    if (activeWorkflow === "device-layout" && deviceLayoutBusy) return;
    props.onWorkflowClose();
  });
  const deviceLayoutDialog = activeWorkflow === "device-layout" && typeof document !== "undefined" ? createPortal(
    <div
      className="device-layout-backdrop"
      data-escape-dialog=""
      ref={workflowDialogEscapeRef}
      onMouseDown={() => { if (!deviceLayoutBusy) props.onWorkflowClose(); }}
    >
      <Suspense fallback={<div className="device-layout-loading"><LoaderCircle className="spin" size={15} />{tr(props.locale, "正在载入设备布局工具…", "Loading device layout tool…")}</div>}>
        <DeviceLayoutWorkbench locale={props.locale} onApply={props.onCreateDeviceLayout} onBusyChange={setDeviceLayoutBusy} onClose={props.onWorkflowClose} />
      </Suspense>
    </div>,
    document.body
  ) : null;
  const smartBindingDialog = activeWorkflow === "smart-binding" && typeof document !== "undefined" ? createPortal(
    <div
      className="smart-binding-backdrop"
      data-escape-dialog=""
      ref={workflowDialogEscapeRef}
      onMouseDown={() => props.onWorkflowClose()}
    >
      <Suspense fallback={<div className="device-layout-loading"><LoaderCircle className="spin" size={15} />{tr(props.locale, "正在载入智能绑定…", "Loading smart binding…")}</div>}>
        <SmartAssetBindingWorkbench locale={props.locale} components={props.bindingComponents} onClose={props.onWorkflowClose} onConfirm={(mappings) => { props.onConfirmSmartBindings(mappings); props.onWorkflowClose(); }} />
      </Suspense>
    </div>,
    document.body
  ) : null;
  const resourcePanel = resourceOpen && typeof document !== "undefined" ? createPortal(
    <section
      className="scene-resource-floating"
      role="dialog"
      aria-label={tr(props.locale, "场景资源浮窗", "Scene resources panel")}
      data-escape-dialog=""
      ref={(element) => {
        resourcePanelDrag.panelRef.current = element;
        resourcePanelEscapeRef(element);
      }}
      style={resourcePanelDrag.style}
      onPointerDown={resourcePanelDrag.onPointerDown}
      onPointerMove={resourcePanelDrag.onPointerMove}
      onPointerUp={resourcePanelDrag.onPointerUp}
      onPointerCancel={resourcePanelDrag.onPointerCancel}
    >
      <header>
        <span>
          <strong>{tr(props.locale, "添加模型", "Add model")}</strong>
        </span>
        <button
          type="button"
          aria-label={tr(props.locale, "关闭资源浮窗", "Close resources panel")}
          title={tr(props.locale, "关闭资源浮窗", "Close resources panel")}
          onClick={() => setResourceOpen(false)}
        >
          <X size={14} />
        </button>
      </header>
      <SceneResourceBrowser {...props} />
    </section>,
    document.body
  ) : null;
  const importSettingsDialog = props.importOpen && typeof document !== "undefined" ? createPortal(
    <div className="dialog-backdrop" data-escape-dialog="" ref={importSettingsEscapeRef} onMouseDown={props.onImportClose}>
      <section className="dialog scene-import-settings-dialog" role="dialog" aria-modal="true" aria-label={tr(props.locale, "RVT 导入设置", "RVT import settings")} onMouseDown={(event) => event.stopPropagation()}>
        <span className="eyebrow">RVT / REVIT</span>
        <h2>{tr(props.locale, "导入设置", "Import settings")}</h2>
        <p>{tr(props.locale, "这些选项仅影响 RVT 文件；其他模型格式会忽略它们。", "These options only affect RVT files; other formats ignore them.")}</p>
        <RvtImportSettings locale={props.locale} mode={props.rvtConversionMode} revitVersion={props.revitVersion} runtime={props.revitRuntime} onModeChange={props.onRvtConversionModeChange} onRevitVersionChange={props.onRevitVersionChange} />
        <div className="dialog-actions">
          <button type="button" className="button" onClick={props.onImportClose}>{tr(props.locale, "完成", "Done")}</button>
          <button type="button" className="button primary" onClick={() => { props.onImportClose(); props.onImportModel(); }}>{tr(props.locale, "选择 RVT 文件", "Choose RVT file")}</button>
        </div>
      </section>
    </div>,
    document.body,
  ) : null;
  return (
    <aside className="left-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">{tr(props.locale, "场景目录", "SCENE OUTLINER")}</span>
          <h2>{tr(props.locale, "场景对象", "Scene objects")}</h2>
        </div>
        <div className="panel-heading-actions">
          <button
            className={`panel-mode-button ${resourceOpen ? "active" : ""}`}
            title={tr(props.locale, "浏览并插入资源", "Browse and insert resources")}
            aria-label={tr(props.locale, "资源", "Resources")}
            onClick={() => { const next = !resourceOpen; setResourceOpen(next); if (next) props.onImportClose(); }}
          >
            <Boxes size={17} />
            <span>{tr(props.locale, "资源", "Resources")}</span>
          </button>
          <button
            className="icon-button"
            aria-label={tr(props.locale, "导入模型", "Import model")}
            title={tr(props.locale, "导入模型", "Import model")}
            onClick={() => { setResourceOpen(false); props.onImportModel(); }}
            disabled={props.uploading}
          >
            {props.uploading ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <Plus size={18} />
            )}
          </button>
        </div>
      </div>
      {!resourceOpen && (
        <ComponentSearch {...props} />
      )}
      {!resourceOpen && (
        <div className="asset-list unified-object-manager">
          {props.objectContent}
        </div>
      )}
      {deviceLayoutDialog}
      {smartBindingDialog}
      {resourcePanel}
      {importSettingsDialog}
    </aside>
  );
}
