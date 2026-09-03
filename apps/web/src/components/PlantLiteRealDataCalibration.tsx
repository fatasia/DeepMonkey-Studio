import { AlertTriangle, BadgeCheck, CircleX, Database, LoaderCircle, RefreshCw, ShieldQuestion } from "lucide-react";
import { useRef, useState } from "react";
import type { DataDatasetField, DataDatasetPreview, DataDatasetRecord, PlantLiteStudyRecord } from "@bim-studio/contracts";
import {
  buildPlantLiteCalibrationEvidence,
  EMPTY_PLANT_LITE_CALIBRATION_MAPPING,
  plantLiteCalibrationWindowBounds,
  type PlantLiteCalibrationEvidence,
  type PlantLiteCalibrationMapping,
  type PlantLiteCalibrationMetricKey,
  type PlantLiteCalibrationMetricMapping,
  type PlantLiteCalibrationStatus,
  type PlantLiteCalibrationUnit,
  type PlantLiteCalibrationWindow,
} from "./plantLiteCalibrationEvidence";
import "./PlantLiteRealDataCalibration.css";

export function PlantLiteRealDataCalibration({
  study,
  datasets,
  loadPreview,
}: {
  study: PlantLiteStudyRecord;
  datasets: DataDatasetRecord[];
  loadPreview: (datasetId: string) => Promise<DataDatasetPreview>;
}) {
  const [datasetId, setDatasetId] = useState("");
  const [preview, setPreview] = useState<DataDatasetPreview>();
  const [mapping, setMapping] = useState<PlantLiteCalibrationMapping>(() => cloneEmptyMapping());
  const [window, setWindow] = useState<PlantLiteCalibrationWindow>({ startInclusive: "", endInclusive: "" });
  const [minimumSamples, setMinimumSamples] = useState(3);
  const [evidence, setEvidence] = useState<PlantLiteCalibrationEvidence>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestSequence = useRef(0);
  const dataset = datasets.find((item) => item.id === datasetId);
  const timestampFields = preview?.fields.filter((field) => field.type === "datetime") ?? [];
  const numericFields = preview?.fields.filter((field) => field.type === "number") ?? [];
  const duplicateMetricMapping = hasDuplicateMetricFields(mapping);

  function resetAssessment() {
    setEvidence(undefined);
    setError("");
  }

  function selectDataset(nextId: string) {
    requestSequence.current += 1;
    setDatasetId(nextId);
    setPreview(undefined);
    setMapping(cloneEmptyMapping());
    setWindow({ startInclusive: "", endInclusive: "" });
    resetAssessment();
  }

  async function refreshPreview() {
    if (!datasetId) return;
    const sequence = ++requestSequence.current;
    setLoading(true);
    resetAssessment();
    try {
      const next = await loadPreview(datasetId);
      if (sequence !== requestSequence.current) return;
      setPreview(next);
      const suggestedMapping = suggestPlantLiteCalibrationMapping(next.fields);
      setMapping(suggestedMapping);
      setWindow(suggestedMapping.timestampField
        ? plantLiteCalibrationWindowBounds(next, suggestedMapping.timestampField) ?? { startInclusive: "", endInclusive: "" }
        : { startInclusive: "", endInclusive: "" });
    } catch (reason) {
      if (sequence === requestSequence.current) setError(reason instanceof Error ? reason.message : "无法读取数据集样本");
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }

  function changeTimestampField(field: string) {
    const nextMapping = { ...mapping, timestampField: field };
    setMapping(nextMapping);
    const bounds = preview && field ? plantLiteCalibrationWindowBounds(preview, field) : undefined;
    setWindow(bounds ?? { startInclusive: "", endInclusive: "" });
    resetAssessment();
  }

  function changeMetric(key: PlantLiteCalibrationMetricKey, next: PlantLiteCalibrationMetricMapping) {
    setMapping((current) => ({ ...current, [key]: next }));
    resetAssessment();
  }

  function assess() {
    if (!dataset || !preview) return;
    setEvidence(buildPlantLiteCalibrationEvidence({ study, dataset, preview, mapping, window, minimumSamples }));
  }

  return <details className={`plant-real-calibration ${evidence ? `is-${evidence.status}` : ""}`}>
    <summary>
      <span><Database size={14} /><strong>现场数据校准</strong><small>用数据中心样本校核，不自动调参</small></span>
      <em>{evidence ? <>{statusIcon(evidence.status)}{statusLabel(evidence.status)}</> : "未校核"}</em>
    </summary>
    <div className="plant-real-calibration-body">
      <p className="plant-real-calibration-boundary">选择一段实测统计窗口，逐项验证吞吐、平均 WIP 和交付周期。校核结果不会修改当前模型。</p>
      <div className="plant-real-calibration-source">
        <label><span>数据集</span><select value={datasetId} onChange={(event) => selectDataset(event.target.value)}>
          <option value="">请选择数据集</option>
          {datasets.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.fields.length} 个字段</option>)}
        </select></label>
        <button type="button" disabled={!datasetId || loading} onClick={() => void refreshPreview()}>
          {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}{preview ? "刷新样本" : "读取样本"}
        </button>
      </div>
      {!datasets.length ? <p className="plant-real-calibration-notice">数据中心暂无数据集，请先连接现场数据并定义字段。</p> : null}
      {error ? <p role="alert" className="plant-real-calibration-notice is-error">{error}</p> : null}
      {preview && dataset ? <>
        <div className="plant-real-calibration-snapshot">
          <span><b>{preview.rows.length}</b> 条预览样本</span>
          <span>定义版本 <code title={dataset.updatedAt}>{formatVersion(dataset.updatedAt)}</code></span>
          <span>读取耗时 {Math.round(preview.durationMs)} ms</span>
        </div>
        <div className="plant-real-calibration-window">
          <label><span>时间字段</span><select value={mapping.timestampField} onChange={(event) => changeTimestampField(event.target.value)}>
            <option value="">请选择</option>{timestampFields.map((field) => <option key={field.key} value={field.key}>{fieldOptionLabel(field)}</option>)}
          </select></label>
          <label><span>窗口开始</span><input type="datetime-local" step="1" value={toLocalInput(window.startInclusive)} onChange={(event) => { setWindow((current) => ({ ...current, startInclusive: fromLocalInput(event.target.value) })); resetAssessment(); }} /></label>
          <label><span>窗口结束</span><input type="datetime-local" step="1" value={toLocalInput(window.endInclusive)} onChange={(event) => { setWindow((current) => ({ ...current, endInclusive: fromLocalInput(event.target.value) })); resetAssessment(); }} /></label>
          <label><span>最低样本数</span><input type="number" min={2} max={10_000} step={1} value={minimumSamples} onChange={(event) => { setMinimumSamples(Number(event.target.value)); resetAssessment(); }} /></label>
        </div>
        {!timestampFields.length || numericFields.length < 3 ? <p className="plant-real-calibration-notice">
          当前数据集缺少校准所需的{!timestampFields.length ? "日期时间字段" : ""}{!timestampFields.length && numericFields.length < 3 ? "和" : ""}{numericFields.length < 3 ? "至少 3 个数值字段" : ""}。请先在数据中心把原始明细汇总为“时间、吞吐、平均 WIP、交付周期”后再校核。
        </p> : null}
        <div className="plant-real-calibration-mappings" role="table" aria-label="现场字段、单位与容差映射">
          <div className="is-heading" role="row"><span>指标</span><span>现场字段</span><span>原始单位</span><span>容差</span></div>
          <MetricMappingRow label="吞吐" metricKey="throughputPerHour" value={mapping.throughputPerHour} fields={numericFields} units={["item-per-hour", "item-per-minute", "item-per-second"]} onChange={changeMetric} />
          <MetricMappingRow label="平均 WIP" metricKey="averageWip" value={mapping.averageWip} fields={numericFields} units={["item"]} onChange={changeMetric} />
          <MetricMappingRow label="交付周期" metricKey="averageLeadTimeMinutes" value={mapping.averageLeadTimeMinutes} fields={numericFields} units={["minute", "second", "hour"]} onChange={changeMetric} />
        </div>
        {duplicateMetricMapping ? <p className="plant-real-calibration-notice is-error">三个指标必须映射到不同的数值字段，避免重复使用同一列产生伪校准。</p> : null}
        <div className="plant-real-calibration-actions">
          <small>已按字段语义预选可识别项；容差比较仿真均值与实测均值，区间仅交叠时标记“有条件”。</small>
          <button type="button" disabled={!mappingComplete(mapping, window)} onClick={assess}><BadgeCheck size={13} />生成校准证据</button>
        </div>
      </> : null}
      {evidence ? <PlantLiteCalibrationResult evidence={evidence} /> : null}
    </div>
  </details>;
}

