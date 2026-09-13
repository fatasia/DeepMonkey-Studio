import { useMemo, useState } from "react";
import { Activity, AlertTriangle, Plus, Route, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../api";

type Chemistry = "lfp" | "ncm";
type ScenarioSegment = {
  id: number;
  durationMinutes: string;
  currentCRate: string;
  ambientTemperatureC: string;
};

const INITIAL_SEGMENTS: ScenarioSegment[] = [
  { id: 1, durationMinutes: "4", currentCRate: "-0.6", ambientTemperatureC: "25" },
  { id: 2, durationMinutes: "3", currentCRate: "-1.4", ambientTemperatureC: "38" },
  { id: 3, durationMinutes: "3", currentCRate: "0", ambientTemperatureC: "30" },
];

export function BatteryScenarioWorkbench({
  projectId,
  chemistry,
  nominalCapacityAh,
  nativeRuntime,
}: {
  projectId: string;
  chemistry: Chemistry;
  nominalCapacityAh: number | undefined;
  nativeRuntime: boolean;
}) {
  const [scenarioName, setScenarioName] = useState("高温脉冲工况");
  const [initialSoc, setInitialSoc] = useState("80");
  const [initialSoh, setInitialSoh] = useState("95");
  const [initialTemperature, setInitialTemperature] = useState("25");
  const [segments, setSegments] = useState<ScenarioSegment[]>(INITIAL_SEGMENTS);
  const [nextId, setNextId] = useState(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Record<string, unknown>>();
  const totalMinutes = useMemo(() => segments.reduce((sum, item) => sum + finite(item.durationMinutes), 0), [segments]);

  function updateSegment(id: number, field: keyof Omit<ScenarioSegment, "id">, value: string) {
    setSegments(current => current.map(item => item.id === id ? { ...item, [field]: value } : item));
    setResult(undefined);
  }

  function addSegment() {
    if (segments.length >= 6) return;
    setSegments(current => [...current, { id: nextId, durationMinutes: "2", currentCRate: "0", ambientTemperatureC: "25" }]);
    setNextId(current => current + 1);
    setResult(undefined);
  }

  function removeSegment(id: number) {
    if (segments.length === 1) return;
    setSegments(current => current.filter(item => item.id !== id));
    setResult(undefined);
  }

  async function runScenario() {
    setError("");
    setResult(undefined);
    if (!nativeRuntime) {
      setError("Rust 数字孪生运行时未连接");
      return;
    }
    try {
      const capacity = positive(nominalCapacityAh, "额定容量");
      const soc = range(initialSoc, "初始 SOC", 0, 100) / 100;
      const soh = range(initialSoh, "初始 SOH", 50, 105) / 100;
      const temperatureC = range(initialTemperature, "初始温度", -30, 80);
      if (!scenarioName.trim()) throw new Error("请输入工况名称");
      if (scenarioName.trim().length > 80) throw new Error("工况名称不能超过 80 个字符");
      const parsedSegments = segments.map((segment, index) => ({
        durationMinutes: range(segment.durationMinutes, `第 ${index + 1} 段时长`, 0.01, 120),
        currentCRate: range(segment.currentCRate, `第 ${index + 1} 段倍率`, -3, 3),
        ambientTemperatureC: range(segment.ambientTemperatureC, `第 ${index + 1} 段环境温度`, -30, 80),
      }));
      if (parsedSegments.reduce((sum, item) => sum + item.durationMinutes, 0) > 120) throw new Error("工况总时长不能超过 120 分钟");
      setBusy(true);
      const initialized = await api.invokeCapability<Record<string, unknown>>(projectId, "battery.twin.initialize", {
        chemistry,
        nominalCapacityAh: capacity,
        soc,
        soh,
        temperatureC,
      });
      const twinId = initialized.output && String(initialized.output.twinId ?? "");
      if (!twinId) throw new Error(initialized.error?.message ?? "数字孪生初始化未返回实例标识");
      const simulated = await api.invokeCapability<Record<string, unknown>>(projectId, "battery.twin.simulate", {
        twinId,
        scenarioName: scenarioName.trim(),
        resolutionMinutes: 1,
        segments: parsedSegments,
        executionMode: "dynamic",
        commit: false,
      });
      if (!simulated.output) throw new Error(simulated.error?.message ?? "多物理推演没有返回结构化结果");
      setResult(simulated.output);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="operations-panel battery-scenario-panel">
      <header>
        <div>
          <strong>可编辑工况推演</strong>
          <small>修改初始状态与分段负载，比较电热基线、SPM-PINO 与 SPM 回退轨迹。</small>
        </div>
        <span className={`battery-scenario-runtime ${nativeRuntime ? "ready" : ""}`}>
          <i aria-hidden="true" />{nativeRuntime ? "Rust 孪生已连接" : "运行时未连接"}
        </span>
      </header>

      <div className="battery-scenario-body">
        <div className="battery-scenario-baseline">
          <label><span>工况名称</span><input value={scenarioName} onChange={event => { setScenarioName(event.target.value); setResult(undefined); }} /></label>
          <label><span>初始 SOC %</span><input inputMode="decimal" value={initialSoc} onChange={event => { setInitialSoc(event.target.value); setResult(undefined); }} /></label>
          <label><span>初始 SOH %</span><input inputMode="decimal" value={initialSoh} onChange={event => { setInitialSoh(event.target.value); setResult(undefined); }} /></label>
          <label><span>初始温度 °C</span><input inputMode="decimal" value={initialTemperature} onChange={event => { setInitialTemperature(event.target.value); setResult(undefined); }} /></label>
        </div>

        <div className="battery-scenario-segments">
          <div className="battery-scenario-segment-head">
            <span>分段工况</span>
            <small>{segments.length} 段 · {totalMinutes.toFixed(1)} min · 正值充电 / 负值放电</small>
          </div>
          {segments.map((segment, index) => (
            <div className="battery-scenario-segment" key={segment.id}>
              <b>{String(index + 1).padStart(2, "0")}</b>
              <label><span>时长 min</span><input aria-label={`第 ${index + 1} 段时长`} inputMode="decimal" value={segment.durationMinutes} onChange={event => updateSegment(segment.id, "durationMinutes", event.target.value)} /></label>
              <label><span>电流倍率 C</span><input aria-label={`第 ${index + 1} 段电流倍率`} inputMode="decimal" value={segment.currentCRate} onChange={event => updateSegment(segment.id, "currentCRate", event.target.value)} /></label>
              <label><span>环境温度 °C</span><input aria-label={`第 ${index + 1} 段环境温度`} inputMode="decimal" value={segment.ambientTemperatureC} onChange={event => updateSegment(segment.id, "ambientTemperatureC", event.target.value)} /></label>
              <button type="button" aria-label={`删除第 ${index + 1} 段`} disabled={segments.length === 1} onClick={() => removeSegment(segment.id)}><Trash2 size={13} /></button>
            </div>
          ))}
          <button type="button" className="battery-scenario-add" disabled={segments.length >= 6} onClick={addSegment}><Plus size={13} />增加一段</button>
        </div>

        {error && <p className="operations-notice"><AlertTriangle size={14} />{error}</p>}
        <div className="battery-scenario-action">
          <div><Route size={15} /><span>动态路由会根据验证域、物理残差和收益门选择主轨迹。</span></div>
          <button type="button" className="button primary" disabled={busy || !nativeRuntime} onClick={() => void runScenario()}>
            <Activity size={15} />{busy ? "正在推演" : "运行多物理推演"}
          </button>
        </div>
        {result && <BatteryScenarioResult result={result} />}
      </div>
    </section>
  );
}

function BatteryScenarioResult({ result }: { result: Record<string, unknown> }) {
  const summary = record(result.summary) ?? {};
  const routing = record(result.routing) ?? {};
  const domain = record(result.domain) ?? {};
  const evidence = record(result.evidence) ?? {};
  const safety = record(result.safetyProjection) ?? {};
  const warnings = strings(result.warnings);
  const points = Array.isArray(result.points) ? result.points.map(record).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
  const expert = twinExpert(routing.selectedExpert ?? summary.selectedExpert);
  const domainReasons = strings(domain.reasons);
  return (
    <article className={`battery-scenario-result ${domain.status === "out-of-domain" ? "warning" : ""}`}>
      <div className="battery-result-heading">
        <div><span>推演结论</span><strong>{expert}</strong></div>
        <div><small><ShieldCheck size={13} />TwinMoE 正式路由</small><small>Rust · ONNX Runtime</small></div>
      </div>
      <div className="battery-metrics">
        <ScenarioMetric label="终点 SOC" value={metric(summary.finalSocPct, "%")} />
        <ScenarioMetric label="峰值温度" value={metric(summary.maxTemperatureC, " °C")} />
        <ScenarioMetric label="最高电压" value={metric(summary.maxVoltageV, " V", 3)} />
        <ScenarioMetric label="吞吐量" value={metric(summary.throughputAh, " Ah")} />
      </div>
      {points.length > 1 && <BatteryScenarioTrend points={points} />}
      <div className="battery-scenario-evidence">
        <span><b>适用域</b>{domainStatus(domain.status)}</span>
        <span><b>路由路径</b>{strings(routing.routePath).join(" → ") || "—"}</span>
        <span><b>不确定度</b>{metric(summary.uncertaintyHalfWidthPct, "%")}</span>
        <span><b>安全投影</b>{number(safety.interventionCount) ?? 0} 次干预 · {safety.allFeasible === true ? "全部可行" : "存在不可行段"}</span>
        <span><b>模型版本</b>{String(evidence.modelVersion ?? "—")}</span>
      </div>
      {domainReasons.length > 0 && <p className="battery-scenario-domain">域判断：{domainReasons.join("；")}</p>}
      {warnings.length > 0 && <ul>{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
    </article>
  );
}

function BatteryScenarioTrend({ points }: { points: Record<string, unknown>[] }) {
  const width = 720;
  const height = 116;
  const pad = 10;
  const times = points.map(point => number(point.timeMinutes) ?? 0);
  const values = points.map(point => number(point.primarySocPct) ?? number(point.baselineSocPct) ?? 0);
  const end = Math.max(...times, 1);
  const path = points.map((point, index) => {
    const x = pad + (times[index]! / end) * (width - pad * 2);
    const y = height - pad - (values[index]! / 100) * (height - pad * 2);
    return `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  return <figure className="battery-trend battery-scenario-trend">
    <figcaption><span>主轨迹 SOC</span><small>{points.length} 个多物理输出点</small></figcaption>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="工况推演主轨迹 SOC" preserveAspectRatio="none">
      {[.25, .5, .75].map(ratio => <line key={ratio} x1={pad} x2={width - pad} y1={height * ratio} y2={height * ratio} />)}
      <path d={path} />
    </svg>
    <div><span>0 min</span><b>{Math.min(...values).toFixed(1)}–{Math.max(...values).toFixed(1)}%</b><span>{end.toFixed(1)} min</span></div>
  </figure>;
}

function ScenarioMetric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function twinExpert(value: unknown): string {
  if (value === "pino") return "SPM-PINO 主轨迹";
  if (value === "spm") return "SPM 守恒回退";
  return "电热基线主轨迹";
}
function domainStatus(value: unknown): string {
  if (value === "supported" || value === "in-domain") return "验证域内";
  if (value === "out-of-domain") return "域外 · 已保护";
  return String(value ?? "待确认");
}
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function metric(value: unknown, suffix: string, digits = 1): string { const parsed = number(value); return parsed === undefined ? "—" : `${parsed.toFixed(digits)}${suffix}`; }
function finite(value: string): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function range(value: string, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label}必须在 ${minimum}–${maximum} 之间`);
  return parsed;
}
function positive(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) throw new Error(`${label}必须是正数`);
  return value;
}
