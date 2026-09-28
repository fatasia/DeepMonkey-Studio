import { useEffect, useRef, useState } from "react";
import { FlaskConical, LoaderCircle } from "lucide-react";
import type { GeneticOptimizationResult, PlantLiteStudyRecord, PlantLiteStudyRequest } from "@bim-studio/contracts";
import { plantGeneticCandidate, plantGeneticStudyRequest } from "./plantGeneticCandidate";
import { searchPlantGeneticCandidate } from "./plantGeneticSearch";
import "./PlantStudyConsumers.css";

export function PlantLiteGeneticExperiment({ study, busy, onRunSweep }: {
  study: PlantLiteStudyRecord;
  busy: boolean;
  onRunSweep: (requests: PlantLiteStudyRequest[]) => void;
}) {
  const candidate = plantGeneticCandidate(study);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<GeneticOptimizationResult>();
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    active.current?.abort();
    active.current = null;
    setRunning(false); setResult(undefined); setError(""); setSubmitted(false);
    return () => { mounted.current = false; active.current?.abort(); active.current = null; };
  }, [study.id]);
  if (!candidate) return null;
  const bestMinutes = result?.best.genes.minutes;
  async function run() {
    if (running || busy) return;
    setRunning(true); setResult(undefined); setError(""); setSubmitted(false);
    const controller = new AbortController();
    active.current = controller;
    try {
      const found = await searchPlantGeneticCandidate({ model: study.model!, stationId: candidate!.stationId,
        minimumMinutes: candidate!.minimumMinutes, maximumMinutes: candidate!.maximumMinutes, seed: study.seed }, controller.signal);
      if (mounted.current && active.current === controller) setResult(found);
    } catch (reason) {
      if (mounted.current && active.current === controller) setError(controller.signal.aborted ? "已取消筛查；未提交任何候选。" : reason instanceof Error ? reason.message : "筛查失败，请重试。");
    } finally {
      if (mounted.current && active.current === controller) { active.current = null; setRunning(false); }
    }
  }
  return <section className="plant-genetic-experiment" aria-label="GA 候选筛查">
    <header><FlaskConical size={14} /><strong>遗传算法候选筛查</strong><small>最多 8 次评估 · 不保证最优</small></header>
    <p>仅调整“{study.model?.nodes.find((node) => node.id === candidate.stationId)?.name}”确定性工时（基线 {candidate.baseMinutes.toFixed(2)} 分钟，范围 ±20%）。隔离线程使用同 seed、每候选 2 次重复、45 分钟/最多 2000 事件；不等于当前 Study 统计口径，不能用于直接比较显著性。独立现场校准集尚缺。</p>
    <button type="button" disabled={busy || running} onClick={() => void run()}>{running ? <LoaderCircle className="spin" size={13} /> : <FlaskConical size={13} />}{running ? "筛查中" : "筛查工时候选"}</button>
    {running && <button type="button" onClick={() => active.current?.abort()}>取消筛查</button>}
    {error && <p role="alert">{error}</p>}
    {result && bestMinutes !== undefined && <div role="status" aria-live="polite">
      <p>候选 {bestMinutes.toFixed(3)} 分钟 · 吞吐筛查值 {result.best.metricValue.toFixed(2)} 件/时 · {result.evaluations} 次评估 · 种子 {String(study.seed)}</p>
      <small>结果指纹 {result.best.fingerprint}；仅作候选排序。必须从权威基线重新运行完整 Study、读取 95% 区间后判断。</small>
      <button type="button" disabled={busy || running || submitted} title="提交同 seed、同重复次数、同运行上限的独立正式 Study；不直接采用 GA 筛查值" onClick={() => {
        try { onRunSweep([plantGeneticStudyRequest(study, candidate.stationId, bestMinutes, result.best.fingerprint)]); setSubmitted(true); }
        catch (reason) { setError(reason instanceof Error ? reason.message : "无法提交候选，请重新筛查。"); }
      }}>{submitted ? "已提交正式运行" : "运行正式候选 Study"}</button>
    </div>}
  </section>;
}