function MetricMappingRow({ label, metricKey, value, fields, units, onChange }: {
  label: string;
  metricKey: PlantLiteCalibrationMetricKey;
  value: PlantLiteCalibrationMetricMapping;
  fields: DataDatasetPreview["fields"];
  units: PlantLiteCalibrationUnit[];
  onChange: (key: PlantLiteCalibrationMetricKey, next: PlantLiteCalibrationMetricMapping) => void;
}) {
  return <div role="row">
    <strong role="cell">{label}</strong>
    <select aria-label={`${label}现场字段`} value={value.field} onChange={(event) => onChange(metricKey, { ...value, field: event.target.value })}><option value="">请选择</option>{fields.map((field) => <option key={field.key} value={field.key}>{fieldOptionLabel(field)}</option>)}</select>
    <select aria-label={`${label}原始单位`} value={value.unit} onChange={(event) => onChange(metricKey, { ...value, unit: event.target.value as PlantLiteCalibrationUnit })}>{units.map((unit) => <option key={unit} value={unit}>{unitLabel(unit)}</option>)}</select>
    <label className="plant-calibration-tolerance"><input aria-label={`${label}容差`} type="number" min={.1} max={100} step={.1} value={value.tolerancePercent} onChange={(event) => onChange(metricKey, { ...value, tolerancePercent: Number(event.target.value) })} /><span>%</span></label>
  </div>;
}

