import { useEffect, useId, useRef, useState } from "react";
import { Database, Plus, X } from "lucide-react";
import { createUpdateDashboardDataWidgetCommand } from "@bim-studio/studio-core";
import { translate as tr } from "../i18n";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";
import { useDashboardDataBinding } from "./DashboardDataBindingProvider";
import { bindDashboardField, DASHBOARD_FIELD_MIME, dashboardFieldRoles, fieldMatchesRole, readDashboardFieldDrag, unbindDashboardField, widgetFieldProduct, widgetRoleField, type FieldRole } from "./dashboardFieldBinding";

const roleNames = { dimension: ["维度", "Dimension"], measure: ["指标", "Measure"], series: ["系列（可选）", "Series (optional)"] } as const;

export function DashboardFieldSlots() {
  const { selectedNode, locale } = useDashboardWorkspace();
  const { products, status, setOpen } = useDashboardDataBinding();
  if (selectedNode?.kind !== "data-widget") return null;
  const roles = dashboardFieldRoles(selectedNode.widget.type);
  if (!roles.length) return null;
  const product = products.find((item) => item.key === widgetFieldProduct(selectedNode.widget));
  return <section className="dashboard-field-slots" aria-label={tr(locale, "字段绑定", "Field bindings")}>
    <header><strong>{tr(locale, "字段绑定", "Field bindings")}</strong><button type="button" onClick={() => setOpen(true)} title={tr(locale, "展开数据字段", "Open data fields")}><Database size={13} />{tr(locale, "选字段", "Fields")}</button></header>
    {product && <small className="dashboard-slot-product" title={product.name}>{product.name}</small>}
    {status === "loading" && <p role="status">{tr(locale, "正在读取字段…", "Loading fields…")}</p>}
    {status === "error" && <p role="alert">{tr(locale, "目录读取失败，请展开字段面板重试。", "Catalog failed. Open the fields panel to retry.")}</p>}
    {roles.map((role) => <DashboardFieldSlot key={role} role={role} />)}
  </section>;
}

