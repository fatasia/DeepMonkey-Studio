import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BatteryMedium,
  ChevronDown,
  Cpu,
  Database,
  Download,
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
import { BatteryAnalysisReport } from "./BatteryAnalysisReport";
import { BatteryScenarioWorkbench } from "./BatteryScenarioWorkbench";
import {
  BATTERY_EXAMPLES,
  BATTERY_EXAMPLE_GROUPS,
  batteryExampleById,
  batteryExampleFile,
} from "../ai/batterySample";
import { batterySuggestionDraft, type OperationalSuggestionDraft } from "../ai/operationalSuggestionDraft";
import { AiOperationalDraftReview } from "./AiOperationalDraftReview";

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
  const [nominalCapacity, setNominalCapacity] = useState("100");
  const [targetRetention, setTargetRetention] = useState("80");
  const [source, setSource] = useState<{ file: File; parsed: ParsedBatteryCsv }>();
  const [sourceMode, setSourceMode] = useState<"example" | "dataset" | "file">("example");
  const [exampleId, setExampleId] = useState("lfp-engineering");
  const [datasets, setDatasets] = useState<DataDatasetRecord[]>([]);
  const [bindings, setBindings] = useState<AiDataBinding[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [runPolicy, setRunPolicy] = useState(BATTERY_POLICY.soh);
  const [catalog, setCatalog] = useState<BatteryModelCatalogEntry[]>([]);
  const [release, setRelease] = useState<BatteryReleaseGateSnapshot>();
  const [result, setResult] = useState<Record<string, unknown>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sampleRun, setSampleRun] = useState<string>();
  const [evidence, setEvidence] = useState<{ draft: OperationalSuggestionDraft; payload: unknown }>();
  const fileInput = useRef<HTMLInputElement>(null);
  const fileRead = useRef(0);
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const selectedTask = TASKS.find((item) => item.id === task)!;
  const selectedExample = batteryExampleById(exampleId);
  const selectedModel = catalog.find((item) => item.family === selectedTask.model && item.role === "primary-model");
  const selectedDataset = datasets.find((item) => item.id === datasetId);
  const nominalCapacityProvided = Number.isFinite(Number(nominalCapacity)) && Number(nominalCapacity) > 0;
  const datasetAssessments = useMemo(() => new Map(datasets.map((dataset) => [
    dataset.id,
    assessBatteryDataContract(selectedTask.model, datasetFields(dataset), { nominalCapacityProvided }),
  ])), [datasets, nominalCapacityProvided, selectedTask.model]);
  const dataContract = useMemo(() => {
    if (sourceMode === "dataset") return datasetId ? datasetAssessments.get(datasetId) : undefined;
    if (sourceMode === "example") {
      return assessBatteryDataContract(selectedTask.model, selectedExample.headers.map((key) => ({ key })), {
        nominalCapacityProvided: true,
      });
    }
    return source
      ? assessBatteryDataContract(selectedTask.model, source.parsed.headers.map((key) => ({ key })), { nominalCapacityProvided })
      : undefined;
  }, [datasetAssessments, datasetId, nominalCapacityProvided, selectedExample, selectedTask.model, source, sourceMode]);
  const activeBinding = bindings.find((item) =>
    item.capabilityId === "battery.model.predict"
    && item.datasetId === datasetId
    && item.parameters?.model === selectedTask.model,
  );

  useEffect(() => {
    let cancelled = false;
    setDatasets([]); setBindings([]); setDatasetId(""); setSource(undefined); setResult(undefined); setEvidence(undefined);
    void Promise.all([api.listBatteryModelCatalog(), api.getBatteryReleaseGate(), api.listDatasets(projectId), api.listAiDataBindings(projectId)])
      .then(([catalogResult, releaseResult, datasetResult, bindingResult]) => {
        if (cancelled) return;
        setCatalog(catalogResult.models);
        setRelease(releaseResult);
        setDatasets(datasetResult);
        const recommended = datasetResult.find((dataset) => assessBatteryDataContract("bmsformer", datasetFields(dataset)).compatible);
        setDatasetId((current) => current || recommended?.id || datasetResult[0]?.id || "");
        setBindings(bindingResult);
      })
      .catch(reason => { if (!cancelled) showError(reason); });
    return () => { cancelled = true; fileRead.current += 1; activeRequest.current?.abort(); activeRequest.current = undefined; };
  }, [projectId]);

  useEffect(() => {
    activeRequest.current?.abort(); activeRequest.current = undefined;
    setBusy(false); setResult(undefined); setEvidence(undefined); setError(""); setSampleRun(undefined);
  }, [projectId, task, sourceMode, source, datasetId, exampleId, chemistry, nominalCapacity, targetRetention]);

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
    const current = ++fileRead.current;
    const pendingRequest = activeRequest.current;
    activeRequest.current = undefined;
    pendingRequest?.abort();
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      const parsed = await parseBatteryCsv(file);
      if (fileRead.current === current) setSource({ file, parsed });
    } catch (reason) {
      if (fileRead.current === current) { showError(reason); setSource(undefined); }
    } finally {
      if (fileRead.current === current) setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function runPrediction() {
    if (activeRequest.current) return;
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
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      setSampleRun(sourceMode === "example" ? selectedExample.id : undefined);
      const capacity = sourceMode === "example"
        ? selectedExample.nominalCapacityAh
        : optionalPositiveNumber(nominalCapacity, "额定容量");
      const retention = task === "rul" ? requiredRange(targetRetention, "寿命阈值", 50, 100) : undefined;
      const common = {
        model: selectedTask.model,
        chemistry,
        ...(selectedTask.model === "batterymformer" ? {
          routingMode: release?.deployment.twinRuntime === "rust-ort" ? "dynamic" as const : "standard" as const,
        } : {}),
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
          features: batteryBindingFeatures(dataContract!),
          window: { rows: runPolicy.windowRows },
          trigger: runPolicy.mode === "interval" ? { type: "interval", seconds: runPolicy.intervalSeconds } : { type: "manual" },
          quality: { minimumSamples: runPolicy.minimumSamples, maxAgeSeconds: runPolicy.maxAgeSeconds, maximumMissingRate: runPolicy.maximumMissingRate },
          retry: { maxAttempts: 3, backoffSeconds: 5 },
          output: { type: "record" },
        });
        bindingId = binding.id;
        setBindings(await api.listAiDataBindings(projectId));
      }
      const response = sourceMode === "example"
        ? await api.predictBatteryFromFile<Record<string, unknown>>(projectId, {
          ...common,
          file: await batteryExampleFile(selectedExample, controller.signal),
        }, controller.signal)
        : sourceMode === "dataset"
        ? await api.predictBatteryFromDataset<Record<string, unknown>>(projectId, { ...common, datasetId, ...(bindingId ? { bindingId } : {}) }, controller.signal)
        : await api.predictBatteryFromFile<Record<string, unknown>>(projectId, { ...common, file: source!.file }, controller.signal);
      if (activeRequest.current !== controller || controller.signal.aborted) return;
      if (!response.output) throw new Error(response.error?.message ?? "模型没有返回结构化结果");
      setResult(response.output);
      const sourceLabel = sourceMode === "example"
        ? `内置样例 · ${selectedExample.name}`
        : sourceMode === "dataset"
          ? `项目数据集 · ${selectedDataset?.name ?? datasetId}`
          : `上传文件 · ${source?.file.name ?? "CSV"}`;
      const draft = batterySuggestionDraft({ projectId, task, result: response.output, source: sourceMode === "example" ? "local-sample" : sourceMode === "dataset" ? "project-data" : "uploaded-file", reference: response.requestId, sourceLabel });
      setEvidence({ draft, payload: { source: draft.source, sourceLabel, response } });
    } catch (reason) {
      if (activeRequest.current === controller && !isAbortError(reason)) showError(reason);
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

  function chooseTask(nextTask: BatteryTask) {
    const pendingRequest = activeRequest.current;
    activeRequest.current = undefined;
    pendingRequest?.abort();
    setBusy(false);
    setTask(nextTask);
    if (sourceMode === "example" && !selectedExample.tasks.includes(nextTask)) {
      const replacement = BATTERY_EXAMPLES.find((example) => example.tasks.includes(nextTask));
      if (replacement) applyExample(replacement.id, nextTask);
    }
    setResult(undefined);
    setError("");
  }

  function applyExample(nextExampleId: string, currentTask = task) {
    const example = batteryExampleById(nextExampleId);
    setExampleId(example.id);
    setChemistry(example.chemistry);
    setNominalCapacity(String(example.nominalCapacityAh));
    if (!example.tasks.includes(currentTask)) setTask(example.defaultTask);
  }

  function showError(reason: unknown) {
    const message = reason instanceof Error ? reason.message : String(reason);
    setError(/^(fetch failed|Failed to fetch)$/i.test(message)
      ? "无法连接电池预测服务。请在服务健康中检查预测服务地址与运行状态，然后重新运行。"
      : message);
  }

  return (
    <div className="battery-workspace">
      <BatteryTechnologyRail nativeRuntime={release?.deployment.twinRuntime === "rust-ort"} />
      <section className="operations-panel battery-run-panel">
        <header>
          <div>
            <strong>电池健康与寿命</strong>
            <small>选择内置工况直接运行，或接入数据中心与临时文件。</small>
          </div>
          <span className={`battery-gate ${release?.ready ? "ready" : "limited"}`}>
            {release?.ready ? <ShieldCheck size={14} /> : <AlertTriangle size={14} />}
            {release === undefined ? "读取模型目录" : release.deployment.mode === "local-validation" ? "本地验证推理" : release.ready ? "模型目录已验证" : "模型受控运行"}
          </span>
        </header>

        <div className="battery-task-heading"><span>分析目标</span></div>
        <div className="battery-task-picker" aria-label="分析目标">
          {TASKS.map((item) => (
            <button
              key={item.id}
              className={task === item.id ? "active" : ""}
              onClick={() => chooseTask(item.id)}
            >
              <span>{item.label}</span>
              <small>{item.detail}</small>
            </button>
          ))}
        </div>

        <div className="battery-source-tabs" role="tablist" aria-label="数据来源">
          <button className={sourceMode === "example" ? "active" : ""} onClick={() => { setSourceMode("example"); applyExample(exampleId); }}>
            <BatteryMedium size={15} />内置样例
          </button>
          <button className={sourceMode === "dataset" ? "active" : ""} onClick={() => setSourceMode("dataset")}>
            <Database size={15} />生产数据源
          </button>
          <button className={sourceMode === "file" ? "active" : ""} onClick={() => setSourceMode("file")}>
            <Upload size={15} />临时文件
          </button>
        </div>
        {sourceMode === "example" ? (
          <label className="battery-example-picker">
            <span>样例工况</span>
            <select value={selectedExample.id} onChange={(event) => applyExample(event.target.value)}>
              {BATTERY_EXAMPLE_GROUPS.map((group) => (
                <optgroup key={group.id} label={group.label}>
                  {BATTERY_EXAMPLES.filter((example) => example.group === group.id).map((example) => (
                    <option key={example.id} value={example.id}>{example.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <div>
              <strong>{selectedExample.detail}</strong>
              <small>{selectedExample.tasks.map((item) => TASKS.find((taskItem) => taskItem.id === item)!.label).join(" · ")}</small>
            </div>
          </label>
        ) : sourceMode === "dataset" ? (
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
            <span>{selectedTask.model === "batterymformer" && release?.deployment.twinRuntime === "rust-ort"
              ? "标准专家 → PINN 动态路由"
              : release?.deployment.mode === "local-validation" ? "项目内置模型" : "自动路由"}</span>
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
        {sampleRun && <p className="operations-notice">已使用内置样例：{batteryExampleById(sampleRun).name}</p>}
        {result && <BatteryPredictionResult task={task} result={result} />}
        {evidence && <div className="battery-follow-up">
          <button type="button" className="button" onClick={() => {
            const url = URL.createObjectURL(new Blob([JSON.stringify(evidence.payload, null, 2)], { type: "application/json" }));
            const link = document.createElement("a"); link.href = url; link.download = `battery-${task}-evidence.json`; link.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
          }}><Download size={13} />下载运行证据</button>
          <AiOperationalDraftReview draft={evidence.draft} />
        </div>}
      </section>

      <BatteryEvidencePanel
        catalog={catalog}
        release={release}
        selectedModel={selectedModel}
        projectId={projectId}
        bindingId={activeBinding?.id}
      />
      <BatteryScenarioWorkbench
        projectId={projectId}
        chemistry={chemistry}
        nominalCapacityAh={positiveOrUndefined(nominalCapacity)}
        nativeRuntime={release?.deployment.twinRuntime === "rust-ort"}
      />
    </div>
  );
}

function BatteryTechnologyRail({ nativeRuntime }: { nativeRuntime: boolean }) {
  return (
    <section className="battery-technology-rail" aria-label="电池多物理推理架构">
      <div className="battery-technology-heading">
        <div>
          <span>AI 电池分析 · 原生推理</span>
          <strong>SPM-PINO 多物理神经算子 <b>×</b> TwinMoE 风险路由</strong>
        </div>
        <span className={`battery-native-runtime ${nativeRuntime ? "is-ready" : ""}`}>
          <i aria-hidden="true" />Rust · ONNX Runtime{nativeRuntime ? " · 已连接" : ""}
        </span>
      </div>
      <div className="battery-route-map">
        <article>
          <span>01</span>
          <div><strong>工况序列</strong><small>I · T · Δt · Chemistry</small></div>
        </article>
        <i aria-hidden="true" />
        <article className="is-operator">
          <span>02</span>
          <div><strong>SPM-PINO</strong><small>电化学 · 热 · 退化场</small></div>
        </article>
        <i aria-hidden="true" />
        <article className="is-router">
          <span>03</span>
          <div><strong>TwinMoE</strong><small>域判断 · 物理残差 · 专家分歧</small></div>
        </article>
        <i aria-hidden="true" />
        <article>
          <span>04</span>
          <div><strong>主轨迹</strong><small>轻专家 / 谱算子 / SPM 回退</small></div>
        </article>
      </div>
      <div className="battery-twin-capabilities" aria-label="数字孪生在线能力">
        <span>在线状态同化</span>
        <span>10 分钟多物理推演</span>
        <span>迁移校准门禁</span>
        <span>CLF-CBF 影子投影</span>
      </div>
    </section>
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
      {resultSummary(task, result) && <p>{resultSummary(task, result)}</p>}
      <BatteryAnalysisReport result={result} />
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

function BatteryEvidencePanel({ catalog, release, selectedModel, projectId, bindingId }: {
  catalog: BatteryModelCatalogEntry[];
  release: BatteryReleaseGateSnapshot | undefined;
  selectedModel: BatteryModelCatalogEntry | undefined;
  projectId: string;
  bindingId: string | undefined;
}) {
  const routedExperts = catalog.filter((item) =>
    item.runtime === "onnx" && ["routed-expert", "production-router"].includes(item.role)
  );
  return (
    <aside className="operations-panel battery-evidence-panel">
      <header><div><strong>模型与证据</strong><small>默认收起技术细节，结论仍保留来源、适用域与回退记录。</small></div></header>
      {selectedModel ? (
        <div className="battery-primary-model">
          <span>{release?.deployment.mode === "local-validation" ? "项目内置模型" : "当前模型"}</span>
          <strong>{selectedModel.label}</strong>
          <p>{selectedModel.evidence.summary}</p>
          <div><span>{selectedModel.modelVersion}</span><b>{release?.deployment.mode === "local-validation" ? "验证用" : selectedModel.evidence.gate.toUpperCase()}</b></div>
        </div>
      ) : <div className="operations-empty">正在读取模型目录…</div>}
      <details className="battery-details">
        <summary><span>运行时与发布门禁</span><ChevronDown size={14} /></summary>
        <div>
          <p>主模型：{release?.primaryModels.length ?? 0} 个 · 正式路由：{release?.routedModels.length ?? 0} 个 · 安全回退：{release?.fallbackModels.length ?? 0} 个</p>
          <p>ONNX：{release?.deployment.activeModels.length ? `${release.deployment.activeModels.length} 个${release.deployment.mode === "local-validation" ? "本地验证模型" : "正式模型"}` : "未启用"}</p>
          {release?.blockers.map((blocker) => <small key={blocker}>{blocker}</small>)}
        </div>
      </details>
      {routedExperts.length > 0 && <details className="battery-details">
        <summary><span>正式物理与路由专家</span><ChevronDown size={14} /></summary>
        <div className="battery-shadow-list">
          {routedExperts.map((model) => (
            <article key={model.id}><strong>{model.label}</strong><small>{model.evidence.summary}</small></article>
          ))}
          <p>SPM-PINO 与 TwinMoE 按动态风险、域判断和 SPM 回退运行；单个专家不能绕过路由直接覆盖结果。</p>
        </div>
      </details>}
      {bindingId && <AiDataRunHistory projectId={projectId} bindingId={bindingId} />}
      {catalog.some(item => item.family === "spm-conservation" && item.runtimeEnabled) && <div className="battery-evidence-foot"><BatteryMedium size={15} /><span>域外或极高风险时，由确定性 SPM 守恒求解接管。</span></div>}
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
    const pack = objectValue(objectValue(result.dataProfile)?.packAssessment);
    if (pack) return [
      metric("Pack 平均 SOH", pack.meanSohPct, "%"),
      metric("最弱电芯 SOH", pack.weakestSohPct, "%"),
      metric("SOH 极差", pack.sohSpreadPct, "%"),
    ].filter(hasMetric);
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

function resultSummary(task: BatteryTask, result: Record<string, unknown>): string | undefined {
  const pack = objectValue(objectValue(result.dataProfile)?.packAssessment);
  if (task === "soh" && pack) {
    const cells = typeof pack.assessedCells === "number" ? pack.assessedCells.toFixed(0) : "多";
    const weakest = String(pack.weakestCellId ?? "最弱电芯");
    const spread = typeof pack.sohSpreadPct === "number" ? pack.sohSpreadPct.toFixed(1) : "—";
    return `已聚合 ${cells} 个电芯的末圈健康状态；${weakest} 为当前短板，SOH 极差 ${spread}%。`;
  }
  return typeof result.summary === "string" ? result.summary : undefined;
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
  if (runtime.fellBack) return "已切换兼容运行时";
  return "外置模型运行时";
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
function positiveOrUndefined(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function requiredRange(value: string, label: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${label}必须在 ${minimum}–${maximum} 之间`);
  return number;
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
}
