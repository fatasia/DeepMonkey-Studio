import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { BimPropertyEntry, StandardView } from "../viewer/ViewerEngine";

export function ToolButton({ title, active, onClick, icon, className = "", disabled = false }: {
  title: string;
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return <button className={`tool-button ${active ? "active" : ""} ${className}`.trim()} title={title} aria-label={title} disabled={disabled} onClick={onClick}>{icon}<span>{title}</span></button>;
}

export function ViewControl({ locale, onSelect }: { locale: AppLocale; onSelect: (view: StandardView) => void }) {
  return (
    <div className="view-control" aria-label={tr(locale, "标准视图", "Standard views")}>
      <button onClick={() => onSelect("top")}>{tr(locale, "上", "Top")}</button>
      <div><button onClick={() => onSelect("left")}>{tr(locale, "左", "Left")}</button><button onClick={() => onSelect("front")}>{tr(locale, "前", "Front")}</button><button onClick={() => onSelect("right")}>{tr(locale, "右", "Right")}</button></div>
      <div><button onClick={() => onSelect("back")}>{tr(locale, "后", "Back")}</button><button onClick={() => onSelect("bottom")}>{tr(locale, "下", "Bottom")}</button></div>
    </div>
  );
}

export function StructuredProperties({ locale, entries, emptyText }: { locale: AppLocale; entries: BimPropertyEntry[]; emptyText: string }) {
  const groups = groupPropertyEntries(entries);
  if (groups.length === 0) return <div className="property-empty">{emptyText}</div>;
  return <div className="structured-properties">
    <div className="section-label property-label"><span>{tr(locale, "BIM 属性", "BIM properties")}</span><small>{entries.length}</small></div>
    {groups.map((group, index) => <details key={group.name} open={index < 2}>
      <summary><span>{tr(locale, group.name, propertyGroupEnglishName(group.name))}</span><small>{group.entries.length}</small><ChevronRight size={12} /></summary>
      <dl className="property-list">{group.entries.map((entry, entryIndex) => <div key={`${entry.name}:${entryIndex}`}><dt title={entry.name}>{entry.name}</dt><dd title={entry.value}>{entry.value}</dd></div>)}</dl>
    </details>)}
  </div>;
}

export function DeferredNumberInput({ value, onCommit, min, max, step, disabled, className, ariaLabel }: {
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  function commit() {
    focused.current = false;
    // Esc 触发 blur 在本次 React 更新之前执行，不能用上一帧草稿回写对象。
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(String(value));
      return;
    }
    const parsed = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  }

  function updateDraft(next: string) {
    focused.current = true;
    setDraft(next);
  }

  return <input
    className={className}
    aria-label={ariaLabel}
    disabled={disabled}
    type="text"
    inputMode="decimal"
    data-min={min}
    data-max={max}
    data-step={step}
    value={draft}
    onFocus={() => { focused.current = true; cancelled.current = false; }}
    onInput={(event) => {
      // 空值和未完成的小数先保留为草稿，失焦时再校验，避免输入过程被强制回弹。
      updateDraft(event.currentTarget.value);
    }}
    onChange={(event) => updateDraft(event.currentTarget.value)}
    onBlur={commit}
    onKeyDown={(event) => {
      if (event.key === "Enter") event.currentTarget.blur();
      if (event.key === "Escape") {
        event.stopPropagation();
        cancelled.current = true;
        setDraft(String(value));
        event.currentTarget.blur();
      }
    }}
  />;
}

export function TransformFields({ title, transform, suffix, disabled = false, onChange }: {
  title: string;
  transform: { x: number; y: number; z: number };
  suffix?: string;
  disabled?: boolean;
  onChange: (axis: "x" | "y" | "z", value: string) => void;
}) {
  return (
    <fieldset className="transform-fields">
      <legend>{title}</legend>
      <div>{(["x", "y", "z"] as const).map((axis) => <label key={axis}><span>{axis.toUpperCase()}</span><DeferredNumberInput ariaLabel={`${title} ${axis.toUpperCase()}${suffix ? ` (${suffix})` : ""}`} disabled={disabled} step={0.1} value={Number(transform[axis].toFixed(3))} onCommit={(value) => onChange(axis, String(value))} />{suffix && <i>{suffix}</i>}</label>)}</div>
    </fieldset>
  );
}

function groupPropertyEntries(entries: BimPropertyEntry[]) {
  const names = ["基本信息", "标识与分类", "位置与尺寸", "材质", "约束", "能耗与负荷", "阶段与 IFC", "其他参数"] as const;
  const grouped = new Map<string, BimPropertyEntry[]>(names.map((name) => [name, []]));
  for (const entry of entries) {
    const token = `${entry.group ?? ""} ${entry.name}`.toLocaleLowerCase("zh-CN");
    let group: typeof names[number] = "其他参数";
    if (/名称|name|类型|type|对象数量|构件数量/.test(token)) group = "基本信息";
    else if (/identity|编号|id|guid|类别|category|族|family|department|部门/.test(token)) group = "标识与分类";
    else if (/dimension|面积|体积|长度|宽度|高度|周长|尺寸|坐标|边界|位置|offset|偏移/.test(token)) group = "位置与尺寸";
    else if (/material|材质|混凝土|钢|木|玻璃/.test(token)) group = "材质";
    else if (/constraint|约束|标高|level|上限|底部|顶部/.test(token)) group = "约束";
    else if (/energy|负荷|功率|照明|热增量|人数/.test(token)) group = "能耗与负荷";
    else if (/phase|ifc|阶段/.test(token)) group = "阶段与 IFC";
    grouped.get(group)?.push(entry);
  }
  return names.flatMap((name) => {
    const groupEntries = grouped.get(name) ?? [];
    return groupEntries.length ? [{ name, entries: groupEntries }] : [];
  });
}

function propertyGroupEnglishName(name: string): string {
  if (name === "基本信息") return "General";
  if (name === "标识与分类") return "Identity and classification";
  if (name === "位置与尺寸") return "Location and dimensions";
  if (name === "材质") return "Materials";
  if (name === "约束") return "Constraints";
  if (name === "能耗与负荷") return "Energy and loads";
  if (name === "阶段与 IFC") return "Phasing and IFC";
  return "Other parameters";
}