function DashboardFieldSlot({ role }: { role: FieldRole }) {
  const { selectedNode, page, onCommand, locale, busy } = useDashboardWorkspace();
  const { products, drag, loadPipeline, setOpen } = useDashboardDataBinding();
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(0);
  const [message, setMessage] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const label = tr(locale, roleNames[role][0], roleNames[role][1]);
  const choices = products.flatMap((product) => product.status === "ready" ? product.fields.filter((field) => fieldMatchesRole(field, role)).map((field) => ({ product, field })) : []);
  useEffect(() => { if (expanded) listRef.current?.focus(); }, [expanded]);
  useEffect(() => { if (expanded) listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [active, expanded]);
  useEffect(() => { setExpanded(false); setMessage(""); }, [selectedNode?.id, page.id]);
  if (selectedNode?.kind !== "data-widget") return null;
  const widget = selectedNode.widget;
  const product = products.find((item) => item.key === widgetFieldProduct(widget));
  const key = widgetRoleField(widget, role);
  const field = product?.fields.find((item) => item.key === key);
  const draggedProduct = products.find((item) => item.key === drag?.productKey);
  const draggedField = draggedProduct?.fields.find((item) => item.key === drag?.fieldKey);
  const rejected = Boolean(drag && (!draggedField || !fieldMatchesRole(draggedField, role)));
  const expectation = role === "measure" ? tr(locale, "需要数值字段", "Requires a numeric field") : role === "series" ? tr(locale, "需要文本字段", "Requires a text field") : tr(locale, "需要文本或日期字段", "Requires a text or date field");
  const close = () => { setExpanded(false); buttonRef.current?.focus(); };
  const commit = (productKey: string, fieldKey: string) => {
    if (busy || selectedNode.locked) return;
    const selected = products.find((item) => item.key === productKey);
    const next = selected && bindDashboardField(widget, role, selected, fieldKey);
    if (!next) { setMessage(tr(locale, "字段已失效或类型不匹配：", "Field unavailable or incompatible: ") + expectation); return; }
    if (JSON.stringify(next) !== JSON.stringify(widget)) onCommand(createUpdateDashboardDataWidgetCommand(page.id, selectedNode.id, next));
    setMessage(""); close();
  };
  return <div className={`dashboard-field-slot${key ? " is-bound" : ""}${rejected || message ? " is-rejected" : drag ? " is-accepting" : ""}`} data-field-role={role}
    onDragOver={(event) => { if (event.dataTransfer.types.includes(DASHBOARD_FIELD_MIME)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; } }}
    onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const payload = readDashboardFieldDrag(event.dataTransfer.getData(DASHBOARD_FIELD_MIME)); if (payload) commit(payload.productKey, payload.fieldKey); else setMessage(tr(locale, "无法识别字段，请从字段面板重新拖入。", "Invalid field. Drag it again from the fields panel.")); }}>
    <span className="dashboard-slot-label">{label}</span>
    <div className="dashboard-slot-value"><button ref={buttonRef} type="button" className="dashboard-slot-trigger" disabled={busy || selectedNode.locked} aria-label={`${label}：${field?.label || key || tr(locale, "未绑定", "Unbound")}`} aria-haspopup="listbox" aria-expanded={expanded} aria-controls={expanded ? listId : undefined} onClick={() => { setExpanded(!expanded); setActive(0); setMessage(""); if (product?.status === "idle") void loadPipeline(product.key); }} onKeyDown={(event) => {
      if (!expanded && ["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        const buttons = [...event.currentTarget.closest(".dashboard-field-slots")!.querySelectorAll<HTMLButtonElement>(".dashboard-slot-trigger")];
        const index = buttons.indexOf(event.currentTarget);
        buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    }} title={key ? `${field?.label ?? key} · ${field?.type ?? tr(locale, "字段待确认", "Unresolved field")} · ${expectation}` : expectation}>
      {key ? <span className="dashboard-field-type">{field?.type === "number" ? "#" : field?.type === "datetime" ? "◷" : "Aa"}</span> : <Plus size={14} />}<span>{field?.label || key || tr(locale, `拖入${roleNames[role][0].replace("（可选）", "")}字段`, `Choose ${roleNames[role][1].toLowerCase()}`)}</span>{field?.unit && <small>{field.unit}</small>}
    </button>{key && <button type="button" className="dashboard-slot-remove" disabled={busy || selectedNode.locked} aria-label={tr(locale, `解绑${roleNames[role][0]}`, `Unbind ${roleNames[role][1].toLowerCase()}`)} onClick={() => { onCommand(createUpdateDashboardDataWidgetCommand(page.id, selectedNode.id, unbindDashboardField(widget, role))); setMessage(""); }}><X size={13} /></button>}</div>
    {key && product?.status === "ready" && !field && <small role="status">{tr(locale, "原字段已不存在，请重新绑定。", "This field no longer exists. Rebind it.")}</small>}
    {(message || rejected) && <small role="alert">{message || expectation}</small>}
    {expanded && <div className="dashboard-slot-picker">
      <div id={listId} ref={listRef} role="listbox" tabIndex={0} aria-label={tr(locale, `选择${roleNames[role][0]}字段`, `Choose ${roleNames[role][1].toLowerCase()}`)} aria-activedescendant={choices[active] ? `${listId}-${active}` : undefined} onBlur={(event) => { if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) setExpanded(false); }} onKeyDown={(event) => {
        if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); }
        if (event.key === "Escape") close();
        if (event.key === "ArrowDown") setActive((index) => Math.min(choices.length - 1, index + 1));
        if (event.key === "ArrowUp") setActive((index) => Math.max(0, index - 1));
        if (event.key === "Home") setActive(0);
        if (event.key === "End") setActive(Math.max(0, choices.length - 1));
        if (event.key === "Enter" && choices[active]) commit(choices[active].product.key, choices[active].field.key);
      }}>
        {choices.map(({ product: candidate, field: item }, index) => <button type="button" role="option" id={`${listId}-${index}`} key={`${candidate.key}:${item.key}`} aria-selected={active === index} tabIndex={-1} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => commit(candidate.key, item.key)}><span>{item.label}{item.unit ? ` · ${item.unit}` : ""}</span><small>{candidate.name} · {item.key}</small></button>)}
        {choices.length === 0 && <p>{tr(locale, "没有匹配字段", "No compatible fields")}</p>}
      </div>
      <button type="button" onClick={() => { setOpen(true); close(); }}>{tr(locale, "浏览全部数据产品", "Browse all data products")}</button>
    </div>}
  </div>;
}
