import { Eye, EyeOff, Focus, Layers3, RotateCcw, X } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import type { LoadedSceneModel } from "../viewer/ViewerEngine";
import { StructuredProperties } from "./AppFormControls";

interface PublishedViewerObjectPanelProps {
  locale: AppLocale;
  models: LoadedSceneModel[];
  selected: LoadedSceneModel | undefined;
  properties: Record<string, string>;
  isolationActive: boolean;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  onVisibilityChange: (id: string, visible: boolean) => void;
  onIsolate: (id: string) => void;
  onRestoreIsolation: () => void;
  onShowAll: () => void;
  onClose: () => void;
}

/** 发布浏览的对象面板仅提供临时可见性、定位和属性查看。 */
export function PublishedViewerObjectPanel(props: PublishedViewerObjectPanelProps) {
  return (
    <aside className="viewer-object-panel" aria-label={tr(props.locale, "场景对象与属性", "Scene objects and properties")}>
      <header>
        <div>
          <strong>{tr(props.locale, "场景对象", "Scene objects")}</strong>
          <small>{props.models.length}</small>
        </div>
        <button title={tr(props.locale, "关闭", "Close")} onClick={props.onClose}><X size={15} /></button>
      </header>
      <div className="viewer-object-actions">
        <button disabled={!props.isolationActive} onClick={props.onRestoreIsolation}><RotateCcw size={13} />{tr(props.locale, "恢复隔离", "Restore isolation")}</button>
        <button onClick={props.onShowAll}><Eye size={13} />{tr(props.locale, "全部显示", "Show all")}</button>
      </div>
      <div className="viewer-object-list">
        {props.models.map((model) => (
          <div key={model.id} className={props.selected?.id === model.id ? "selected" : ""}>
            <button className="viewer-object-main" onClick={() => props.onSelect(model.id)}>
              <Layers3 size={14} />
              <span><strong>{model.name}</strong><small>{model.kind === "model" ? tr(props.locale, "模型", "Model") : tr(props.locale, "基础元素", "Primitive")}</small></span>
            </button>
            <button title={tr(props.locale, "定位", "Focus")} onClick={() => props.onFocus(model.id)}><Focus size={14} /></button>
            <button title={model.visible ? tr(props.locale, "隐藏", "Hide") : tr(props.locale, "显示", "Show")} onClick={() => props.onVisibilityChange(model.id, !model.visible)}>
              {model.visible ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
            <button title={tr(props.locale, "隔离", "Isolate")} onClick={() => props.onIsolate(model.id)}><Layers3 size={14} /></button>
          </div>
        ))}
        {props.models.length === 0 && <p>{tr(props.locale, "场景中暂无可查看对象", "No viewable objects in this scene")}</p>}
      </div>
      <section className="viewer-object-properties">
        <StructuredProperties
          locale={props.locale}
          entries={Object.entries(props.properties).map(([name, value]) => ({ name, value }))}
          emptyText={tr(props.locale, "选择对象后查看工程属性", "Select an object to inspect its properties")}
        />
      </section>
    </aside>
  );
}
