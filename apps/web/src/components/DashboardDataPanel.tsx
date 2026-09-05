import { ChevronDown, Database, PanelRightClose, RefreshCw, Search } from "lucide-react";
import { useState } from "react";
import { translate as tr } from "../i18n";
import { useDashboardDataBinding } from "./DashboardDataBindingProvider";
import { DASHBOARD_FIELD_MIME, type DashboardFieldProduct } from "./dashboardFieldBinding";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

export function filterDashboardFieldProducts(products: DashboardFieldProduct[], query: string) {
  const search = query.trim().toLocaleLowerCase();
  return products.flatMap((product) => {
    if (!search || product.name.toLocaleLowerCase().includes(search)) return [product];
    const fields = product.fields.filter((field) => `${field.key} ${field.label} ${field.unit ?? ""}`.toLocaleLowerCase().includes(search));
    return fields.length ? [{ ...product, fields }] : [];
  });
}

export function DashboardDataPanel() {
  const { locale, onOpenData, selectedNode, setInspectorOpen, setInspectorTab } = useDashboardWorkspace();
  const { open, setOpen, products, status, error, refresh, loadPipeline, setDrag } = useDashboardDataBinding();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
  const visible = filterDashboardFieldProducts(products, query);
  const reveal = () => { setOpen(true); setInspectorOpen(true); if (selectedNode?.kind === "data-widget") setInspectorTab("data"); };
  return <aside className={`dashboard-field-panel-shell${open ? " is-open" : ""}`} aria-label={tr(locale, "字段面板", "Fields panel")}>
    {!open ? <button type="button" className="dashboard-field-panel-handle" onClick={reveal} aria-expanded={false} title={tr(locale, "展开数据字段", "Open data fields")}>
      <Database size={15} /><span>{tr(locale, "数据", "Data")}</span>
    </button> : <section className="dashboard-field-panel">
      <header><strong>{tr(locale, "数据字段", "Data fields")}</strong><div>
        <button type="button" onClick={() => { setDrag(undefined); void refresh(); }} disabled={status === "loading"} aria-label={tr(locale, "刷新字段目录", "Refresh fields")}><RefreshCw size={14} /></button>
        <button type="button" onClick={() => setOpen(false)} aria-label={tr(locale, "收起字段面板", "Close fields panel")} aria-expanded={true}><PanelRightClose size={15} /></button>
      </div></header>
      <label className="dashboard-field-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr(locale, "搜索产品或字段", "Search products or fields")} aria-label={tr(locale, "搜索数据字段", "Search data fields")} /></label>
      <p>{tr(locale, "拖到右侧字段槽，或在槽中按 Enter 选择。", "Drag into a field slot, or press Enter on a slot to choose.")}</p>
      <div className="dashboard-field-catalog">
        {status === "loading" && <p role="status">{tr(locale, "正在读取数据目录…", "Loading data catalog…")}</p>}
        {status === "error" && <div role="alert"><p>{error}</p><button type="button" onClick={() => void refresh()}>{tr(locale, "重试", "Retry")}</button></div>}
        {status === "ready" && products.length === 0 && <div className="dashboard-field-empty"><Database size={24} /><p>{tr(locale, "数据中心还没有数据产品", "No data products yet")}</p><button type="button" onClick={onOpenData}>{tr(locale, "前往数据中心", "Open Data Center")}</button></div>}
        {status === "ready" && products.length > 0 && visible.length === 0 && <p>{tr(locale, "没有匹配的字段", "No matching fields")}</p>}
        {(["dataset:", "pipeline:"] as const).map((kind) => {
          const group = visible.filter((product) => product.key.startsWith(kind));
          if (!group.length) return null;
          return <section key={kind} className="dashboard-field-group"><h3>{kind === "dataset:" ? tr(locale, "数据集", "Datasets") : tr(locale, "管道输出", "Pipeline outputs")}</h3>
            {group.map((product) => {
              const isExpanded = expanded.includes(product.key) || Boolean(query.trim());
              return <div key={product.key} className="dashboard-field-product">
                <button type="button" className="dashboard-field-product-toggle" aria-expanded={isExpanded} onClick={() => {
                  setExpanded((current) => current.includes(product.key) ? current.filter((key) => key !== product.key) : [...current, product.key]);
                  if (product.status === "idle") void loadPipeline(product.key);
                }}><ChevronDown size={13} className={isExpanded ? "" : "is-closed"} /><span title={product.name}>{product.name}</span><small>{product.status === "ready" ? product.fields.length : "—"}</small></button>
                {isExpanded && <div className="dashboard-field-list" role="list" aria-label={product.name}>
                  {product.status === "idle" && <button type="button" onClick={() => void loadPipeline(product.key)}>{tr(locale, "运行预览以获取字段", "Preview to load fields")}</button>}
                  {product.status === "loading" && <p role="status">{tr(locale, "正在读取输出字段…", "Loading output fields…")}</p>}
                  {product.status === "error" && <div role="alert"><p>{product.error}</p><button type="button" onClick={() => void loadPipeline(product.key)}>{tr(locale, "重试字段预览", "Retry field preview")}</button></div>}
                  {product.status === "ready" && product.fields.length === 0 && <p>{tr(locale, "暂无输出字段，请检查数据产品。", "No output fields. Check this data product.")}</p>}
                  {product.fields.map((field) => <div key={field.key} className="dashboard-field-row" role="listitem" draggable={product.status === "ready"} title={`${field.label} · ${field.key} · ${field.type}`} onDragStart={(event) => {
                    const payload = { productKey: product.key, fieldKey: field.key, fieldType: field.type, label: field.label, unit: field.unit };
                    event.dataTransfer.setData(DASHBOARD_FIELD_MIME, JSON.stringify(payload));
                    event.dataTransfer.effectAllowed = "copy";
                    setDrag(payload); setInspectorOpen(true); setInspectorTab("data");
                  }}><span className="dashboard-field-type" aria-label={field.type}>{field.type === "number" ? "#" : field.type === "datetime" ? "◷" : field.type === "string" ? "Aa" : "{}"}</span><span><strong>{field.label}</strong><small>{field.key}</small></span>{field.unit && <small>{field.unit}</small>}</div>)}
                </div>}
              </div>;
            })}
          </section>;
        })}
      </div>
      <footer><button type="button" onClick={onOpenData}>{tr(locale, "管理数据产品", "Manage data products")} ↗</button></footer>
    </section>}
  </aside>;
}
