import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BatteryMedium,
  ChevronDown,
  Cpu,
  Database,
  FileSpreadsheet,
  LoaderCircle,
  Pause,
  Play,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import {
  assessBatteryDataContract,
  batteryBindingFeatures,
  batteryContractFailureMessage,
  type AiDataBinding,
  type BatteryModelCatalogEntry,
  type DataDatasetRecord,
} from "@bim-studio/contracts";
import { api, type BatteryReleaseGateSnapshot } from "../api";
import { parseBatteryCsv, type ParsedBatteryCsv } from "./batteryCsv";
import {
  batteryTrendPoints,
  type BatteryAnalysisTask as BatteryTask,
  type BatteryTrendPoint,
} from "./batteryResultPresentation";
import { AiDataRunPolicyFields, type AiDataRunPolicyDraft } from "./AiDataRunPolicyFields";
import { AiDataRunHistory } from "./AiDataRunHistory";
import { BatteryDataContractStatus } from "./BatteryDataContractStatus";

type FormalModel = "socformer" | "bmsformer" | "batterymformer";
type Chemistry = "lfp" | "ncm";

const TASKS: Array<{ id: BatteryTask; label: string; detail: string; model: FormalModel }> = [
  { id: "soc", label: "计算 SOC", detail: "连续工况下的荷电状态校正", model: "socformer" },
  { id: "soh", label: "评估 SOH", detail: "当前健康度与可用容量", model: "bmsformer" },
  { id: "rul", label: "预测 RUL", detail: "退化轨迹与寿命阈值", model: "batterymformer" },
];

const BATTERY_POLICY: Record<BatteryTask, AiDataRunPolicyDraft> = {
  soc: { mode: "interval", intervalSeconds: 10, windowRows: 120, minimumSamples: 20, maxAgeSeconds: 30, maximumMissingRate: 0.1, entityField: "", timeField: "" },
  soh: { mode: "interval", intervalSeconds: 3_600, windowRows: 100, minimumSamples: 30, maxAgeSeconds: 7_200, maximumMissingRate: 0.1, entityField: "", timeField: "" },
  rul: { mode: "interval", intervalSeconds: 86_400, windowRows: 100, minimumSamples: 30, maxAgeSeconds: 172_800, maximumMissingRate: 0.1, entityField: "", timeField: "" },
};

