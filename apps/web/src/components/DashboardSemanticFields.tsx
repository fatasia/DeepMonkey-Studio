import { createUpdateDashboardDataWidgetCommand } from "@bim-studio/studio-core";
import { translate as tr } from "../i18n";
import { bindSemanticWidget, resolveSemanticWidget, supportsSemanticWidget, type SemanticBinding } from "./dashboardSemanticBinding";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";
import "./DashboardSemanticFields.css";

/** 语义口径独占指标/维度角色，裸字段编辑保持为另一种明确模式。 */
export function DashboardSemanticFields() {
  const { project, selectedNode, page, locale, onCommand } = useDashboardWorkspace();
  if (selectedNode?.kind !== "data-widget") return null;
  const widget = selectedNode.widget;
  const models = project.semanticModels ?? [];
  if ((!models.length || !supportsSemanticWidget(widget)) && !widget.semanticBinding) return null;
  const model = models.find((item) => item.id === widget.semanticBinding?.modelId);
  const resolved = resolveSemanticWidget(widget, models);
  const change = (patch: Partial<SemanticBinding>) => {
    if (model) onCommand(createUpdateDashboardDataWidgetCommand(page.id, selectedNode.id, bindSemanticWidget(widget, selectedNode.id, model, patch)));
  };
  return <div className="dashboard-semantic-binding">
    <label><span>{tr(locale, "语义模型", "Semantic model")}</span>
      <select aria-label={tr(locale, "语义模型", "Semantic model")} value={widget.semanticBinding?.modelId ?? ""} onChange={(event) => {
        const nextModel = models.find((item) => item.id === event.target.value);
        const next = nextModel ? bindSemanticWidget(widget, selectedNode.id, nextModel) : { ...widget };
        if (!nextModel) {
          delete next.semanticBinding;
          next.key = next.field && (next.datasetId || next.pipelineId) ? `${next.pipelineId ?? next.datasetId}.${next.field}` : "";
        }
        onCommand(createUpdateDashboardDataWidgetCommand(page.id, selectedNode.id, next));
      }}>
        <option value="">{tr(locale, "不使用 · 自定义字段", "None · Custom fields")}</option>
        {!model && widget.semanticBinding && <option value={widget.semanticBinding.modelId}>{tr(locale, "模型已失效", "Model unavailable")}</option>}
        {models.map((item) => <option key={item.id} value={item.id}>{item.name} · v{item.revision}</option>)}
      </select>
    </label>
    {resolved.error && <p className="dashboard-data-binding-state error" role="alert">{resolved.error}</p>}
    {model && widget.semanticBinding && <>
      {widget.type === "filter" ? <label><span>{tr(locale, "语义参数", "Semantic parameter")}</span>
        <select aria-label={tr(locale, "语义参数", "Semantic parameter")} value={widget.semanticBinding.parameterKey ?? ""} onChange={(event) => change({ parameterKey: event.target.value })}>
          <option value="">{tr(locale, "选择参数", "Choose a parameter")}</option>
          {model.parameters.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select>
      </label> : <>
        <label><span>{tr(locale, "语义指标", "Semantic metric")}</span>
          <select aria-label={tr(locale, "语义指标", "Semantic metric")} value={widget.semanticBinding.metricKey ?? ""} onChange={(event) => change({ metricKey: event.target.value })}>
            <option value="">{tr(locale, "选择指标", "Choose a metric")}</option>
            {model.metrics.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select>
        </label>
        <label><span>{tr(locale, "语义维度 / 钻取层级", "Semantic dimension / Drill hierarchy")}</span>
          <select aria-label={tr(locale, "语义维度", "Semantic dimension")} value={widget.semanticBinding.dimensionKey ?? ""} onChange={(event) => change({ dimensionKey: event.target.value })}>
            <option value="">{tr(locale, "总体指标", "Overall metric")}</option>
            {model.dimensions.map((item) => <option key={item.key} value={item.key}>{item.label}{item.hierarchy?.length ? ` · ${item.hierarchy.length} 级` : ""}</option>)}
          </select>
        </label>
        <label className="dashboard-semantic-link"><input type="checkbox" checked={widget.semanticBinding.autoLink !== false} onChange={(event) => change({ autoLink: event.target.checked })} />{tr(locale, "同模型自动联动", "Link widgets using this model")}</label>
      </>}
      <small>{tr(locale, "聚合、默认过滤和层级沿用数据中心口径。点击图表替换本组件条件，多个组件条件共同生效。", "Aggregation, defaults and hierarchy follow the model. Clicks replace this widget's condition; conditions across widgets combine.")}</small>
      {model.revision !== widget.semanticBinding.revision && <button type="button" onClick={() => change({})}>{tr(locale, "确认使用新口径", "Confirm new definition")}</button>}
    </>}
  </div>;
}
