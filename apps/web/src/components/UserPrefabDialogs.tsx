import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Check, RefreshCw, X } from "lucide-react";
import type { UserPrefabDefinition, UserPrefabUpdateDiff } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { useDialogEscape } from "../hooks/useGlobalDialogEscape";

/** 属性路径 → 中文标签；未知路径原样展示（诚实优先）。 */
const PREFAB_PATH_LABELS: Record<string, string> = {
  name: "名称",
  visible: "可见性",
  opacity: "不透明度",
  color: "颜色",
  colorOverride: "覆盖色",
  material: "材质",
  effects: "特效",
};

function pathLabel(path: string, locale: AppLocale): string {
  const direct = PREFAB_PATH_LABELS[path];
  if (direct) return locale === "zh-CN" ? direct : path;
  return path.replace(/^transform\.position\.([xyz])$/, "位置.$1")
    .replace(/^transform\.rotation\.([xyz])$/, "旋转.$1")
    .replace(/^transform\.scale\.([xyz])$/, "缩放.$1");
}

function formatValue(value: unknown, locale: AppLocale): string {
  if (value === null || value === undefined) return tr(locale, "（无）", "(none)");
  if (typeof value === "boolean") return value ? tr(locale, "是", "yes") : tr(locale, "否", "no");
  if (typeof value === "number") return String(Math.round(value * 1000) / 1000);
  if (typeof value === "string") return value;
  return "…";
}