export function PlantLiteCalibrationResult({ evidence }: { evidence: PlantLiteCalibrationEvidence }) {
  return <section className="plant-real-calibration-result" aria-label="现场数据校准证据">
    <header><span>{statusIcon(evidence.status)}<strong>{statusLabel(evidence.status)}</strong></span><small>{evidence.source.windowRowCount} 条窗口记录 · 指纹 <code title={evidence.source.snapshotFingerprint}>{evidence.source.snapshotFingerprint.slice(-8)}</code></small></header>
    <div role="table">
      {evidence.metrics.map((metric) => <div role="row" key={metric.key} className={`is-${metric.status}`}>
        <span role="cell">{metricLabel(metric.key)}</span>
        <strong role="cell">实测 {formatNumber(metric.measuredMean)} {unitLabel(metric.canonicalUnit)}</strong>
        <small role="cell">仿真 {formatNumber(metric.simulatedMean)} · 误差 {formatPercent(metric.relativeErrorPercent)} / {metric.tolerancePercent}% · n={metric.sampleCount}{metric.rejectedSampleCount ? ` · 剔除 ${metric.rejectedSampleCount}` : ""}</small>
        <em role="cell">{statusLabel(metric.status)}</em>
      </div>)}
    </div>
    {evidence.issues.length ? <p>{evidence.issues.join("；")}</p> : null}
    <details className="plant-real-calibration-trace">
      <summary>证据追溯</summary>
      <dl>
        <div><dt>数据集</dt><dd>{evidence.source.datasetName} · {evidence.source.datasetId}</dd></div>
        <div><dt>定义版本</dt><dd><code>{evidence.source.datasetUpdatedAt}</code></dd></div>
        <div><dt>实测窗口</dt><dd><code>{evidence.window.startInclusive} → {evidence.window.endInclusive}</code></dd></div>
        <div><dt>样本快照</dt><dd><code>{evidence.source.snapshotFingerprint}</code></dd></div>
        <div><dt>校准证据</dt><dd><code>{evidence.evidenceFingerprint}</code></dd></div>
      </dl>
    </details>
    <footer>{evidence.declaration}</footer>
  </section>;
}

function mappingComplete(mapping: PlantLiteCalibrationMapping, window: PlantLiteCalibrationWindow): boolean {
  return Boolean(mapping.timestampField && mapping.throughputPerHour.field && mapping.averageWip.field
    && mapping.averageLeadTimeMinutes.field && window.startInclusive && window.endInclusive
    && !hasDuplicateMetricFields(mapping));
}

