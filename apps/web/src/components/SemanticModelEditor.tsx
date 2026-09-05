import { useState } from "react";
import { SemanticPipelineFields } from "./SemanticPipelineFields";
import type {
  DataDatasetRecord,
  DataPipelineDefinition,
  SemanticModelRecord,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { SemanticDimensionList } from "./SemanticDimensionList";
import { SemanticMetricList } from "./SemanticMetricList";
import { SemanticParameterList } from "./SemanticParameterList";
import { semanticSourceFields } from "./semanticModelEditorLogic";

export function SemanticModelEditor({
  value,
  datasets,
  pipelines,
  projectId,
  locale,
  busy,
  errors,
  onChange,
  onSave,
  onClose,
}: {
  value: SemanticModelRecord;
  datasets: DataDatasetRecord[];
  pipelines: DataPipelineDefinition[];
  projectId: string;
  locale: AppLocale;
  busy: boolean;
  errors: string[];
  onChange: (value: SemanticModelRecord) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const [section, setSection] = useState<
    "metrics" | "dimensions" | "parameters"
  >("metrics");
  const fields = semanticSourceFields(value, datasets);
  const patch = (update: Partial<SemanticModelRecord>) =>
    onChange({ ...value, ...update });
  return (
    <form
      className="semantic-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
      aria-label={tr(locale, "语义模型编辑器", "Semantic model editor")}
    >
      <header>
        <div>
          <strong>
            {value.revision
              ? tr(locale, "编辑语义模型", "Edit semantic model")
              : tr(locale, "新建语义模型", "New semantic model")}
          </strong>
          <small>
            {value.revision
              ? `r${value.revision}`
              : tr(locale, "尚未保存", "Not saved")}
          </small>
        </div>
        <button type="button" onClick={onClose} disabled={busy}>
          {tr(locale, "返回列表", "Back to list")}
        </button>
      </header>
      <fieldset disabled={busy}>
        <div className="semantic-form-grid">
          <label>
            <span>{tr(locale, "模型名称", "Model name")}</span>
            <input
              autoFocus
              aria-label={tr(locale, "模型名称", "Model name")}
              value={value.name}
              maxLength={80}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder={tr(
                locale,
                "例如：产线运营口径",
                "For example: production metrics",
              )}
            />
          </label>
          <label>
            <span>{tr(locale, "数据来源", "Data source")}</span>
            <select
              aria-label={tr(locale, "模型数据来源", "Model data source")}
              value={
                value.source.id ? `${value.source.kind}:${value.source.id}` : ""
              }
              onChange={(event) => {
                const [kind, ...id] = event.target.value.split(":");
                if (kind !== "dataset" && kind !== "pipeline") return;
                patch({
                  source: {
                    kind,
                    id: id.join(":"),
                    ...(kind === "pipeline" ? { fields: [] } : {}),
                  },
                });
              }}
            >
              <option value="">
                {tr(locale, "选择数据产品", "Choose a data product")}
              </option>
              {value.source.id &&
                !(value.source.kind === "dataset" ? datasets : pipelines).some(
                  (item) => item.id === value.source.id,
                ) && (
                  <option value={`${value.source.kind}:${value.source.id}`}>
                    {value.source.id} · {tr(locale, "已失效", "Unavailable")}
                  </option>
                )}
              <optgroup label={tr(locale, "数据集", "Datasets")}>
                {datasets.map((item) => (
                  <option key={item.id} value={`dataset:${item.id}`}>
                    {item.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label={tr(locale, "管道", "Pipelines")}>
                {pipelines.map((item) => (
                  <option key={item.id} value={`pipeline:${item.id}`}>
                    {item.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
        </div>
        <label>
          <span>{tr(locale, "说明", "Description")}</span>
          <input
            value={value.description ?? ""}
            onChange={(event) => patch({ description: event.target.value })}
          />
        </label>
        <small>
          {tr(
            locale,
            "更换来源会保留已填写的定义；失效引用会在字段和保存校验中提示。",
            "Changing the source keeps your definitions. Invalid references are shown in fields and save validation.",
          )}
        </small>
        {value.source.kind === "pipeline" && (
          <SemanticPipelineFields
            key={`${value.id}:${value.source.id}`}
            projectId={projectId}
            pipelineId={value.source.id}
            fields={fields}
            onChange={(fields) =>
              patch({ source: { ...value.source, fields } })
            }
            locale={locale}
          />
        )}
        <details className="semantic-source-reference">
          <summary>
            {tr(locale, "源字段参考", "Source field reference")} ·{" "}
            {fields.length}
          </summary>
          <div className="semantic-field-chips">
            {fields.map((field) => (
              <span key={field.key} title={`${field.key} · ${field.type}`}>
                {field.label}
                <small>{field.key}</small>
              </span>
            ))}
            {!fields.length && (
              <p>
                {tr(
                  locale,
                  "选择来源或导入管道输出字段后显示。",
                  "Choose a source or import pipeline output fields.",
                )}
              </p>
            )}
          </div>
        </details>
        <nav
          className="semantic-editor-tabs"
          aria-label={tr(
            locale,
            "语义定义分类",
            "Semantic definition sections",
          )}
        >
          {(["metrics", "dimensions", "parameters"] as const).map(
            (key, index) => (
              <button
                type="button"
                key={key}
                className={section === key ? "active" : ""}
                aria-pressed={section === key}
                onClick={() => setSection(key)}
              >
                {locale === "zh-CN" ? ["指标", "维度", "参数"][index] : key}
                <span>{value[key].length}</span>
              </button>
            ),
          )}
        </nav>
        {section === "metrics" && (
          <SemanticMetricList
            locale={locale}
            value={value.metrics}
            fields={fields}
            onChange={(metrics) => patch({ metrics })}
          />
        )}
        {section === "dimensions" && (
          <SemanticDimensionList
            locale={locale}
            value={value.dimensions}
            fields={fields}
            onChange={(dimensions) => patch({ dimensions })}
          />
        )}
        {section === "parameters" && (
          <SemanticParameterList
            locale={locale}
            value={value.parameters}
            dimensions={value.dimensions}
            onChange={(parameters) => patch({ parameters })}
          />
        )}
      </fieldset>
      <footer className="semantic-save-bar">
        {errors.length > 0 && (
          <div role="alert">
            <strong>
              {tr(
                locale,
                "请修正以下问题，草稿已保留",
                "Fix these issues. Your draft is preserved",
              )}
            </strong>
            <ul>
              {errors.map((error, index) => (
                <li key={index}>{error}</li>
              ))}
            </ul>
          </div>
        )}
        <span>
          {tr(
            locale,
            "手动保存 · 不改变已发布的页面",
            "Manual save · published pages stay unchanged",
          )}
        </span>
        <button className="primary" type="submit" disabled={busy}>
          {busy
            ? tr(locale, "正在保存…", "Saving…")
            : tr(locale, "保存语义模型", "Save semantic model")}
        </button>
      </footer>
    </form>
  );
}