/** 功能 1 对话框：多选 → 命名/分类 → 入库。 */
export function SaveUserPrefabDialog({ locale, defaultName, busy, onSave, onClose }: {
  locale: AppLocale;
  defaultName: string;
  busy?: boolean | undefined;
  onSave: (name: string, category: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(defaultName);
  const [category, setCategory] = useState(locale === "zh-CN" ? "未分类" : "Uncategorized");
  useEffect(() => { const previous = document.activeElement; dialog.current?.showModal(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  const escapeRef = useDialogEscape(onClose);
  return <dialog ref={(element) => { dialog.current = element; escapeRef(element); }} className="dialog user-prefab-dialog" role="dialog" aria-modal="true" aria-label={tr(locale, "存为预制体", "Save as prefab")} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <span className="eyebrow">{tr(locale, "PREFAB", "PREFAB")}</span>
    <h2>{tr(locale, "存为预制体", "Save as prefab")}</h2>
    <p>{tr(locale, "当前选中的对象组合将存为可复用模板；插入实例保持层级与相对位置。", "The selected objects are saved as a reusable template; instances keep hierarchy and relative placement.")}</p>
    <label className="user-prefab-field">
      <span>{tr(locale, "名称", "Name")}</span>
      <input autoFocus value={name} onChange={(event) => setName(event.target.value)} aria-label={tr(locale, "预制体名称", "Prefab name")} maxLength={60} onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) onSave(name.trim(), category.trim()); }} />
    </label>
    <label className="user-prefab-field">
      <span>{tr(locale, "分类", "Category")}</span>
      <input value={category} onChange={(event) => setCategory(event.target.value)} aria-label={tr(locale, "预制体分类", "Prefab category")} maxLength={30} list="user-prefab-categories" />
      <datalist id="user-prefab-categories">
        {(locale === "zh-CN" ? ["泵/风机", "输送线", "传感器", "工作站", "未分类"] : ["Pumps/Fans", "Conveyors", "Sensors", "Workstations", "Uncategorized"]).map((item) => <option key={item} value={item} />)}
      </datalist>
    </label>
    <div className="dialog-actions">
      <button type="button" className="button" onClick={onClose}>{tr(locale, "取消", "Cancel")}</button>
      <button type="button" className="button primary" disabled={!name.trim() || busy} onClick={() => onSave(name.trim(), category.trim())}>{tr(locale, "存为预制体", "Save prefab")}</button>
    </div>
  </dialog>;
}

/** 功能 3 对话框：应用更新 diff 预览，用户确认后才落写。 */
export function ApplyUserPrefabUpdateDialog({ locale, prefabName, diff, busy, onApply, onClose }: {
  locale: AppLocale;
  prefabName: string;
  diff: UserPrefabUpdateDiff;
  busy?: boolean | undefined;
  onApply: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement; dialog.current?.showModal(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  const escapeRef = useDialogEscape(onClose);
  const kept = diff.changed.filter((change) => change.overridden);
  const applied = diff.changed.filter((change) => !change.overridden);
  const empty = !diff.added.length && !diff.removed.length && !applied.length;
  return <dialog ref={(element) => { dialog.current = element; escapeRef(element); }} className="dialog user-prefab-dialog user-prefab-diff-dialog" role="dialog" aria-modal="true" aria-label={tr(locale, "应用原型更新", "Apply prototype update")} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <span className="eyebrow">{tr(locale, "PREFAB UPDATE", "PREFAB UPDATE")}</span>
    <h2>{tr(locale, `应用“${prefabName}”更新`, `Apply “${prefabName}” update`)}</h2>
    <p>{tr(locale, `原型 v${diff.fromVersion} → v${diff.toVersion}；实例级覆盖保持不变。`, `Prototype v${diff.fromVersion} → v${diff.toVersion}; instance overrides are kept.`)}</p>
    {empty && <div className="user-prefab-diff-empty" role="status">{tr(locale, "属性无变化，仅推进实例版本。", "No property changes; only the instance version advances.")}</div>}
    {diff.added.length > 0 && <section className="user-prefab-diff-section">
      <h3><ArrowDown size={13} />{tr(locale, `新增成员（${diff.added.length}）`, `Added members (${diff.added.length})`)}</h3>
      <ul>{diff.added.map((item) => <li key={item.sourceId}><strong>{item.name}</strong><small>{item.kind === "model" ? tr(locale, "模型", "model") : tr(locale, "基础元素", "primitive")}</small></li>)}</ul>
    </section>}
    {diff.removed.length > 0 && <section className="user-prefab-diff-section">
      <h3><ArrowUp size={13} />{tr(locale, `移除成员（${diff.removed.length}）`, `Removed members (${diff.removed.length})`)}</h3>
      <ul>{diff.removed.map((item) => <li key={item.sceneObjectId}><strong>{item.name}</strong><small>{item.reason === "prototype" ? tr(locale, "原型已删除", "removed in prototype") : tr(locale, "场景中已不存在，仅清理链接", "missing in scene; link cleanup only")}</small></li>)}</ul>
    </section>}
    {applied.length > 0 && <section className="user-prefab-diff-section">
      <h3><RefreshCw size={13} />{tr(locale, `属性更新（${applied.length}）`, `Property updates (${applied.length})`)}</h3>
      <ul>{applied.map((change) => <li key={`${change.sceneObjectId}:${change.path}`}><strong>{change.name}</strong><code>{pathLabel(change.path, locale)}</code><span className="user-prefab-diff-values"><s>{formatValue(change.from, locale)}</s> → {formatValue(change.to, locale)}</span></li>)}</ul>
    </section>}
    {kept.length > 0 && <section className="user-prefab-diff-section user-prefab-diff-kept">
      <h3><AlertTriangle size={13} />{tr(locale, `保留实例覆盖（${kept.length}）`, `Instance overrides kept (${kept.length})`)}</h3>
      <ul>{kept.map((change) => <li key={`${change.sceneObjectId}:${change.path}`}><strong>{change.name}</strong><code>{pathLabel(change.path, locale)}</code><span className="user-prefab-diff-values">{formatValue(change.from, locale)}{tr(locale, "（覆盖保留）", " (override kept)")}</span></li>)}</ul>
    </section>}
    <div className="dialog-actions">
      <button type="button" className="button" onClick={onClose}>{tr(locale, "取消", "Cancel")}</button>
      <button type="button" className="button primary" disabled={busy} onClick={onApply}><Check size={14} />{tr(locale, "应用更新", "Apply update")}</button>
    </div>
  </dialog>;
}

/** 行内徽章：实例成员（含待更新/覆盖态）。 */
export function UserPrefabRowBadge({ locale, overridden, pending }: { locale: AppLocale; overridden?: boolean | undefined; pending?: boolean | undefined }) {
  if (!overridden && !pending) return <span className="user-prefab-chip" title={tr(locale, "预制体实例成员", "Prefab instance member")}>{tr(locale, "预制", "P")}</span>;
  if (pending) return <span className="user-prefab-chip pending" title={tr(locale, "原型有更新待应用", "Prototype update pending")}>{tr(locale, "待更新", "update")}</span>;
  return <span className="user-prefab-chip overridden" title={tr(locale, "存在实例级覆盖", "Has instance overrides")}>{tr(locale, "覆盖", "ovr")}</span>;
}

export function prefabDisplayName(definition: UserPrefabDefinition | undefined, locale: AppLocale): string {
  return definition?.name ?? tr(locale, "预制体", "Prefab");
}
