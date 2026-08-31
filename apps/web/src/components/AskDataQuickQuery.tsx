import type { AskDataAggregationOperator, AskDataQueryPlanInput, AskDataQueryPlanningResult, AskDataQueryReadResult, DataDatasetRecord } from "@bim-studio/contracts";
import { BarChart3, LoaderCircle, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import "./AskDataQuickQuery.css";

export function AskDataQuickQuery({ projectId, datasets, locale }: { projectId: string; datasets: DataDatasetRecord[]; locale: AppLocale }) {
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? "");
  const dataset = datasets.find((item) => item.id === datasetId) ?? datasets[0];
  const defaults = selectionDefaults(dataset);
  const [metric, setMetric] = useState(defaults.metric);
  const [groupBy, setGroupBy] = useState(defaults.groupBy);
  const [operator, setOperator] = useState<AskDataAggregationOperator>("avg");
  const [result, setResult] = useState<AskDataQueryReadResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const t = (zh: string, en: string) => tr(locale, zh, en);

  useEffect(() => {
    const active = datasets.find((item) => item.id === datasetId) ?? datasets[0];
    if (!active) return;
    const next = selectionDefaults(active);
    if (datasetId !== active.id) setDatasetId(active.id);
    setMetric((current) => (active.fields.some((field) => field.key === current && field.type === "number") ? current : next.metric));
    setGroupBy((current) => (!current || active.fields.some((field) => field.key === current) ? current : next.groupBy));
  }, [datasetId, datasets]);

  function selectDataset(nextId: string) {
    const next = datasets.find((item) => item.id === nextId);
    const nextDefaults = selectionDefaults(next);
    setDatasetId(nextId);
    setMetric(nextDefaults.metric);
    setGroupBy(nextDefaults.groupBy);
    setResult(undefined);
    setError("");
  }

  async function run() {
    if (!dataset || !metric) return;
    setBusy(true);
    setError("");
    try {
      const input = buildQuickAskDataPlan(dataset, metric, groupBy, operator);
      const planned = await api.invokeCapability<AskDataQueryPlanningResult>(projectId, "data.query.plan", input);
      if (!planned.output?.plan) throw new Error(planned.output?.issues[0]?.message ?? planned.error?.message ?? "查询计划需要补充字段");
      const read = await api.invokeCapability<AskDataQueryReadResult>(projectId, "data.query.read", { plan: planned.output.plan });
      if (!read.output) throw new Error(read.error?.message ?? "数据读取没有返回结果");
      setResult(read.output);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!datasets.length)
    return (
      <section className="ask-data-quick empty">
        <BarChart3 size={16} />
        <span>
          <strong>{t("项目还没有数据集", "No project datasets")}</strong>
          <small>{t("先在数据中心接入数据，再从这里直接统计。", "Connect data in Data Center, then query it here.")}</small>
        </span>
      </section>
    );
  const numericFields = dataset?.fields.filter((field) => field.type === "number") ?? [];
  const groupFields = dataset?.fields.filter((field) => ["string", "boolean"].includes(field.type)) ?? [];

  return (
    <section className="ask-data-quick">
      <header>
        <span>
          <BarChart3 size={14} />
          <strong>{t("零 SQL 快速统计", "No-SQL quick analysis")}</strong>
        </span>
        <small>{t("先确定性校验，再读取项目数据", "Validate first, then read project data")}</small>
      </header>
      <div className="ask-data-controls">
        <label>
          <span>{t("数据集", "Dataset")}</span>
          <select value={dataset?.id ?? ""} onChange={(event) => selectDataset(event.target.value)}>
            {datasets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("指标", "Metric")}</span>
          <select value={metric} onChange={(event) => setMetric(event.target.value)}>
            {numericFields.map((field) => (
              <option key={field.key} value={field.key}>
                {field.label}
                {field.unit ? ` (${field.unit})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("统计", "Aggregate")}</span>
          <select value={operator} onChange={(event) => setOperator(event.target.value as AskDataAggregationOperator)}>
            <option value="avg">{t("平均值", "Average")}</option>
            <option value="sum">{t("合计", "Sum")}</option>
            <option value="min">{t("最小值", "Minimum")}</option>
            <option value="max">{t("最大值", "Maximum")}</option>
            <option value="count">{t("记录数", "Count")}</option>
          </select>
        </label>
        <label>
          <span>{t("分组（可选）", "Group (optional)")}</span>
          <select value={groupBy} onChange={(event) => setGroupBy(event.target.value)}>
            <option value="">{t("不分组", "No grouping")}</option>
            {groupFields.map((field) => (
              <option key={field.key} value={field.key}>
                {field.label}
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy || !metric} onClick={() => void run()}>
          {busy ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />}
          {t("直接统计", "Run")}
        </button>
      </div>
      {!numericFields.length && <p>{t("该数据集没有可统计的数值字段。", "This dataset has no numeric fields.")}</p>}
      {error && <p className="error">{error}</p>}
      {result && (
        <div className="ask-data-result">
          <small>{t(`匹配 ${result.matchedRows} 行 · 返回 ${result.returnedRows} 行`, `${result.matchedRows} matched · ${result.returnedRows} returned`)}</small>
          <div>
            <table>
              <thead>
                <tr>
                  {result.columns.map((column) => (
                    <th key={column.key}>{column.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, index) => (
                  <tr key={index}>
                    {result.columns.map((column) => (
                      <td key={column.key}>{formatValue(row[column.key])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <code title={result.evidenceFingerprint}>{result.evidenceFingerprint}</code>
        </div>
      )}
    </section>
  );
}

export function buildQuickAskDataPlan(dataset: DataDatasetRecord, metric: string, groupBy: string, operator: AskDataAggregationOperator): AskDataQueryPlanInput {
  const alias = `${operator}_${metric}`;
  return {
    datasetId: dataset.id,
    fields: [...new Set([...(groupBy ? [groupBy] : []), metric])],
    ...(groupBy ? { groupBy: [groupBy] } : {}),
    aggregations: [{ operator, field: metric, as: alias }],
    sort: { field: alias, direction: "desc" },
    limit: 20,
  };
}

function selectionDefaults(dataset: DataDatasetRecord | undefined): { metric: string; groupBy: string } {
  return {
    metric: dataset?.fields.find((field) => field.type === "number")?.key ?? "",
    groupBy: dataset?.fields.find((field) => ["string", "boolean"].includes(field.type))?.key ?? "",
  };
}

function formatValue(value: unknown): string {
  return typeof value === "number" ? Number(value.toFixed(4)).toLocaleString() : String(value ?? "—");
}
