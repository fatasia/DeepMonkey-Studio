import { translate as tr } from "../i18n";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

export function DashboardInspectorBulkData() {
  const { datasets, inspectorTab, locale, pipelines, replaceSelectedDataProduct, selectedDataNodes, selectedDataProductValue, selectedDataProductValues } = useDashboardWorkspace();
  return (
    inspectorTab === "data" &&
    selectedDataNodes.length > 1 && (
      <section className="dashboard-inspector-section dashboard-bulk-data-product">
        <header>
          <strong>{tr(locale, "整组替换数据", "Replace group data")}</strong>
          <small>{tr(locale, `${selectedDataNodes.length} 个可编辑数据组件`, `${selectedDataNodes.length} editable data widgets`)}</small>
        </header>
        <label>
          <span>{tr(locale, "目标数据产品", "Target data product")}</span>
          <select value={selectedDataProductValue} onChange={(event) => replaceSelectedDataProduct(event.target.value)}>
            <option value="">
              {selectedDataProductValues.length > 1 ? tr(locale, "当前使用多个数据源", "Multiple sources in use") : tr(locale, "选择数据产品", "Choose a data product")}
            </option>
            {pipelines.length > 0 && (
              <optgroup label={tr(locale, "数据管道（推荐）", "Data pipelines (recommended)")}>
                {pipelines.map((pipeline) => (
                  <option key={pipeline.id} value={`pipeline:${pipeline.id}`}>
                    {pipeline.name}
                  </option>
                ))}
              </optgroup>
            )}
            {datasets.length > 0 && (
              <optgroup label={tr(locale, "原始数据集", "Raw datasets")}>
                {datasets.map((dataset) => (
                  <option key={dataset.id} value={`dataset:${dataset.id}`}>
                    {dataset.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <small>
            {tr(
              locale,
              "优先保留同名字段；缺失字段会按维度、指标和系列类型自动映射，一次撤销即可恢复整组。",
              "Matching fields are preserved; missing dimension, measure and series roles are remapped by type and the whole replacement is one undo step.",
            )}
          </small>
        </label>
      </section>
    )
  );
}
