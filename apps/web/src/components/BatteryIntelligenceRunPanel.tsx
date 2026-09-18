import type { RefObject } from "react";
import {
  Activity,
  AlertTriangle,
  BatteryMedium,
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
import { batteryContractFailureMessage, type AiDataBinding, type BatteryDataContractAssessment, type BatteryModelCatalogEntry, type DataDatasetRecord } from "@bim-studio/contracts";
import type { BatteryReleaseGateSnapshot } from "../api";
import { BATTERY_EXAMPLES, BATTERY_EXAMPLE_GROUPS, batteryExampleById, type BatteryExample } from "../ai/batterySample";
import type { OperationalSuggestionDraft } from "../ai/operationalSuggestionDraft";
import { AiDataRunPolicyFields, type AiDataRunPolicyDraft } from "./AiDataRunPolicyFields";
import { AiOperationalDraftReview } from "./AiOperationalDraftReview";
import { BatteryDataContractStatus } from "./BatteryDataContractStatus";
import { BatteryCombinedResult, BatteryPredictionResult } from "./BatteryPredictionResults";
import {
  BATTERY_TASKS,
  COMBINED_BATTERY_MODELS,
  exampleSupportsBatteryTask,
  positiveOrUndefined,
  type BatteryChemistry,
  type BatterySourceMode,
  type BatteryTask,
  type DatasetContractAssessments,
} from "./batteryIntelligenceConfig";
import type { ParsedBatteryCsv } from "./batteryCsv";

interface BatteryIntelligenceRunPanelProps {
  projectId: string;
  task: BatteryTask;
  chemistry: BatteryChemistry;
  nominalCapacity: string;
  targetRetention: string;
  source: { file: File; parsed: ParsedBatteryCsv } | undefined;
  sourceMode: BatterySourceMode;
  selectedExample: BatteryExample;
  datasets: DataDatasetRecord[];
  datasetId: string;
  datasetAssessments: DatasetContractAssessments;
  contractAssessments: BatteryDataContractAssessment[] | undefined;
  dataContract: BatteryDataContractAssessment | undefined;
  activeBinding: AiDataBinding | undefined;
  runPolicy: AiDataRunPolicyDraft;
  selectedTask: (typeof BATTERY_TASKS)[number];
  selectedModel: BatteryModelCatalogEntry | undefined;
  release: BatteryReleaseGateSnapshot | undefined;
  result: Record<string, unknown> | undefined;
  busy: boolean;
  error: string;
  sampleRun: string | undefined;
  evidence: { draft: OperationalSuggestionDraft; payload: unknown } | undefined;
  fileInput: RefObject<HTMLInputElement | null>;
  onChooseTask: (task: BatteryTask) => void;
  onSourceModeChange: (mode: BatterySourceMode) => void;
  onExampleChange: (id: string) => void;
  onDatasetChange: (id: string) => void;
  onPolicyChange: (policy: AiDataRunPolicyDraft) => void;
  onFileChange: (file: File | undefined) => void;
  onChemistryChange: (chemistry: BatteryChemistry) => void;
  onNominalCapacityChange: (value: string) => void;
  onTargetRetentionChange: (value: string) => void;
  onBindingStatusChange: (status: AiDataBinding["status"]) => void;
  onRemoveBinding: () => void;
  onRun: () => void;
}

export function BatteryIntelligenceRunPanel(props: BatteryIntelligenceRunPanelProps) {
  const contractStatus = props.dataContract && (
    <>
      {props.task === "combined" && props.contractAssessments && (
        <p className="battery-contract-models">
          {COMBINED_BATTERY_MODELS.map((item, index) => {
            const assessment = props.contractAssessments?.[index];
            return <span key={item.model} className={assessment?.compatible ? "ok" : "bad"}>{item.label}{assessment?.compatible ? " 可运行" : ` 缺 ${assessment?.missing.length ?? 0} 项`}</span>;
          })}
        </p>
      )}
      <BatteryDataContractStatus assessment={props.dataContract} />
    </>
  );
  return (
    <section className="operations-panel battery-run-panel">
      <header>
        <div><strong>电池健康与寿命</strong><small>选择内置工况直接运行，或接入数据中心与临时文件。</small></div>
        <span className={`battery-gate ${props.release?.ready ? "ready" : "limited"}`}>
          {props.release?.ready ? <ShieldCheck size={14} /> : <AlertTriangle size={14} />}
          {props.release === undefined ? "读取模型目录" : props.release.deployment.mode === "local-validation" ? "本地验证推理" : props.release.ready ? "模型目录已验证" : "模型受控运行"}
        </span>
      </header>
      <div className="battery-task-heading"><span>分析目标</span></div>
      <div className="battery-task-picker" aria-label="分析目标">
        {BATTERY_TASKS.map((item) => (
          <button key={item.id} className={props.task === item.id ? "active" : ""} onClick={() => props.onChooseTask(item.id)}>
            <span>{item.label}</span><small title={item.detail}>{item.detail}</small>
          </button>
        ))}
      </div>
      <SourceControls {...props} contractStatus={contractStatus} />
      <div className="operations-form-grid battery-options">
        <label>
          <span>化学体系</span>
          <select value={props.chemistry} onChange={(event) => props.onChemistryChange(event.target.value as BatteryChemistry)}>
            <option value="lfp">LFP · 磷酸铁锂</option><option value="ncm">NCM · 三元锂</option>
          </select>
        </label>
        <label>
          <span>额定容量 Ah{props.task === "soc" || props.task === "combined" ? "（必填）" : "（可选）"}</span>
          <input inputMode="decimal" value={props.nominalCapacity} placeholder="优先读取文件字段" onChange={(event) => props.onNominalCapacityChange(event.target.value)} />
        </label>
        {(props.task === "rul" || props.task === "combined") && <label>
          <span>寿命终点 SOH</span>
          <div className="battery-suffix-input"><input inputMode="decimal" value={props.targetRetention} onChange={(event) => props.onTargetRetentionChange(event.target.value)} /><b>%</b></div>
        </label>}
      </div>
      {props.error && <p className="operations-notice"><AlertTriangle size={14} />{props.error}</p>}
      <div className="battery-run-action">
        <div>
          <span>{props.task === "combined" ? "三模型并行 · 独立置信" : props.selectedTask.model === "batterymformer" && props.release?.deployment.twinRuntime === "rust-ort" ? "标准专家 → PINN 动态路由" : props.release?.deployment.mode === "local-validation" ? "项目内置模型" : "自动路由"}</span>
          <strong>{props.task === "combined" ? "SOCFormer · BMSFormer · BatteryMFormer" : props.selectedModel?.label ?? props.selectedTask.model}</strong>
        </div>
        <button className="button primary" disabled={props.busy || !props.dataContract?.compatible} title={!props.dataContract?.compatible && props.dataContract ? batteryContractFailureMessage(props.dataContract) : undefined} onClick={props.onRun}>
          {props.busy ? <LoaderCircle className="spin" size={15} /> : <Activity size={15} />}{props.busy ? "正在分析" : props.selectedTask.label}
        </button>
      </div>
      {props.sampleRun && <p className="operations-notice">已使用内置样例：{batteryExampleById(props.sampleRun).name}</p>}
      {props.result && props.task !== "combined" && <BatteryPredictionResult task={props.task} result={props.result} nominalCapacityAh={props.sourceMode === "example" ? props.selectedExample.nominalCapacityAh : positiveOrUndefined(props.nominalCapacity)} referenceCycleLife={props.sourceMode === "example" ? props.selectedExample.referenceCycleLife : undefined} />}
      {props.result && props.task === "combined" && <BatteryCombinedResult result={props.result} nominalCapacityAh={props.sourceMode === "example" ? props.selectedExample.nominalCapacityAh : positiveOrUndefined(props.nominalCapacity)} referenceCycleLife={props.sourceMode === "example" ? props.selectedExample.referenceCycleLife : undefined} thresholdHint={positiveOrUndefined(props.targetRetention)} />}
      {props.evidence && <div className="battery-follow-up">
        <button type="button" className="button" onClick={() => downloadEvidence(props.evidence!.payload, props.task)}><Download size={13} />下载运行证据</button>
        <AiOperationalDraftReview draft={props.evidence.draft} />
      </div>}
    </section>
  );
}

function SourceControls(props: BatteryIntelligenceRunPanelProps & { contractStatus: React.ReactNode }) {
  return <>
    <div className="battery-source-tabs" role="tablist" aria-label="数据来源">
      <button className={props.sourceMode === "example" ? "active" : ""} onClick={() => props.onSourceModeChange("example")}><BatteryMedium size={15} />内置样例</button>
      <button className={props.sourceMode === "dataset" ? "active" : ""} onClick={() => props.onSourceModeChange("dataset")}><Database size={15} />生产数据源</button>
      <button className={props.sourceMode === "file" ? "active" : ""} onClick={() => props.onSourceModeChange("file")}><Upload size={15} />临时文件</button>
    </div>
    {props.sourceMode === "example" ? <ExamplePicker {...props} /> : props.sourceMode === "dataset" ? <DatasetPicker {...props} contractStatus={props.contractStatus} /> : (
      <button className={`battery-dropzone ${props.source ? "loaded" : ""}`} onClick={() => props.fileInput.current?.click()}>
        {props.source ? <FileSpreadsheet size={25} /> : <Upload size={25} />}
        <span>{props.source ? props.source.file.name : "上传电池采样 CSV"}</span>
        <small>{props.source ? `${props.source.parsed.rowCount.toLocaleString()} 行 · ${props.source.parsed.headers.length} 个字段 · 点击更换` : "支持 CSV / TSV，按单电芯或单工况上传，最大 15 MiB"}</small>
      </button>
    )}
    <input ref={props.fileInput} hidden type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" onChange={(event) => props.onFileChange(event.target.files?.[0])} />
    {props.sourceMode === "file" && props.source && <><p className="battery-field-preview">已识别：{props.source.parsed.headers.slice(0, 8).join(" · ")}{props.source.parsed.headers.length > 8 ? " …" : ""}</p>{props.contractStatus}</>}
  </>;
}

function ExamplePicker(props: BatteryIntelligenceRunPanelProps) {
  return <label className="battery-example-picker">
    <span>样例工况</span>
    <select value={props.selectedExample.id} onChange={(event) => props.onExampleChange(event.target.value)}>
      {BATTERY_EXAMPLE_GROUPS.map((group) => <optgroup key={group.id} label={group.label}>{BATTERY_EXAMPLES.filter((example) => example.group === group.id).map((example) => <option key={example.id} value={example.id}>{example.name}</option>)}</optgroup>)}
    </select>
    <div><strong>{props.selectedExample.detail}</strong><small>{[...props.selectedExample.tasks.map((item) => BATTERY_TASKS.find((task) => task.id === item)!.label), ...(exampleSupportsBatteryTask(props.selectedExample, "combined") ? ["综合评估"] : [])].join(" · ")}</small></div>
  </label>;
}

function DatasetPicker(props: BatteryIntelligenceRunPanelProps & { contractStatus: React.ReactNode }) {
  return <>
    <label className="battery-dataset-picker"><span>电池数据集</span><select value={props.datasetId} onChange={(event) => props.onDatasetChange(event.target.value)}><option value="">{props.datasets.length ? "请选择数据集" : "数据中心暂无数据集"}</option>{props.datasets.map((dataset) => {
      const missing = Math.max(...(props.datasetAssessments.get(dataset.id) ?? []).map((item) => item.missing.length), 0);
      return <option key={dataset.id} value={dataset.id}>{dataset.name}{missing ? ` · 缺 ${missing} 项` : ""}</option>;
    })}</select><small>数据库、HTTP API、Kafka、MQTT 与现场协议均通过同一个数据集合同读取。</small></label>
    {props.contractStatus}
    {props.activeBinding && <div className={`battery-binding-control ${props.dataContract?.compatible ? "" : "is-warning"}`}>
      <div><span>{props.activeBinding.status === "active" ? "周期任务运行中" : props.activeBinding.status === "paused" ? "周期任务已暂停" : "已保存任务"}</span><strong>{props.activeBinding.name}</strong>{!props.dataContract?.compatible && <small>现有任务与当前字段合同不兼容；暂停或删除后，先在数据中心修正字段再重新运行。</small>}</div>
      <div><button type="button" disabled={props.busy} onClick={() => props.onBindingStatusChange(props.activeBinding!.status === "active" ? "paused" : "active")}>{props.activeBinding.status === "active" ? <Pause size={13} /> : <Play size={13} />}{props.activeBinding.status === "active" ? "暂停" : "恢复"}</button><button type="button" className="is-danger" disabled={props.busy} onClick={props.onRemoveBinding}><Trash2 size={13} />删除任务</button></div>
    </div>}
    {props.datasetId && props.task !== "combined" && <AiDataRunPolicyFields value={props.runPolicy} fields={props.datasets.find((item) => item.id === props.datasetId)?.fields ?? []} onChange={props.onPolicyChange} />}
    {props.datasetId && props.task === "combined" && <small className="battery-combined-note">综合评估为一次性并行运行；周期监控请为单个分析目标建立周期任务。</small>}
  </>;
}

function downloadEvidence(payload: unknown, task: BatteryTask) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `battery-${task}-evidence.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
