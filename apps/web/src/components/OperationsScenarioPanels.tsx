import { BatteryCharging, Factory, LoaderCircle } from "lucide-react";
import type { OperationsSnapshot } from "../api";
import type { PlantLiteStudyRequest, ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import {
  defaultLogistics,
  defaultPlantLite,
  EnergyCard,
  OperationsEmpty,
} from "./operationsPresentation";
import { LogisticsStudyPanel } from "./LogisticsStudyPanel";
import { PlantLiteStudyPanel } from "./PlantLiteStudyPanel";
import { PprPlanPanel } from "./PprPlanPanel";

export type LogisticsStudyMode = "analytic" | "des";

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
  onReproduce,
  onReproducePlantLite,
  project,
  scenes,
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
  onReproduce: (experimentId: string) => void;
  onReproducePlantLite: (studyId: string) => void;
  project: ProjectRecord;
  scenes: SceneSnapshot[];
}) {
  return (
    <div className="operations-grid">
      <section className="operations-panel">
        <header>
          <div>
            <strong>{mode === "analytic" ? "物流快速估算" : "Plant Lite 离散仿真"}</strong>
            <small>{mode === "analytic" ? "命名工况并填写关键参数，快速找出需求、运输或缓冲瓶颈。" : "运行已校准的 AGV 两工位模板，报告随机波动与 95% 区间。"}</small>
          </div>
          <button className="button primary" disabled={busy} onClick={mode === "analytic" ? onRun : onRunPlantLite}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <Factory size={15} />}
            {mode === "analytic" ? "运行快速估算" : "运行离散仿真"}
          </button>
        </header>
        <div className="operations-inline-actions">
          <button className={mode === "analytic" ? "primary" : ""} disabled={busy} onClick={() => onModeChange("analytic")}>快速估算</button>
          <button className={mode === "des" ? "primary" : ""} disabled={busy} onClick={() => onModeChange("des")}>离散仿真</button>
        </div>
        {mode === "analytic" ? <AnalyticFields logistics={logistics} onChange={onChange} /> : <PlantLiteFields value={plantLite} onChange={onPlantLiteChange} />}
        {!snapshot?.logisticsExperiments.length && mode === "analytic" && (
          <OperationsEmpty text="默认参数已填好；直接运行即可得到吞吐、WIP、交付率和瓶颈建议。" />
        )}
        {!snapshot?.plantLiteStudies.length && mode === "des" && (
          <OperationsEmpty text="模板隐藏了拓扑和分布细节，只保留 AGV、缓冲、seed 与重复次数这四个必要旋钮。" />
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
          />
        )}
        <PprPlanPanel projectId={project.id} scenes={scenes} snapshot={snapshot} />
      </div>
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

function PlantLiteFields({ value, onChange }: { value: PlantLiteStudyRequest; onChange: (value: PlantLiteStudyRequest) => void; }) {
  return <div className="operations-form-grid">
    <label className="operations-field-wide"><span>工况名称</span><input value={value.name} maxLength={80} onChange={(event) => onChange({ ...value, name: event.target.value })} /></label>
    <label><span>AGV 数量</span><input type="number" min={1} max={12} value={value.agvCount} onChange={(event) => onChange({ ...value, agvCount: Number(event.target.value) })} /></label>
    <label><span>缓冲容量</span><input type="number" min={1} max={200} value={value.bufferCapacity} onChange={(event) => onChange({ ...value, bufferCapacity: Number(event.target.value) })} /></label>
    <label><span>固定 seed</span><input value={String(value.seed ?? "")} maxLength={120} onChange={(event) => onChange({ ...value, seed: event.target.value })} /></label>
    <label><span>重复次数</span><input type="number" min={1} max={30} value={value.replications} onChange={(event) => onChange({ ...value, replications: Number(event.target.value) })} /></label>
  </div>;
}

export function EnergyOperationsPanel({
  busy,
  energyText,
  snapshot,
  onChange,
  onRun,
}: {
  busy: boolean;
  energyText: string;
  snapshot: OperationsSnapshot | undefined;
  onChange: (value: string) => void;
  onRun: () => void;
}) {
  return (
    <div className="operations-grid">
      <section className="operations-panel">
        <header>
          <div>
            <strong>单位产量能耗</strong>
            <small>每行：时间、产量、能耗 kWh、空转分钟；只需粘贴一小段时序数据。</small>
          </div>
          <button className="button primary" disabled={busy} onClick={onRun}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <BatteryCharging size={15} />}
            分析能耗
          </button>
        </header>
        <textarea
          className="operations-textarea"
          value={energyText}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
        />
        {snapshot?.energyInsights[0] ? (
          <EnergyCard insight={snapshot.energyInsights[0]} />
        ) : (
          <OperationsEmpty text="已预填示例；替换为现场数据后点击“分析能耗”。" />
        )}
      </section>
    </div>
  );
}

export function MaintenanceCasesPanel({ snapshot }: { snapshot: OperationsSnapshot | undefined }) {
  const cases = snapshot?.cases.filter((item) => item.type === "maintenance") ?? [];
  return (
    <section className="operations-panel">
      <header>
        <div>
          <strong>维护 Case</strong>
          <small>确认后纳入设备异常处置闭环。</small>
        </div>
      </header>
      <div className="operations-list">
        {cases.slice(0, 6).map((item) => (
          <article key={item.id}>
            <span className={item.severity}>{item.severity}</span>
            <div>
              <strong>{item.title}</strong>
              <small>{item.owner} · {item.status}</small>
            </div>
          </article>
        ))}
      </div>
      {!cases.length && <OperationsEmpty text="风险评估完成后，可一键创建维护 Case。" />}
    </section>
  );
}