function hasDuplicateMetricFields(mapping: PlantLiteCalibrationMapping): boolean {
  const fields = [mapping.throughputPerHour.field, mapping.averageWip.field, mapping.averageLeadTimeMinutes.field].filter(Boolean);
  return fields.length > 1 && new Set(fields).size !== fields.length;
}

export function suggestPlantLiteCalibrationMapping(fields: readonly DataDatasetField[]): PlantLiteCalibrationMapping {
  const next = cloneEmptyMapping();
  const timestampFields = fields.filter((field) => field.type === "datetime");
  const numericFields = fields.filter((field) => field.type === "number");
  next.timestampField = bestSemanticField(timestampFields, ["timestamp", "datetime", "recordedat", "eventtime", "time", "date", "时间", "日期", "时刻"])?.key
    ?? (timestampFields.length === 1 ? timestampFields[0]!.key : "");

  const used = new Set<string>();
  const metrics: Array<[PlantLiteCalibrationMetricKey, string[]]> = [
    ["throughputPerHour", ["throughput", "output", "completed", "completion", "production", "吞吐", "产量", "完工"]],
    ["averageWip", ["averagewip", "wip", "workinprocess", "在制品", "在制", "制品"]],
    ["averageLeadTimeMinutes", ["averageleadtime", "leadtime", "cycletime", "deliverytime", "交付周期", "生产周期", "周期"]],
  ];
  for (const [key, aliases] of metrics) {
    const match = bestSemanticField(numericFields.filter((field) => !used.has(field.key)), aliases);
    if (!match) continue;
    next[key].field = match.key;
    used.add(match.key);
  }
  return next;
}

function bestSemanticField(fields: readonly DataDatasetField[], aliases: readonly string[]): DataDatasetField | undefined {
  return fields
    .map((field) => ({ field, score: semanticFieldScore(field, aliases) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.field.key.localeCompare(right.field.key))[0]?.field;
}

function semanticFieldScore(field: DataDatasetField, aliases: readonly string[]): number {
  const key = normalizeFieldText(field.key);
  const label = normalizeFieldText(field.label);
  return aliases.reduce((score, alias) => {
    const normalized = normalizeFieldText(alias);
    if (key === normalized || label === normalized) return Math.max(score, 4);
    if (key.startsWith(normalized) || label.startsWith(normalized)) return Math.max(score, 3);
    if (key.includes(normalized) || label.includes(normalized)) return Math.max(score, 2);
    return score;
  }, 0);
}

function normalizeFieldText(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_\-./()（）]+/g, "");
}

function fieldOptionLabel(field: DataDatasetField): string {
  return `${field.label} · ${field.key}${field.unit ? ` · ${field.unit}` : ""}`;
}

function cloneEmptyMapping(): PlantLiteCalibrationMapping {
  return structuredClone(EMPTY_PLANT_LITE_CALIBRATION_MAPPING);
}

function statusIcon(status: PlantLiteCalibrationStatus) {
  if (status === "passed") return <BadgeCheck size={13} />;
  if (status === "conditional") return <AlertTriangle size={13} />;
  if (status === "failed") return <CircleX size={13} />;
  return <ShieldQuestion size={13} />;
}

function statusLabel(status: PlantLiteCalibrationStatus): string {
  return ({ passed: "通过", conditional: "有条件", failed: "失败", "insufficient-data": "数据不足" })[status];
}

function metricLabel(key: PlantLiteCalibrationMetricKey): string {
  return ({ throughputPerHour: "吞吐", averageWip: "平均 WIP", averageLeadTimeMinutes: "交付周期" })[key];
}

function unitLabel(unit: PlantLiteCalibrationUnit | "item-per-hour" | "item" | "minute"): string {
  return ({ "item-per-hour": "件/时", "item-per-minute": "件/分", "item-per-second": "件/秒", item: "件", minute: "分钟", second: "秒", hour: "小时" })[unit];
}

function formatNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatPercent(value: number | undefined): string {
  if (value === undefined) return "—";
  if (!Number.isFinite(value)) return "∞";
  return `${value.toFixed(1)}%`;
}

function formatVersion(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function toLocalInput(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

function fromLocalInput(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
