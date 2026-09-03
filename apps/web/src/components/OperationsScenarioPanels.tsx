import { BatteryCharging, Boxes, CircleStop, Database, Factory, FileText, Gauge, LoaderCircle, Route } from "lucide-react";
import type { OperationsSnapshot } from "../api";
import type { DataDatasetPreview, DataDatasetRecord, PlantLiteStudyRequest, ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import {
  defaultLogistics,
  defaultPlantLite,
  EnergyCard,
  OperationsEmpty,
} from "./operationsPresentation";
import { LogisticsStudyPanel } from "./LogisticsStudyPanel";
import { PlantLiteStudyPanel } from "./PlantLiteStudyPanel";
import { PlantLiteModelAuthoring } from "./PlantLiteModelAuthoring";
import { PprPlanPanel } from "./PprPlanPanel";
import type { EnergyFieldMap } from "./energyDatasetMapping";
import { plantLiteModelIssues } from "./plantLiteModelEditing";
import { plantLiteRunProgressLabel, type PlantLiteRunProgress } from "./plantLiteRunController";

export type LogisticsStudyMode = "analytic" | "des" | "ppr";

export function LogisticsOperationsPanel({
  busy,
  logistics,
  plantLite,
  mode,
  snapshot,
  onChange,
  onPlantLiteChange,
  onModeChange,
  onRun,
  onRunPlantLite,
  onRunPlantLiteSweep,
  plantRunProgress,
  plantRunNotice,
  onCancelPlantLite,
  onReproduce,
  onReproducePlantLite,
  project,
  scenes,
  datasets,
  loadDatasetPreview,
}: {
  busy: boolean;
  logistics: typeof defaultLogistics;
  plantLite: typeof defaultPlantLite;
  mode: LogisticsStudyMode;
  snapshot: OperationsSnapshot | undefined;
  onChange: (value: typeof defaultLogistics) => void;
  onPlantLiteChange: (value: PlantLiteStudyRequest) => void;
  onModeChange: (value: LogisticsStudyMode) => void;
  onRun: () => void;
  onRunPlantLite: () => void;
  onRunPlantLiteSweep: (requests: PlantLiteStudyRequest[]) => void;
  plantRunProgress?: PlantLiteRunProgress;
  plantRunNotice?: string;
  onCancelPlantLite: () => void;
  onReproduce: (experimentId: string) => void;
  onReproducePlantLite: (studyId: string) => void;
  project: ProjectRecord;
  scenes: SceneSnapshot[];
  datasets?: DataDatasetRecord[];
  loadDatasetPreview?: (datasetId: string) => Promise<DataDatasetPreview>;
}) {
  const plantIssues = mode === "des" ? plantLiteModelIssues(plantLite) : [];
  return (
    <div className="operations-planning-workspace">
      <nav className="operations-planning-modes" aria-label="选择工厂规划任务">
        <button type="button" className={mode === "analytic" ? "active" : ""} aria-pressed={mode === "analytic"} disabled={busy} onClick={() => onModeChange("analytic")} title="用少量参数快速判断物流能力">
          <Gauge size={15} />快速估算
        </button>
        <button type="button" className={mode === "des" ? "active" : ""} aria-pressed={mode === "des"} disabled={busy} onClick={() => onModeChange("des")} title="离散事件仿真（DES）：搭建流程并定位产能瓶颈">
          <Route size={15} />流程仿真
        </button>
        <button type="button" className={mode === "ppr" ? "active" : ""} aria-pressed={mode === "ppr"} disabled={busy} onClick={() => onModeChange("ppr")} title="PPR/BOP：安排产品、工序与资源">
          <Boxes size={15} />工艺规划
        </button>
      </nav>
      {mode === "ppr" ? (
        <PprPlanPanel
          projectId={project.id}
          scenes={scenes}
          snapshot={snapshot}
          onCreatePlantLiteDraft={(result) => {
            onPlantLiteChange(result.request);
            onModeChange("des");
          }}
        />
      ) : <div className="operations-grid">
      <section className="operations-panel">
        <header>
          <div>
            <strong>{mode === "analytic" ? "物流快速估算" : "流程仿真"}</strong>
            <small>{mode === "analytic" ? "命名工况并填写关键参数，快速找出需求、运输或缓冲瓶颈。" : "从起步流程开始，增删或拖动节点，运行后直接定位瓶颈。"}</small>
          </div>
          <div className="plant-lite-run-control" aria-live="polite">
            <div className="plant-lite-run-actions">
              <button className="button primary" disabled={busy || plantIssues.length > 0} onClick={mode === "analytic" ? onRun : onRunPlantLite}>
                {busy ? <LoaderCircle className="spin" size={15} /> : <Factory size={15} />}
                {mode === "des" && plantRunProgress ? plantLiteRunProgressLabel(plantRunProgress) : mode === "analytic" ? "运行快速估算" : "运行仿真"}
              </button>
              {mode === "des" && plantRunProgress && plantRunProgress.phase !== "refreshing" && (
                <button
                  type="button"
                  className="button plant-lite-run-cancel"
                  disabled={plantRunProgress.phase === "cancelling"}
                  onClick={onCancelPlantLite}
                >
                  <CircleStop size={14} />
                  {plantRunProgress.phase === "cancelling" ? "取消中" : "取消"}
                </button>
              )}
            </div>
            {mode === "des" && !plantRunProgress && plantRunNotice && <small className="plant-lite-run-notice" role="status">{plantRunNotice}</small>}
          </div>
        </header>
        {mode === "analytic" ? <AnalyticFields logistics={logistics} onChange={onChange} /> : <PlantLiteModelAuthoring value={plantLite} onChange={onPlantLiteChange} />}
        {!snapshot?.logisticsExperiments.length && mode === "analytic" && (
          <OperationsEmpty text="默认参数已填好；直接运行即可得到吞吐、WIP、交付率和瓶颈建议。" />
        )}
      </section>
      <div className="operations-side-stack">
        {mode === "analytic" ? (
          <LogisticsStudyPanel
            results={snapshot?.logisticsExperiments ?? []}
            busy={busy}
            onLoadInputs={onChange}
            onReproduce={onReproduce}
          />
        ) : (
          <PlantLiteStudyPanel
            results={snapshot?.plantLiteStudies ?? []}
            busy={busy}
            onReproduce={onReproducePlantLite}
            onRunSweep={onRunPlantLiteSweep}
            {...(datasets && loadDatasetPreview ? { datasets, loadDatasetPreview } : {})}
          />
        )}
      </div>
      </div>}
    </div>
  );
}

function AnalyticFields({ logistics, onChange }: { logistics: typeof defaultLogistics; onChange: (value: typeof defaultLogistics) => void; }) {
  return <div className="operations-form-grid">
          <label className="operations-field-wide">
            <span>工况名称</span>
            <input
              value={logistics.name}
              maxLength={80}
              onChange={(event) => onChange({ ...logistics, name: event.target.value })}
            />
          </label>
          {(
            [
              ["agvCount", "AGV 数量", 1, 1, 100],
              ["cycleTimeSec", "单次循环（秒）", 1, 1, 86400],
              ["chargingMinutesPerHour", "每小时充电（分）", 0, 1, 59],
              ["congestionFactor", "拥堵系数", 0, 0.05, 3],
              ["demandPerHour", "需求（件/时）", 0, 1, 1000000],
              ["bufferCapacity", "缓冲容量", 1, 1, 1000000],
              ["durationHours", "仿真时长（小时）", 0.1, 0.5, 8760],
            ] as const
          ).map(([key, label, minimum, step, maximum]) => (
            <label key={key}>
              <span>{label}</span>
              <input
                type="number"
                min={minimum}
                max={maximum}
                step={step}
                value={logistics[key]}
                onChange={(event) => onChange({ ...logistics, [key]: Number(event.target.value) })}
              />
            </label>
          ))}
        </div>;
}

export function EnergyOperationsPanel({
  busy,
  datasets,
  sourceMode,
  datasetId,
  fieldMap,
  energyText,
  snapshot,
  onSourceModeChange,
  onDatasetChange,
  onFieldMapChange,
  onChange,
  onRun,
}: {
  busy: boolean;
  datasets: DataDatasetRecord[];
  sourceMode: "dataset" | "paste";
  datasetId: string;
  fieldMap: EnergyFieldMap;
  energyText: string;
  snapshot: OperationsSnapshot | undefined;
  onSourceModeChange: (value: "dataset" | "paste") => void;
  onDatasetChange: (value: string) => void;
  onFieldMapChange: (value: EnergyFieldMap) => void;
  onChange: (value: string) => void;
  onRun: () => void;
}) {
  const dataset = datasets.find((item) => item.id === datasetId);
  const canRun = sourceMode === "dataset"
    ? Boolean(datasetId && fieldMap.output && fieldMap.energyKwh)
    : energyText.trim().split(/\r?\n/).filter(Boolean).length >= 4;
  return (
    <div className="operations-grid">
      <section className="operations-panel">
        <header>
          <div>
            <strong>单位产量能耗</strong>
            <small>优先读取数据中心的生产数据集；临时 CSV 仅用于一次性分析。</small>
          </div>
          <button className="button primary" disabled={busy || !canRun} onClick={onRun}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <BatteryCharging size={15} />}
            分析能耗
          </button>
        </header>
        <div className="operations-source-tabs" role="tablist" aria-label="能耗数据来源">
          <button className={sourceMode === "dataset" ? "active" : ""} onClick={() => onSourceModeChange("dataset")}><Database size={13} />生产数据集</button>
          <button className={sourceMode === "paste" ? "active" : ""} onClick={() => onSourceModeChange("paste")}><FileText size={13} />临时 CSV</button>
        </div>
        {sourceMode === "dataset" ? (
          <div className="operations-energy-source">
            <label>
              <span>数据集</span>
              <select value={datasetId} onChange={(event) => onDatasetChange(event.target.value)}>
                {!datasets.length && <option value="">数据中心暂无数据集</option>}
                {datasets.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.fields.length} 个字段</option>)}
              </select>
            </label>
            <div className="operations-form-grid operations-energy-fields">
              <EnergyFieldSelect label="时间（可选）" value={fieldMap.timestamp} dataset={dataset} onChange={(timestamp) => onFieldMapChange({ ...fieldMap, timestamp })} optional />
              <EnergyFieldSelect label="产量" value={fieldMap.output} dataset={dataset} onChange={(output) => onFieldMapChange({ ...fieldMap, output })} />
              <EnergyFieldSelect label="能耗 kWh" value={fieldMap.energyKwh} dataset={dataset} onChange={(energyKwh) => onFieldMapChange({ ...fieldMap, energyKwh })} />
              <EnergyFieldSelect label="空转分钟（可选）" value={fieldMap.idleMinutes} dataset={dataset} onChange={(idleMinutes) => onFieldMapChange({ ...fieldMap, idleMinutes })} optional />
            </div>
            {!fieldMap.output || !fieldMap.energyKwh ? <div className="operations-notice">当前数据集未自动识别产量或能耗字段，请完成字段映射后再运行。</div> : <div className="operations-source-proof"><Database size={13} />运行时读取数据集最新窗口，不复制连接凭据。</div>}
          </div>
        ) : (
          <>
            <textarea
              className="operations-textarea"
              value={energyText}
              onChange={(event) => onChange(event.target.value)}
              placeholder={"时间,产量,能耗kWh,空转分钟\n2026-09-02T08:00:00,120,72,4\n至少 4 行"}
              spellCheck={false}
            />
            <div className="operations-notice">临时数据不会保存为数据集；需要周期分析时请先在数据中心建立连接和字段。</div>
          </>
        )}
        {snapshot?.energyInsights[0] ? (
          <EnergyCard insight={snapshot.energyInsights[0]} />
        ) : (
          <OperationsEmpty text={sourceMode === "dataset" ? "完成产量与能耗字段映射后运行分析。" : "粘贴至少 4 行现场数据后运行一次性分析。"} />
        )}
      </section>
    </div>
  );
}

function EnergyFieldSelect({ label, value, dataset, optional = false, onChange }: { label: string; value: string; dataset: DataDatasetRecord | undefined; optional?: boolean; onChange: (value: string) => void }) {
  return <label><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">{optional ? "不映射" : "请选择字段"}</option>{dataset?.fields.map((field) => <option key={field.key} value={field.key}>{field.label} · {field.key}</option>)}</select></label>;
}

export function MaintenanceCasesPanel({ snapshot }: { snapshot: OperationsSnapshot | undefined }) {
  const cases = snapshot?.cases.filter((item) => item.type === "maintenance") ?? [];
  return (
    <section className="operations-panel">
      <header>
        <div>
          <strong>维护处置</strong>
          <small>确认后纳入设备异常处置闭环。</small>
        </div>
      </header>
      <div className="operations-list">
        {cases.slice(0, 6).map((item) => (
          <article key={item.id}>
            <span className={item.severity}>{item.severity}</span>
            <div>
              <strong>{item.title}</strong>
              <small>{item.status}</small>
            </div>
          </article>
        ))}
      </div>
      {!cases.length && <OperationsEmpty text="风险评估完成后，可一键创建维护处置事项。" />}
    </section>
  );
}
