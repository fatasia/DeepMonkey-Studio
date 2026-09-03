import { useEffect, useId, useMemo, useState } from "react";
import { ChevronDown, Crosshair, History, RotateCcw } from "lucide-react";
import type { IndustrialStudyRecord, IndustrialStudyType } from "@bim-studio/contracts";
import { compareIndustrialStudies } from "./industrialStudyComparison";

interface Props {
  records: IndustrialStudyRecord[];
  busy: boolean;
  defaultExpanded?: boolean;
  onReproduce: (record: IndustrialStudyRecord) => void;
  onOpenTarget: (sceneId: string, objectId: string) => void;
}

export function OperationsStudyHistory({ records, busy, defaultExpanded = false, onReproduce, onOpenTarget }: Props) {
  const [type, setType] = useState<IndustrialStudyType | "all">("all");
  const [selectedId, setSelectedId] = useState(records[0]?.id ?? "");
  const [baselineId, setBaselineId] = useState("");
  const [expanded, setExpanded] = useState(defaultExpanded);
  const contentId = useId();
  const visible = useMemo(
    () => type === "all" ? records : records.filter((record) => record.type === type),
    [records, type],
  );
  const selected = visible.find((record) => record.id === selectedId) ?? visible[0];
  const baselines = selected
    ? records.filter((record) => record.type === selected.type && record.id !== selected.id)
    : [];
  const baseline = baselines.find((record) => record.id === baselineId)
    ?? baselines.find((record) => record.id === selected?.lineage.baselineStudyId)
    ?? baselines[0];
  const comparison = selected && baseline ? compareIndustrialStudies(selected, baseline) : [];

  useEffect(() => {
    if (selected) setSelectedId(selected.id);
  }, [selected?.id]);

  useEffect(() => {
    setBaselineId(selected?.lineage.baselineStudyId ?? "");
  }, [selected?.id, selected?.lineage.baselineStudyId]);

  if (!records.length) return null;
  return <section className={`operations-study-history ${expanded ? "expanded" : "collapsed"}`} aria-label="统一运行记录">
    <header>
      <button className="operations-study-toggle" type="button" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded((current) => !current)}>
        <History size={15} />
        <span><strong>运行记录</strong><small>{records.length} 条 · 输入、场景、引擎和结果可追溯</small></span>
        <ChevronDown size={15} />
      </button>
      {expanded && <select value={type} aria-label="运行类型" onChange={(event) => setType(event.target.value as IndustrialStudyType | "all")}>
        <option value="all">全部类型</option>
        <option value="plant-lite">物流仿真</option>
        <option value="what-if">工况推演</option>
        <option value="workcell-audit">工位检查</option>
        <option value="virtual-commissioning">控制验证</option>
      </select>}
    </header>
    {expanded && <div id={contentId} className="operations-study-layout">
      <nav aria-label="运行记录列表">
        {visible.map((record) => <button
          key={record.id}
          className={record.id === selected?.id ? "active" : ""}
          onClick={() => setSelectedId(record.id)}
        >
          <span><strong>{record.title}</strong><small>{typeLabel(record.type)} · {formatTime(record.updatedAt)}</small></span>
          <em className={record.run.status}>{statusLabel(record.run.status)}</em>
        </button>)}
      </nav>
      {selected && <article>
        <div className="operations-study-summary">
          <span><strong>{selected.title}</strong><small>{engineLabel(selected)}</small></span>
          <em className={selected.run.status}>{statusLabel(selected.run.status)}</em>
        </div>
        <p>{selected.result?.headline ?? "已保存待运行工况"}</p>
        {selected.result?.metrics.length ? <div className="operations-study-metrics">
          {selected.result.metrics.map((item) => <span key={item.key}><small>{item.label}</small><strong>{item.value}{item.unit ?? ""}</strong></span>)}
        </div> : null}
        <div className="operations-study-evidence">
          <Evidence label="输入" value={selected.fingerprints.input} />
          <Evidence label="场景" value={selected.fingerprints.scene} />
          <Evidence label="模型" value={selected.fingerprints.model} />
          <Evidence label="结果" value={selected.fingerprints.evidence} />
        </div>
        {selected.scenarioInput ? <details><summary>查看已保存工况输入</summary><pre>{JSON.stringify(selected.scenarioInput, null, 2)}</pre></details>
          : <p className="operations-study-missing">旧记录缺少完整工况输入，不能宣称精确复现。</p>}
        {baselines.length > 0 && <div className="operations-study-comparison">
          <label><span>对比基线</span><select value={baseline?.id ?? ""} onChange={(event) => setBaselineId(event.target.value)}>
            {baselines.map((record) => <option key={record.id} value={record.id}>{record.title} · {formatTime(record.updatedAt)}</option>)}
          </select></label>
          <div>{comparison.map((item) => <span key={item.key} className={item.status}><small>{item.label}</small><strong>{comparisonLabel(item.status)}</strong></span>)}</div>
        </div>}
        <div className="operations-study-actions">
          <button disabled={busy} onClick={() => onReproduce(selected)}><RotateCcw size={13} />{selected.reproduction.kind === "rerun" ? "复现此工况" : "打开并复核"}</button>
          {selected.context.sceneId && selected.context.objectIds[0] && <button onClick={() => onOpenTarget(selected.context.sceneId!, selected.context.objectIds[0]!)}><Crosshair size={13} />定位三维对象</button>}
        </div>
      </article>}
    </div>}
  </section>;
}

function Evidence({ label, value }: { label: string; value: string | null }) {
  return <span className={value ? "verified" : "missing"}><small>{label}</small><code title={value ?? "缺少证据"}>{value ? shortFingerprint(value) : "缺失"}</code></span>;
}

function typeLabel(type: IndustrialStudyType): string {
  return ({ "plant-lite": "物流仿真", "what-if": "工况推演", "workcell-audit": "工位检查", "virtual-commissioning": "控制验证" })[type];
}

function statusLabel(status: IndustrialStudyRecord["run"]["status"]): string {
  return ({ ready: "待运行", running: "运行中", cancelling: "取消中", completed: "已完成", passed: "通过", failed: "未通过", cancelled: "已取消", limited: "受限", "insufficient-data": "证据不足" })[status];
}

function comparisonLabel(status: "same" | "changed" | "missing"): string {
  return ({ same: "一致", changed: "已变化", missing: "证据缺失" })[status];
}

function engineLabel(record: IndustrialStudyRecord): string {
  return record.execution ? `${record.execution.engineId} · ${record.execution.engineVersion}` : "旧记录缺少执行引擎证据";
}

function shortFingerprint(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 9)}…${value.slice(-6)}`;
}

function formatTime(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString("zh-CN", { hour12: false });
}
