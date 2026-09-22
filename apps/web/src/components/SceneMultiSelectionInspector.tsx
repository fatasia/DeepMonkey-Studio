import { AlignCenterHorizontal, AlignCenterVertical, Layers3, Space } from "lucide-react";
import type { AppStudioController } from "../views/AppStudioShell";
import { translate as tr } from "../i18n";
import { SceneMultiTransformEditor } from "./SceneMultiTransformEditor";
import { SceneMultiMaterialEditor } from "./SceneMultiMaterialEditor";

/** Owns the multi-selection summary, shared editors and layout actions. */
export function SceneMultiSelectionInspector({ controller }: { controller: AppStudioController }) {
  const { locale, sceneOrganizationSelection, sceneOrganizationObjects, layoutSelectedObjects } = controller;
  return (
    <div className="inspector-content inspector-multi-selection">
      <div className="inspector-selection-context">
        <span className="inspector-selection-icon"><Layers3 size={16} /></span>
        <span>
          <strong>{tr(locale, `已选择 ${sceneOrganizationSelection.size} 个对象`, `${sceneOrganizationSelection.size} objects selected`)}</strong>
          <small>{tr(locale, "场景目录多选", "Scene outliner selection")}</small>
        </span>
      </div>
      <div className="inspector-selection-list">
        {sceneOrganizationObjects
          .filter((item) => sceneOrganizationSelection.has(item.id))
          .slice(0, 8)
          .map((item) => <span title={item.name} key={item.id}>{item.name}</span>)}
        {sceneOrganizationSelection.size > 8 && <small>+{sceneOrganizationSelection.size - 8}</small>}
      </div>
      <SceneMultiTransformEditor {...controller} />
      <SceneMultiMaterialEditor {...controller} />
      <section className="inspector-multi-layout" aria-label={tr(locale, "多选布局", "Multi-selection layout")}>
        <header><span><AlignCenterHorizontal size={14} /><strong>{tr(locale, "布局", "Layout")}</strong></span><small>{tr(locale, "以主选对象对齐", "Align to primary")}</small></header>
        <div>
          {(["x", "y", "z"] as const).map((axis) => <button key={axis} type="button" onClick={() => layoutSelectedObjects("align", axis)}><AlignCenterVertical size={12} />{axis.toUpperCase()} {tr(locale, "对齐", "Align")}</button>)}
        </div>
        <div>
          {(["x", "z"] as const).map((axis) => <button key={axis} type="button" disabled={sceneOrganizationSelection.size < 3} onClick={() => layoutSelectedObjects("distribute", axis)}><Space size={12} />{axis.toUpperCase()} {tr(locale, "等距", "Distribute")}</button>)}
        </div>
        <small>{tr(locale, "等距保留两端位置；锁定对象不会移动。", "Distribution preserves both ends; locked objects stay in place.")}</small>
      </section>
    </div>
  );
}
