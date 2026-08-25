import { useMemo, useState } from "react";
import { Box, Eye, EyeOff, Focus, Layers3, Lock, RotateCcw, Save, Search, Trash2, Unlock, X } from "lucide-react";
import type { SceneSelectionSetState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

export interface SceneOrganizationObject {
  id: string;
  name: string;
  kind: "model" | "primitive";
  visible: boolean;
  locked: boolean;
}

interface Props {
  locale: AppLocale;
  objects: SceneOrganizationObject[];
  selectedIds: ReadonlySet<string>;
  selectionSets: SceneSelectionSetState[];
  lastDeletedSelectionSet: SceneSelectionSetState | undefined;
  isolationActive: boolean;
  onClose: () => void;
  onToggle: (id: string) => void;
  onSelect: (ids: string[]) => void;
  onShow: (ids: string[], visible: boolean) => void;
  onLock: (ids: string[], locked: boolean) => void;
  onIsolate: (ids: string[]) => void;
  onRestoreIsolation: () => void;
  onCreateSelectionSet: (name: string) => void;
  onUpdateSelectionSet: (id: string) => void;
  onApplySelectionSet: (id: string) => void;
  onDeleteSelectionSet: (id: string) => void;
  onRestoreDeletedSelectionSet: () => void;
}

export function SceneOrganizationPanel(props: Props) {
  const [query, setQuery] = useState("");
  const [setName, setSetName] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const filtered = useMemo(() => normalizedQuery
    ? props.objects.filter((item) => `${item.name} ${item.kind}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
    : props.objects, [normalizedQuery, props.objects]);
  const selected = props.objects.filter((item) => props.selectedIds.has(item.id));
  const selectedVisible = selected.filter((item) => item.visible).length;
  const selectedLocked = selected.filter((item) => item.locked).length;

  function createSet() {
    if (selected.length === 0) return;
    props.onCreateSelectionSet(setName.trim());
    setSetName("");
  }

  return <section className="scene-organization-panel" aria-label={tr(props.locale, "场景组织", "Scene organization")}>
    <header>
      <div><strong>{tr(props.locale, "场景组织", "Scene organization")}</strong><small>{tr(props.locale, "批量管理对象并保存常用选择", "Batch-manage objects and save reusable selections")}</small></div>
      <button aria-label={tr(props.locale, "关闭场景组织", "Close scene organization")} onClick={props.onClose}><X size={14} /></button>
    </header>

    <div className="scene-organization-summary">
      <div><strong>{selected.length}</strong><span>{tr(props.locale, "已选择", "selected")}</span></div>
      <div><strong>{selectedVisible}</strong><span>{tr(props.locale, "当前显示", "visible")}</span></div>
      <div><strong>{selectedLocked}</strong><span>{tr(props.locale, "已锁定", "locked")}</span></div>
    </div>

    <div className="scene-organization-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr(props.locale, "筛选模型与基础元素", "Filter models and primitives")} aria-label={tr(props.locale, "筛选场景对象", "Filter scene objects")} />{query && <button aria-label={tr(props.locale, "清空筛选", "Clear filter")} onClick={() => setQuery("")}><X size={12} /></button>}</div>
    <div className="scene-organization-select-actions">
      <button disabled={filtered.length === 0} onClick={() => props.onSelect(filtered.map((item) => item.id))}>{tr(props.locale, "选择筛选结果", "Select filtered")}</button>
      <button disabled={props.objects.length === 0} onClick={() => props.onSelect(props.objects.filter((item) => item.visible).map((item) => item.id))}>{tr(props.locale, "选择可见", "Select visible")}</button>
      <button disabled={selected.length === 0} onClick={() => props.onSelect([])}>{tr(props.locale, "清空", "Clear")}</button>
    </div>

    <div className="scene-organization-object-list">
      {filtered.map((item) => <label key={item.id} className={props.selectedIds.has(item.id) ? "selected" : ""}>
        <input type="checkbox" checked={props.selectedIds.has(item.id)} onChange={() => props.onToggle(item.id)} />
        <span className="scene-organization-object-icon">{item.kind === "model" ? <Layers3 size={13} /> : <Box size={13} />}</span>
        <span className="scene-organization-object-copy"><strong title={item.name}>{item.name}</strong><small>{item.kind === "model" ? tr(props.locale, "模型", "Model") : tr(props.locale, "基础元素", "Primitive")}</small></span>
        <span className="scene-organization-object-state" title={item.visible ? tr(props.locale, "显示", "Visible") : tr(props.locale, "隐藏", "Hidden")}>{item.visible ? <Eye size={12} /> : <EyeOff size={12} />}</span>
        {item.locked && <span className="scene-organization-object-state locked" title={tr(props.locale, "已锁定", "Locked")}><Lock size={12} /></span>}
      </label>)}
      {props.objects.length === 0 && <div className="scene-organization-empty"><Layers3 size={20} /><strong>{tr(props.locale, "还没有可组织的对象", "No objects to organize")}</strong><span>{tr(props.locale, "上传模型或创建基础元素后，可在这里批量管理。", "Upload a model or create a primitive to batch-manage it here.")}</span></div>}
      {props.objects.length > 0 && filtered.length === 0 && <div className="scene-organization-empty compact"><Search size={18} /><strong>{tr(props.locale, "没有匹配对象", "No matching objects")}</strong><button onClick={() => setQuery("")}>{tr(props.locale, "清空筛选", "Clear filter")}</button></div>}
    </div>

    <div className="scene-organization-batch-actions" aria-label={tr(props.locale, "批量操作", "Batch actions")}>
      <button disabled={selected.length === 0} onClick={() => props.onShow(selected.map((item) => item.id), true)}><Eye size={13} />{tr(props.locale, "显示", "Show")}</button>
      <button disabled={selected.length === 0} onClick={() => props.onShow(selected.map((item) => item.id), false)}><EyeOff size={13} />{tr(props.locale, "隐藏", "Hide")}</button>
      <button disabled={selected.length === 0} onClick={() => props.onLock(selected.map((item) => item.id), true)}><Lock size={13} />{tr(props.locale, "锁定", "Lock")}</button>
      <button disabled={selected.length === 0} onClick={() => props.onLock(selected.map((item) => item.id), false)}><Unlock size={13} />{tr(props.locale, "解锁", "Unlock")}</button>
      <button disabled={selected.length === 0} onClick={() => props.onIsolate(selected.map((item) => item.id))}><Focus size={13} />{tr(props.locale, "隔离", "Isolate")}</button>
      <button disabled={!props.isolationActive} onClick={props.onRestoreIsolation}><RotateCcw size={13} />{tr(props.locale, "恢复", "Restore")}</button>
    </div>

    <div className="scene-selection-sets">
      <div className="scene-selection-set-heading"><div><strong>{tr(props.locale, "选择集", "Selection sets")}</strong><small>{tr(props.locale, "随场景保存", "Saved with scene")}</small></div><span>{props.selectionSets.length}</span></div>
      <div className="scene-selection-set-create"><input value={setName} onChange={(event) => setSetName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") createSet(); }} placeholder={tr(props.locale, `例如：${props.selectionSets.length + 1} 号产线`, `For example: Line ${props.selectionSets.length + 1}`)} aria-label={tr(props.locale, "选择集名称", "Selection set name")} /><button disabled={selected.length === 0} onClick={createSet}><Save size={13} />{tr(props.locale, "保存当前", "Save current")}</button></div>
      <div className="scene-selection-set-list">
        {props.lastDeletedSelectionSet && <div className="scene-selection-set-undo"><span>{tr(props.locale, `已删除“${props.lastDeletedSelectionSet.name}”`, `Deleted “${props.lastDeletedSelectionSet.name}”`)}</span><button onClick={props.onRestoreDeletedSelectionSet}>{tr(props.locale, "撤销", "Undo")}</button></div>}
        {props.selectionSets.map((set) => {
          const available = set.objectIds.filter((id) => props.objects.some((item) => item.id === id)).length;
          return <div key={set.id}><button className="scene-selection-set-main" disabled={available === 0} onClick={() => props.onApplySelectionSet(set.id)}><strong title={set.name}>{set.name}</strong><small>{available === set.objectIds.length ? `${available} ${tr(props.locale, "个对象", "objects")}` : `${available}/${set.objectIds.length} ${tr(props.locale, "可用", "available")}`}</small></button><button disabled={selected.length === 0} title={tr(props.locale, "用当前选择覆盖", "Replace with current selection")} onClick={() => props.onUpdateSelectionSet(set.id)}><Save size={12} /></button><button className="danger" aria-label={`${tr(props.locale, "删除选择集", "Delete selection set")} ${set.name}`} onClick={() => props.onDeleteSelectionSet(set.id)}><Trash2 size={12} /></button></div>;
        })}
        {props.selectionSets.length === 0 && <p>{tr(props.locale, "选择对象后保存为选择集，下次可一键载入。", "Select objects and save a set to restore the selection later.")}</p>}
      </div>
    </div>
  </section>;
}