export function BatteryIntelligencePanel({ projectId }: { projectId: string }) {
  const [task, setTask] = useState<BatteryTask>("soh");
  const [chemistry, setChemistry] = useState<Chemistry>("lfp");
  const [nominalCapacity, setNominalCapacity] = useState("");
  const [targetRetention, setTargetRetention] = useState("80");
  const [source, setSource] = useState<{ file: File; parsed: ParsedBatteryCsv }>();
  const [sourceMode, setSourceMode] = useState<"dataset" | "file">("dataset");
  const [datasets, setDatasets] = useState<DataDatasetRecord[]>([]);
  const [bindings, setBindings] = useState<AiDataBinding[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [runPolicy, setRunPolicy] = useState(BATTERY_POLICY.soh);
  const [catalog, setCatalog] = useState<BatteryModelCatalogEntry[]>([]);
  const [release, setRelease] = useState<BatteryReleaseGateSnapshot>();
  const [result, setResult] = useState<Record<string, unknown>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const selectedTask = TASKS.find((item) => item.id === task)!;
  const selectedModel = catalog.find((item) => item.family === selectedTask.model && item.role === "primary-model");
  const selectedDataset = datasets.find((item) => item.id === datasetId);
  const nominalCapacityProvided = Number.isFinite(Number(nominalCapacity)) && Number(nominalCapacity) > 0;
  const datasetAssessments = useMemo(() => new Map(datasets.map((dataset) => [
    dataset.id,
    assessBatteryDataContract(selectedTask.model, datasetFields(dataset), { nominalCapacityProvided }),
  ])), [datasets, nominalCapacityProvided, selectedTask.model]);
  const dataContract = useMemo(() => {
    if (sourceMode === "dataset") return datasetId ? datasetAssessments.get(datasetId) : undefined;
    return source
      ? assessBatteryDataContract(selectedTask.model, source.parsed.headers.map((key) => ({ key })), { nominalCapacityProvided })
      : undefined;
  }, [datasetAssessments, datasetId, nominalCapacityProvided, selectedTask.model, source, sourceMode]);
  const activeBinding = bindings.find((item) =>
    item.capabilityId === "battery.model.predict"
    && item.datasetId === datasetId
    && item.parameters?.model === selectedTask.model,
  );

  useEffect(() => {
    void Promise.all([api.listBatteryModelCatalog(), api.getBatteryReleaseGate(), api.listDatasets(projectId), api.listAiDataBindings(projectId)])
      .then(([catalogResult, releaseResult, datasetResult, bindingResult]) => {
        setCatalog(catalogResult.models);
        setRelease(releaseResult);
        setDatasets(datasetResult);
        const recommended = datasetResult.find((dataset) => assessBatteryDataContract("bmsformer", datasetFields(dataset)).compatible);
        setDatasetId((current) => current || recommended?.id || datasetResult[0]?.id || "");
        setBindings(bindingResult);
      })
      .catch(showError);
    return () => activeRequest.current?.abort();
  }, [projectId]);

  useEffect(() => {
    const binding = bindings.find((item) =>
      item.capabilityId === "battery.model.predict"
      && item.datasetId === datasetId
      && item.parameters?.model === selectedTask.model,
    );
    if (!binding) {
      setRunPolicy(BATTERY_POLICY[task]);
      return;
    }
    setRunPolicy({
      mode: binding.trigger.type === "interval" ? "interval" : "manual",
      intervalSeconds: binding.trigger.type === "interval" ? binding.trigger.seconds : BATTERY_POLICY[task].intervalSeconds,
      windowRows: binding.window.rows ?? BATTERY_POLICY[task].windowRows,
      minimumSamples: binding.quality.minimumSamples,
      maxAgeSeconds: binding.quality.maxAgeSeconds,
      maximumMissingRate: binding.quality.maximumMissingRate,
      entityField: binding.entity?.keyField ?? "",
      timeField: binding.time?.field ?? "",
    });
  }, [bindings, datasetId, selectedTask.model, task]);

  async function selectFile(file: File | undefined) {
    if (!file) return;
    const pendingRequest = activeRequest.current;
    activeRequest.current = undefined;
    pendingRequest?.abort();
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      setSource({ file, parsed: await parseBatteryCsv(file) });
    } catch (reason) {
      showError(reason);
      setSource(undefined);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function runPrediction() {
    if (sourceMode === "dataset" && !datasetId) {
      setError("请先在数据中心建立并选择电池数据集");
      return;
    }
    if (sourceMode === "file" && !source) {
      setError("请先上传单电芯或单工况 CSV");
      return;
    }
    if (!dataContract?.compatible) {
      setError(dataContract ? batteryContractFailureMessage(dataContract) : "请先选择可用的电池数据");
      return;
    }
    setBusy(true);
    setError("");
    setResult(undefined);
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const capacity = optionalPositiveNumber(nominalCapacity, "额定容量");
      const retention = task === "rul" ? requiredRange(targetRetention, "寿命阈值", 50, 100) : undefined;
      const common = {
        model: selectedTask.model,
        chemistry,
        ...(selectedTask.model === "batterymformer" ? { routingMode: "dynamic" as const } : {}),
        ...(capacity !== undefined ? { nominalCapacityAh: capacity } : {}),
        ...(retention !== undefined ? { targetCapacityRetention: retention } : {}),
      };
      let bindingId: string | undefined;
      if (sourceMode === "dataset") {
        const dataset = selectedDataset;
        if (!dataset) throw new Error("选择的电池数据集已删除");
        const existing = bindings.find((item) =>
          item.capabilityId === "battery.model.predict"
          && item.datasetId === dataset.id
          && item.parameters?.model === selectedTask.model,
        );
        const binding = await api.saveAiDataBinding(projectId, {
          ...(existing ? { id: existing.id } : {}),
          name: `${selectedTask.label} · ${dataset.name}`,
          datasetId: dataset.id,
          capabilityId: "battery.model.predict",
          status: "active",
          parameters: common,
          ...(runPolicy.entityField ? { entity: { keyField: runPolicy.entityField } } : {}),
          ...(runPolicy.timeField ? { time: { field: runPolicy.timeField, order: "asc" } } : {}),
          features: batteryBindingFeatures(dataContract),
          window: { rows: runPolicy.windowRows },
          trigger: runPolicy.mode === "interval" ? { type: "interval", seconds: runPolicy.intervalSeconds } : { type: "manual" },
          quality: { minimumSamples: runPolicy.minimumSamples, maxAgeSeconds: runPolicy.maxAgeSeconds, maximumMissingRate: runPolicy.maximumMissingRate },
          retry: { maxAttempts: 3, backoffSeconds: 5 },
          output: { type: "record" },
        });
        bindingId = binding.id;
        setBindings(await api.listAiDataBindings(projectId));
      }
      const response = sourceMode === "dataset"
        ? await api.predictBatteryFromDataset<Record<string, unknown>>(projectId, { ...common, datasetId, ...(bindingId ? { bindingId } : {}) }, controller.signal)
        : await api.predictBatteryFromFile<Record<string, unknown>>(projectId, { ...common, file: source!.file }, controller.signal);
      if (!response.output) throw new Error(response.error?.message ?? "模型没有返回结构化结果");
      setResult(response.output);
    } catch (reason) {
      if (!isAbortError(reason)) showError(reason);
    } finally {
      // 旧请求被新请求替换时，不得清空新请求的 busy 状态。
      if (activeRequest.current === controller) {
        activeRequest.current = undefined;
        setBusy(false);
      }
    }
  }

  async function setBindingStatus(status: AiDataBinding["status"]) {
    if (!activeBinding) return;
    setBusy(true);
    setError("");
    try {
      await api.saveAiDataBinding(projectId, { id: activeBinding.id, status });
      setBindings(await api.listAiDataBindings(projectId));
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function removeBinding() {
    if (!activeBinding || !window.confirm(`删除周期任务“${activeBinding.name}”？历史运行证据会保留。`)) return;
    setBusy(true);
    setError("");
    try {
      await api.deleteAiDataBinding(projectId, activeBinding.id);
      setBindings(await api.listAiDataBindings(projectId));
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  function showError(reason: unknown) {
    setError(reason instanceof Error ? reason.message : String(reason));
  }

  return (
    <div className="battery-workspace">
      <section className="operations-panel battery-run-panel">
        <header>
          <div>
            <strong>电池健康与寿命</strong>
            <small>直接绑定数据中心的接口、数据库或消息流，也可临时上传文件；不会用演示数据补齐缺失字段。</small>
          </div>
          <span className={`battery-gate ${release?.ready ? "ready" : "limited"}`}>
            {release?.ready ? <ShieldCheck size={14} /> : <AlertTriangle size={14} />}
            {release === undefined ? "读取模型目录" : release.ready ? "模型目录已验证" : "模型受控运行"}
          </span>
        </header>

        <div className="battery-task-picker" aria-label="分析目标">
          {TASKS.map((item) => (
            <button
              key={item.id}
              className={task === item.id ? "active" : ""}
              onClick={() => {
                const pendingRequest = activeRequest.current;
                activeRequest.current = undefined;
                pendingRequest?.abort();
                setBusy(false);
                setTask(item.id);
                setResult(undefined);
                setError("");
              }}
            >
              <span>{item.label}</span>
              <small>{item.detail}</small>
            </button>
          ))}
        </div>

        <div className="battery-source-tabs" role="tablist" aria-label="数据来源">
          <button className={sourceMode === "dataset" ? "active" : ""} onClick={() => setSourceMode("dataset")}>
            <Database size={15} />生产数据源
          </button>
          <button className={sourceMode === "file" ? "active" : ""} onClick={() => setSourceMode("file")}>
            <Upload size={15} />临时文件
          </button>
        </div>
        {sourceMode === "dataset" ? (
          <>
            <label className="battery-dataset-picker">
              <span>电池数据集</span>
              <select value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
                <option value="">{datasets.length ? "请选择数据集" : "数据中心暂无数据集"}</option>
                {datasets.map((dataset) => {
                  const assessment = datasetAssessments.get(dataset.id);
                  return (
                    <option key={dataset.id} value={dataset.id}>
                      {dataset.name}{assessment?.compatible ? "" : ` · 缺 ${assessment?.missing.length ?? 0} 项`}
                    </option>
                  );
                })}
              </select>
              <small>数据库、HTTP API、Kafka、MQTT 与现场协议均通过同一个数据集合同读取。</small>
            </label>
            {dataContract && <BatteryDataContractStatus assessment={dataContract} />}
            {activeBinding && <div className={`battery-binding-control ${dataContract?.compatible ? "" : "is-warning"}`}>
              <div>
                <span>{activeBinding.status === "active" ? "周期任务运行中" : activeBinding.status === "paused" ? "周期任务已暂停" : "已保存任务"}</span>
                <strong>{activeBinding.name}</strong>
                {!dataContract?.compatible ? <small>现有任务与当前字段合同不兼容；暂停或删除后，先在数据中心修正字段再重新运行。</small> : null}
              </div>
              <div>
                <button type="button" disabled={busy} onClick={() => void setBindingStatus(activeBinding.status === "active" ? "paused" : "active")}>
                  {activeBinding.status === "active" ? <Pause size={13} /> : <Play size={13} />}{activeBinding.status === "active" ? "暂停" : "恢复"}
                </button>
                <button type="button" className="is-danger" disabled={busy} onClick={() => void removeBinding()}><Trash2 size={13} />删除任务</button>
              </div>
            </div>}
            {datasetId && (
              <>
                <AiDataRunPolicyFields
                  value={runPolicy}
                  fields={datasets.find((item) => item.id === datasetId)?.fields ?? []}
                  onChange={setRunPolicy}
                />
                <AiDataRunHistory projectId={projectId} {...(activeBinding ? { bindingId: activeBinding.id } : {})} />
              </>
            )}
          </>
        ) : (
          <button className={`battery-dropzone ${source ? "loaded" : ""}`} onClick={() => fileInput.current?.click()}>
            {source ? <FileSpreadsheet size={25} /> : <Upload size={25} />}
            <span>{source ? source.file.name : "上传电池采样 CSV"}</span>
            <small>
              {source
                ? `${source.parsed.rowCount.toLocaleString()} 行 · ${source.parsed.headers.length} 个字段 · 点击更换`
                : "支持 CSV / TSV，按单电芯或单工况上传，最大 15 MiB"}
            </small>
          </button>
        )}
        <input
          ref={fileInput}
          hidden
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
          onChange={(event) => void selectFile(event.target.files?.[0])}
        />
        {sourceMode === "file" && source && (
          <>
            <p className="battery-field-preview">已识别：{source.parsed.headers.slice(0, 8).join(" · ")}{source.parsed.headers.length > 8 ? " …" : ""}</p>
            {dataContract && <BatteryDataContractStatus assessment={dataContract} />}
          </>
        )}

        <div className="operations-form-grid battery-options">
          <label>
            <span>化学体系</span>
            <select value={chemistry} onChange={(event) => setChemistry(event.target.value as Chemistry)}>
              <option value="lfp">LFP · 磷酸铁锂</option>
              <option value="ncm">NCM · 三元锂</option>
            </select>
          </label>
          <label>
            <span>额定容量 Ah{task === "soc" ? "（必填）" : "（可选）"}</span>
            <input inputMode="decimal" value={nominalCapacity} placeholder="优先读取文件字段" onChange={(event) => setNominalCapacity(event.target.value)} />
          </label>
          {task === "rul" && (
            <label>
              <span>寿命终点 SOH</span>
              <div className="battery-suffix-input"><input inputMode="decimal" value={targetRetention} onChange={(event) => setTargetRetention(event.target.value)} /><b>%</b></div>
            </label>
          )}
        </div>

        {error && <p className="operations-notice"><AlertTriangle size={14} />{error}</p>}
        <div className="battery-run-action">
          <div>
            <span>{selectedTask.model === "batterymformer" ? "标准专家 → PINN 动态路由" : "自动路由"}</span>
            <strong>{selectedModel?.label ?? selectedTask.model}</strong>
          </div>
          <button
            className="button primary"
            disabled={busy || !dataContract?.compatible}
            title={!dataContract?.compatible && dataContract ? batteryContractFailureMessage(dataContract) : undefined}
            onClick={() => void runPrediction()}
          >
            {busy ? <LoaderCircle className="spin" size={15} /> : <Activity size={15} />}
            {busy ? "正在分析" : selectedTask.label}
          </button>
        </div>
        {result && <BatteryPredictionResult task={task} result={result} />}
      </section>

      <BatteryEvidencePanel catalog={catalog} release={release} selectedModel={selectedModel} />
    </div>
  );
}

function datasetFields(dataset: DataDatasetRecord) {
  return [...dataset.fields, ...(dataset.computedFields ?? [])];
}

function BatteryPredictionResult({ task, result }: { task: BatteryTask; result: Record<string, unknown> }) {
  const metrics = resultMetrics(task, result);
  const trend = batteryTrendPoints(task, result);
  const runtime = objectValue(result.runtimeExecution);
  const routing = objectValue(result.expertRouting);
  const sourceEvidence = objectValue(result.sourceEvidence);
  const warnings = stringArray(result.warnings);
  return (
    <article className={`battery-result confidence-${String(result.confidence ?? "unknown")}`}>
      <div className="battery-result-heading">
        <div><span>分析结论</span><strong>{confidenceLabel(result.confidence)}</strong></div>
        <div>
          {routing && <small><ShieldCheck size={13} />{expertRoutingLabel(routing)}</small>}
          {runtime && <small><Cpu size={13} />{runtimeLabel(runtime)}</small>}
        </div>
      </div>
      <div className="battery-metrics">
        {metrics.map((metric) => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong></div>)}
      </div>
      {sourceEvidence && (
        <p className="operations-source-proof">
          <Database size={14} />
          数据证据：{String(sourceEvidence.datasetName ?? sourceEvidence.datasetId ?? "数据集")} · {String(sourceEvidence.connectionType ?? "连接")} · {String(sourceEvidence.rowCount ?? 0)} 行
        </p>
      )}
      {trend.length > 1 && <BatteryTrend task={task} points={trend} />}
      {typeof result.summary === "string" && <p>{result.summary}</p>}
      {routing?.reviewRequired === true && <p className="operations-notice"><AlertTriangle size={14} />专家分歧超过保护阈值，当前结果需复核。</p>}
      {warnings.length > 0 && <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
    </article>
  );
}

function BatteryTrend({ task, points }: { task: BatteryTask; points: BatteryTrendPoint[] }) {
  const width = 520;
  const height = 110;
  const padding = 10;
  const xValues = points.map((point) => point.x);
  const yValues = points.map((point) => point.y);
  const xMin = Math.min(...xValues);
  const xRange = Math.max(Math.max(...xValues) - xMin, 1);
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  const yPadding = Math.max((yMax - yMin) * 0.12, 0.5);
  const yFloor = yMin - yPadding;
  const yRange = Math.max(yMax + yPadding - yFloor, 1);
  const path = points.map((point, index) => {
    const x = padding + (point.x - xMin) / xRange * (width - padding * 2);
    const y = height - padding - (point.y - yFloor) / yRange * (height - padding * 2);
    return `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  const label = task === "soc" ? "SOC 估计轨迹" : "SOH 退化预测轨迹";
  return (
    <figure className="battery-trend">
      <figcaption><span>{label}</span><small>{points.length.toLocaleString()} 个模型输出点</small></figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} preserveAspectRatio="none">
        {[0.25, 0.5, 0.75].map((ratio) => <line key={ratio} x1={padding} x2={width - padding} y1={height * ratio} y2={height * ratio} />)}
        <path d={path} />
      </svg>
      <div><span>{points[0]!.x.toFixed(0)}</span><b>{yMin.toFixed(1)}–{yMax.toFixed(1)}%</b><span>{points.at(-1)!.x.toFixed(0)}</span></div>
    </figure>
  );
}

function BatteryEvidencePanel({ catalog, release, selectedModel }: {
  catalog: BatteryModelCatalogEntry[];
  release: BatteryReleaseGateSnapshot | undefined;
  selectedModel: BatteryModelCatalogEntry | undefined;
}) {
  const routedExperts = catalog.filter((item) => ["routed-expert", "production-router"].includes(item.role));
  return (
    <aside className="operations-panel battery-evidence-panel">
      <header><div><strong>模型与证据</strong><small>默认收起技术细节，结论仍保留来源、适用域与回退记录。</small></div></header>
      {selectedModel ? (
        <div className="battery-primary-model">
          <span>当前正式模型</span>
          <strong>{selectedModel.label}</strong>
          <p>{selectedModel.evidence.summary}</p>
          <div><span>{selectedModel.modelVersion}</span><b>{selectedModel.evidence.gate.toUpperCase()}</b></div>
        </div>
      ) : <div className="operations-empty">正在读取模型目录…</div>}
      <details className="battery-details">
        <summary><span>运行时与发布门禁</span><ChevronDown size={14} /></summary>
        <div>
          <p>主模型：{release?.primaryModels.length ?? 0} 个 · 正式路由：{release?.routedModels.length ?? 0} 个 · 安全回退：{release?.fallbackModels.length ?? 0} 个</p>
          <p>ONNX：{release?.deployment.activeModels.length ? `${release.deployment.activeModels.length} 个正式运行` : "候选验证中，当前保持 Python 主链"}</p>
          {release?.blockers.map((blocker) => <small key={blocker}>{blocker}</small>)}
        </div>
      </details>
      <details className="battery-details">
        <summary><span>正式物理与路由专家</span><ChevronDown size={14} /></summary>
        <div className="battery-shadow-list">
          {routedExperts.map((model) => (
            <article key={model.id}><strong>{model.label}</strong><small>{model.evidence.summary}</small></article>
          ))}
          <p>PINN、PINO 与 TwinMoE 按原物理风险、动态稀疏路由和域外回退逻辑正式运行；单个专家不能绕过路由直接覆盖结果。</p>
        </div>
      </details>
      <div className="battery-evidence-foot"><BatteryMedium size={15} /><span>域外或极高风险时，由确定性 SPM 守恒求解接管。</span></div>
    </aside>
  );
}

function resultMetrics(task: BatteryTask, result: Record<string, unknown>): Array<{ label: string; value: string }> {
  if (task === "soc") {
    return [
      metric("当前 SOC", result.finalSoc, "%"),
      metric("最低 SOC", result.minSoc, "%"),
      metric("最高 SOC", result.maxSoc, "%"),
    ].filter(hasMetric);
  }
  if (task === "soh") {
    return [
      metric("当前 SOH", result.currentSoh, "%"),
      metric("估计容量", result.predictedCapacityAh, " Ah"),
    ].filter(hasMetric);
  }
  const observation = objectValue(result.rulObservation);
  return [
    metric("预计寿命", result.predictedCycleLife, " 圈", 0),
    metric("已观测下限", observation?.lifetimeLowerBoundCycles, " 圈", 0),
  ].filter(hasMetric);
}

function metric(label: string, value: unknown, suffix: string, digits = 2) {
  return {
    label,
    value: typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : "",
  };
}
function hasMetric(item: { value: string }) {
  return Boolean(item.value);
}
function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function confidenceLabel(value: unknown) {
  if (value === "high") return "高置信";
  if (value === "medium") return "中等置信";
  if (value === "low") return "低置信";
  return "已完成";
}
function runtimeLabel(runtime: Record<string, unknown>) {
  if (runtime.actual === "onnx") return "ONNX 本地推理";
  if (runtime.fellBack) return "已安全回退 Python";
  return "Python 正式运行时";
}

function expertRoutingLabel(routing: Record<string, unknown>) {
  const expert = routing.selectedExpert === "pinn" ? "PINN 物理专家" : "标准寿命专家";
  return `正式路由 · ${expert}`;
}

function optionalPositiveNumber(value: string, label: string): number | undefined {
  if (!value.trim()) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}必须是正数`);
  return number;
}
function requiredRange(value: string, label: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${label}必须在 ${minimum}–${maximum} 之间`);
  return number;
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
}
