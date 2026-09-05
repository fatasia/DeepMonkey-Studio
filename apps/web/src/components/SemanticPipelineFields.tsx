import { useEffect, useRef, useState } from "react";
import type { DataDatasetField } from "@bim-studio/contracts";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";

export function SemanticPipelineFields({
  projectId,
  pipelineId,
  fields,
  onChange,
  locale,
}: {
  projectId: string;
  pipelineId: string;
  fields: DataDatasetField[];
  onChange: (fields: DataDatasetField[]) => void;
  locale: AppLocale;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  const pending = useRef(false);
  // 本组件按源 ID 挂载，迟到预览不能把字段写入另一来源或覆盖卸载后的草稿。
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const preview = async () => {
    if (pending.current || !pipelineId) return;
    if (
      fields.length &&
      !window.confirm(
        tr(
          locale,
          "用本次预览替换字段清单？指标和维度定义会保留。",
          "Replace the field list with this preview? Metric and dimension definitions are preserved.",
        ),
      )
    )
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api.previewDataPipeline(projectId, pipelineId);
      if (!active.current) return;
      if (result.status === "error")
        throw new Error(
          result.error || tr(locale, "管道预览失败", "Pipeline preview failed"),
        );
      changeRef.current(result.fields);
    } catch (reason) {
      if (active.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  };
  const patch = (index: number, update: Partial<DataDatasetField>) =>
    onChange(
      fields.map((field, at) =>
        at === index ? { ...field, ...update } : field,
      ),
    );
  return (
    <section
      className="semantic-pipeline-fields"
      aria-label={tr(locale, "管道输出字段", "Pipeline output fields")}
    >
      <header>
        <strong>{tr(locale, "管道输出字段", "Pipeline output fields")}</strong>
        <button
          type="button"
          disabled={busy || !pipelineId}
          onClick={() => void preview()}
        >
          {busy
            ? tr(locale, "读取中…", "Loading…")
            : tr(locale, "从预览导入字段", "Import preview fields")}
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      <fieldset disabled={busy}>
        {fields.map((field, index) => (
          <div className="semantic-pipeline-field" key={index}>
            <label>
              <span>{tr(locale, "字段键", "Field key")}</span>
              <input
                value={field.key}
                onChange={(event) => patch(index, { key: event.target.value })}
              />
            </label>
            <label>
              <span>{tr(locale, "字段名", "Field label")}</span>
              <input
                value={field.label}
                onChange={(event) =>
                  patch(index, { label: event.target.value })
                }
              />
            </label>
            <label>
              <span>{tr(locale, "字段类型", "Field type")}</span>
              <select
                value={field.type}
                onChange={(event) =>
                  patch(index, {
                    type: event.target.value as DataDatasetField["type"],
                  })
                }
              >
                {["string", "number", "boolean", "datetime", "json"].map(
                  (type) => (
                    <option key={type}>{type}</option>
                  ),
                )}
              </select>
            </label>
            <button
              type="button"
              aria-label={tr(
                locale,
                `删除字段 ${index + 1}`,
                `Remove field ${index + 1}`,
              )}
              onClick={() => onChange(fields.filter((_, at) => at !== index))}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            onChange([...fields, { key: "", label: "", type: "string" }])
          }
        >
          {tr(locale, "新增输出字段", "Add output field")}
        </button>
      </fieldset>
    </section>
  );
}
