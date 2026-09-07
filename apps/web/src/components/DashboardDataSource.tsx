import type { DirectBindingSpec } from "@bim-studio/contracts";
import { useEffect, useState } from "react";
import { createUpdateDashboardDataWidgetCommand } from "@bim-studio/studio-core";
import { createDefaultDirectBinding, DirectBindingEditor } from "./DirectBindingEditor";
import { DashboardDataRefreshSummary } from "./DashboardDataRefreshSummary";
import { dashboardFieldRoles } from "./dashboardFieldBinding";
import { useDashboardDataBinding } from "./DashboardDataBindingProvider";
import { replaceDashboardWidgetDataProduct } from "./dashboardDataProductReplacement";
import { translate as tr } from "../i18n";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";
import { DashboardSemanticFields } from "./DashboardSemanticFields";
import { DashboardSampleDataEditor } from "./DashboardSampleDataEditor";
import { withDashboardSampleData } from "./dashboardSampleMetrics";

export function DashboardDataSource() {
  const { catalogError, datasets, fieldsByProduct, locale, onCommand, onOpenData, page, pipelines, selectDataField, selectDataProduct, selectedNode, statusByProduct, updateDataWidget } = useDashboardWorkspace();
  const { products, setOpen } = useDashboardDataBinding();
  const [choosingProduct, setChoosingProduct] = useState(false);
  useEffect(() => setChoosingProduct(false), [selectedNode?.id]);
  if (selectedNode?.kind !== "data-widget") return null;
  if (selectedNode.widget.semanticBinding) return <DashboardSemanticFields />;
  return <>
        <DashboardSemanticFields />
        <label>
          <span>{tr(locale, "数据来源", "Data source")}</span>
          <select
            aria-label={tr(locale, "数据来源", "Data source")}
            value={choosingProduct ? "platform" : selectedNode.widget.sampleData ? "sample" : selectedNode.widget.directBinding ? "direct" : selectedNode.widget.pipelineId || selectedNode.widget.datasetId ? "platform" : "unbound"}
            onChange={(event) => {
              const mode = event.target.value;
              setChoosingProduct(mode === "platform");
              if (mode === "direct") {
                const next = {
                  ...selectedNode.widget,
                  directBinding: createDefaultDirectBinding(),
                };
                delete next.datasetId;
                delete next.pipelineId;
                delete next.sampleData;
                onCommand(createUpdateDashboardDataWidgetCommand(page.id, selectedNode.id, next));
              } else if (mode === "sample") onCommand(createUpdateDashboardDataWidgetCommand(page.id, selectedNode.id, withDashboardSampleData(selectedNode.widget)));
              else if (mode === "platform") setOpen(true);
              else selectDataProduct("");
            }}
          >
            <option value="unbound">{tr(locale, "实时变量 / 未绑定", "Live variable / Unbound")}</option>
            <option value="platform">{tr(locale, "数据中心", "Data Center")}</option>
            <option value="direct">{tr(locale, "直接 HTTP / WebSocket", "Direct HTTP / WebSocket")}</option>
            <option value="sample">{tr(locale, "示例数据", "Sample data")}</option>
          </select>
        </label>
        {selectedNode.widget.sampleData && <DashboardSampleDataEditor key={selectedNode.id} locale={locale} widget={selectedNode.widget} disabled={selectedNode.locked ?? false} onChange={updateDataWidget} />}
        {(choosingProduct || !selectedNode.widget.directBinding && (selectedNode.widget.pipelineId || selectedNode.widget.datasetId)) && (
          <label>
            <span>{tr(locale, "数据产品", "Data product")}</span>
            <select
              aria-label={tr(locale, "数据产品", "Data product")}
              value={
                selectedNode.widget.pipelineId ? `pipeline:${selectedNode.widget.pipelineId}` : selectedNode.widget.datasetId ? `dataset:${selectedNode.widget.datasetId}` : ""
              }
              onChange={(event) => {
                const product = products.find((item) => item.key === event.target.value);
                if (!product) return;
                onCommand(createUpdateDashboardDataWidgetCommand(page.id, selectedNode.id, replaceDashboardWidgetDataProduct(selectedNode.widget, product.key, product.fields)));
                setChoosingProduct(false);
              }}
            >
              <option value="">{tr(locale, "选择数据产品", "Choose a data product")}</option>
              {products.some((product) => product.key.startsWith("pipeline:")) && (
                <optgroup label={tr(locale, "数据管道（推荐）", "Data pipelines (recommended)")}>
                  {products.filter((product) => product.key.startsWith("pipeline:")).map((product) => (
                    <option key={product.key} value={product.key}>
                      {product.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {products.some((product) => product.key.startsWith("dataset:")) && (
                <optgroup label={tr(locale, "原始数据集", "Raw datasets")}>
                  {products.filter((product) => product.key.startsWith("dataset:")).map((product) => (
                    <option key={product.key} value={product.key}>
                      {product.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
        )}
        {!selectedNode.widget.directBinding && (selectedNode.widget.pipelineId || selectedNode.widget.datasetId) && (
          <DashboardDataRefreshSummary
            locale={locale}
            kind={selectedNode.widget.pipelineId ? "pipeline" : "dataset"}
            productId={selectedNode.widget.pipelineId ?? selectedNode.widget.datasetId!}
            datasets={datasets}
            pipelines={pipelines}
            onOpenData={onOpenData}
          />
        )}
        {selectedNode.widget.directBinding && (
          <DirectBindingEditor
            locale={locale}
            value={selectedNode.widget.directBinding}
            onChange={(directBinding: DirectBindingSpec) =>
              updateDataWidget({
                directBinding,
                key: selectedNode.widget.key || directBinding.selection?.field || "value",
              })
            }
          />
        )}
        {(() => {
          if (selectedNode.widget.sampleData) return null;
          if (selectedNode.widget.directBinding)
            return (
              <label>
                <span>{tr(locale, "组件数据键", "Widget data key")}</span>
                <input value={selectedNode.widget.key} onChange={(event) => updateDataWidget({ key: event.target.value })} />
              </label>
            );
          if (dashboardFieldRoles(selectedNode.widget.type).length && (selectedNode.widget.pipelineId || selectedNode.widget.datasetId)) return null;
          const productId = selectedNode.widget.pipelineId ?? selectedNode.widget.datasetId;
          const productKey = selectedNode.widget.pipelineId
            ? `pipeline:${selectedNode.widget.pipelineId}`
            : selectedNode.widget.datasetId
              ? `dataset:${selectedNode.widget.datasetId}`
              : undefined;
          const status = productKey ? statusByProduct[productKey] : undefined;
          const fields = productKey ? (fieldsByProduct[productKey] ?? []) : [];
          if (!productId)
            return (
              <label>
                <span>{tr(locale, "数据键", "Data key")}</span>
                <input
                  defaultValue={selectedNode.widget.key}
                  key={`${selectedNode.id}:key:${selectedNode.widget.key}`}
                  onBlur={(event) => {
                    if (event.currentTarget.value !== selectedNode.widget.key)
                      updateDataWidget({
                        key: event.currentTarget.value,
                      });
                  }}
                />
              </label>
            );
          if (status === "loading" && fields.length === 0) return <div className="dashboard-data-binding-state">{tr(locale, "正在读取字段…", "Loading fields…")}</div>;
          if (status === "error")
            return (
              <div className="dashboard-data-binding-state error">
                {tr(locale, "数据产品运行失败，请到数据中心检查节点诊断。", "The data product failed. Open Data Center for node diagnostics.")}
              </div>
            );
          return (
            <label>
              <span>{tr(locale, "字段", "Field")}</span>
              <select value={selectedNode.widget.field ?? ""} onChange={(event) => selectDataField(event.target.value)}>
                <option value="">{tr(locale, "选择输出字段", "Choose an output field")}</option>
                {fields.map((field) => (
                  <option key={field.key} value={field.key}>
                    {field.label}
                    {field.unit ? ` · ${field.unit}` : ""}
                  </option>
                ))}
              </select>
            </label>
          );
        })()}
        {catalogError && <div className="dashboard-data-binding-state error">{tr(locale, "数据目录暂不可用，请稍后重试。", "The data catalog is temporarily unavailable.")}</div>}
  </>;
}
