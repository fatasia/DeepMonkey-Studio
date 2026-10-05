import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Beaker,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  ClipboardList,
  FileText,
  GitCommitHorizontal,
  History,
  LoaderCircle,
  Network,
  Play,
} from "lucide-react";
import type { OntologyActionType, OntologyPackage } from "@bim-studio/contracts";
import { planActionFingerprint } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import type {
  DecisionChainNode,
  DecisionChainTrace,
  DecisionImpactResult,
  SimilarDecisionHit,
  SimilarDecisionsResult,
} from "../apiClients/provenanceApi";
import { api } from "../api";
import "./OntologyDecisionChainPanel.css";

/**
 * Semantica 两线会合点：本体对象/行动卡 ↔ AI 决策证据。
 *
 * 消费账本三刀的只读端点（apps/api provenanceRoutes，前端不拼路径）：
 * ① traceDecisionChain——对象卡上每个绑定行动，按与执行侧同一确定性口径
 *   （planActionFingerprint：包版本+行动版本+目标+空参数）重算计划指纹探测链；
 * ② findSimilarDecisions——链上判定的理由码/指纹检索先例；
 * ③ analyzeDecisionImpact——锚节点指纹反查下游影响面。
 *
 * 诚实边界（必须呈现，不粉饰）：
 * - 探测锚是「空参数计划指纹」；带参执行的计划指纹不同，不会被此探测命中（如实说明）；
 * - 未命中（found=false）呈现"账本无记录"，不伪造链；断链 gaps 逐条警示展示；
 * - 探测候选为空（对象无绑定行动）时给出指引而非空白。
 */

/** 本体对象 → 决策链探测候选（纯函数：与 ontologyActionService 同一指纹口径）。
 *  actionKey 给定时只探测该行动（行动节点卡自查场景）。 */
export function computeDecisionChainProbes(pkg: OntologyPackage, objectKey: string, actionKey?: string): Array<{ actionKey: string; actionLabel: string; nodeId: string }> {
  const canonicalId = `ontology:${pkg.id}:${objectKey}`;
  return pkg.actions
    .filter((action) => action.boundObject === objectKey && (!actionKey || action.key === actionKey))
    .map((action) => ({
      actionKey: action.key,
      actionLabel: action.label || action.key,
      nodeId: planActionFingerprint({
        packageId: pkg.id,
        packageVersion: pkg.version,
        actionKey: action.key,
        actionVersion: action.version,
        boundObject: action.boundObject,
        canonicalId,
        arguments: {},
      }),
    }));
}

interface ProbeResult {
  actionKey: string;
  actionLabel: string;
  trace?: DecisionChainTrace;
  error?: string;
}

const CHAIN_NODE_KIND_META: Record<DecisionChainNode["kind"], { zh: string; en: string; icon: typeof Beaker }> = {
  hypothesis: { zh: "假设", en: "Hypothesis", icon: Beaker },
  "kernel-run": { zh: "内核运行", en: "Kernel run", icon: Play },
  verdict: { zh: "判定", en: "Verdict", icon: ClipboardList },
  report: { zh: "报告", en: "Report", icon: FileText },
  "action-plan": { zh: "行动计划", en: "Action plan", icon: ClipboardList },
  "action-execution": { zh: "工具执行", en: "Execution", icon: Play },
  "action-receipt": { zh: "行动回执", en: "Receipt", icon: CircleCheck },
  "study-run": { zh: "长跑进行中", en: "Study run", icon: CircleDashed },
};

function shortTime(value: string | undefined, locale: AppLocale): string {
  if (!value) return "—";
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : value;
}

function nodeHeadline(node: DecisionChainNode, locale: AppLocale): { text: string; tone?: "ok" | "bad" | "warn" } {
  switch (node.kind) {
    case "hypothesis":
      return { text: node.node.statementDigest || node.node.hypothesisId };
    case "kernel-run":
      return node.node.goldenMatch === false
        ? { text: `${node.node.resultFingerprint.slice(0, 10)}… · golden 漂移`, tone: "warn" }
        : { text: `${node.node.resultFingerprint.slice(0, 10)}…${node.node.goldenMatch ? " · golden 一致" : ""}` };
    case "verdict": {
      const tone = node.node.verdict === "confirmed" ? "ok" : node.node.verdict === "refuted" ? "bad" : "warn";
      return { text: `${node.node.verdict} · ${node.node.reasonCode} · ${node.node.rationaleDigest}`, tone };
    }
    case "report":
      return { text: node.node.label };
    case "action-plan":
      return { text: node.node.digest };
    case "action-execution":
      return { text: `${tr(locale, "工具", "tool")} ${node.node.toolId}` };
    case "action-receipt": {
      const tone = node.node.status === "executed" ? "ok" : node.node.status === "failed" ? "bad" : "warn";
      return { text: `${node.node.status}${node.node.reasonCode ? ` · ${node.node.reasonCode}` : ""} · ${node.node.digest}`, tone };
    }
    case "study-run":
      return { text: `${node.node.status} · ${node.node.completedRepeats}/${node.node.totalRepeats}`, tone: "warn" };
  }
}

/** 链回放时间线（导出供测试直接渲染）：节点按回放序纵向排，边语义隐含在顺序里。 */
export function DecisionChainTimeline({ trace, locale }: { trace: DecisionChainTrace; locale: AppLocale }) {
  return (
    <ol className="odc-timeline">
      {trace.nodes.map((entry, index) => {
        const meta = CHAIN_NODE_KIND_META[entry.kind];
        const Icon = meta.icon;
        const head = nodeHeadline(entry, locale);
        const time = "registeredAt" in entry.node ? entry.node.registeredAt
          : "executedAt" in entry.node ? entry.node.executedAt
            : "judgedAt" in entry.node ? entry.node.judgedAt
              : "reportedAt" in entry.node ? entry.node.reportedAt
                : "plannedAt" in entry.node ? entry.node.plannedAt
                  : "receiptedAt" in entry.node ? entry.node.receiptedAt : undefined;
        return (
          <li key={`${entry.node.nodeId}-${index}`} className={head.tone ? `is-${head.tone}` : undefined}>
            <span className="odc-timeline-icon"><Icon size={12} /></span>
            <div>
              <strong>{tr(locale, meta.zh, meta.en)}</strong>
              <small title={head.text}>{head.text}</small>
              <small className="odc-time">{shortTime(time, locale)}</small>
            </div>
          </li>
        );
      })}
      {trace.nodes.length === 0 && <li className="is-empty">{tr(locale, "链上没有可回放节点", "No replayable nodes on the chain")}</li>}
    </ol>
  );
}

export function DecisionChainGaps({ trace, locale }: { trace: DecisionChainTrace; locale: AppLocale }) {
  if (trace.gaps.length === 0) return null;
  return (
    <ul className="odc-gaps" role="note">
      {trace.gaps.map((gap, index) => (
        <li key={index}>
          <AlertTriangle size={12} />
          <span><code>{gap.code}</code> {gap.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export function SimilarDecisionsView({ result, locale }: { result: SimilarDecisionsResult; locale: AppLocale }) {
  if (!result.matched) return <p className="odc-subempty">{tr(locale, "无同指纹/同理由码先例（如实为空，不伪造先例）。", "No precedent with the same fingerprint or reason code (honestly empty).")}</p>;
  const verdictTone = (verdict: SimilarDecisionHit["verdict"]) => (verdict === "confirmed" ? "ok" : verdict === "refuted" ? "bad" : "warn");
  return (
    <ul className="odc-hits">
      {result.hits.map((hit) => (
        <li key={hit.verdictNodeId} className={`is-${verdictTone(hit.verdict)}`}>
          <strong>{hit.verdict}</strong>
          <small title={hit.rationaleDigest}>{hit.reasonCode} · {hit.matchedBy === "reason-code" ? tr(locale, "按理由码", "by reason code") : tr(locale, "按指纹", "by fingerprint")} · {shortTime(hit.judgedAt, locale)}</small>
        </li>
      ))}
    </ul>
  );
}

export function DecisionImpactView({ result, locale }: { result: DecisionImpactResult; locale: AppLocale }) {
  const { verdicts, reports } = result.downstream;
  if (verdicts.length === 0 && reports.length === 0) {
    return <p className="odc-subempty">{tr(locale, "下游无引用该锚指纹的判定/报告（影响面如实为空）。", "No downstream verdicts or reports reference this anchor (honestly empty).")}</p>;
  }
  return (
    <div className="odc-impact">
      <span>{tr(locale, `反查键 ${result.fingerprints.length} 个指纹`, `${result.fingerprints.length} fingerprint key(s)`)}</span>
      <ul className="odc-hits">
        {verdicts.map((item) => (
          <li key={item.nodeId} className={item.verdict === "confirmed" ? "is-ok" : item.verdict === "refuted" ? "is-bad" : "is-warn"}>
            <strong>{item.verdict}</strong>
            <small>{item.reasonCode} · {shortTime(item.judgedAt, locale)}</small>
          </li>
        ))}
        {reports.map((item) => (
          <li key={item.nodeId}>
            <strong>{item.label}</strong>
            <small>{shortTime(item.reportedAt, locale)}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

type SubQueryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "similar"; result: SimilarDecisionsResult }
  | { kind: "impact"; result: DecisionImpactResult };

/** 折叠面板本体：展开即探测；行动候选 ≤3，串行探测避免并发抖动。 */
export default function OntologyDecisionChainPanel({ projectId, pkg, objectKey, actionKey, locale }: {
  projectId: string;
  pkg: OntologyPackage | undefined;
  objectKey: string;
  /** 行动节点卡自查：只探测该行动。 */
  actionKey?: string;
  locale: AppLocale;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [probes, setProbes] = useState<Array<{ actionKey: string; actionLabel: string; nodeId: string }>>([]);
  const [results, setResults] = useState<ProbeResult[]>([]);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [subQuery, setSubQuery] = useState<SubQueryState>({ kind: "idle" });
  const runSequence = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; runSequence.current += 1; };
  }, []);

  const runProbes = useCallback(async (candidates: Array<{ actionKey: string; actionLabel: string; nodeId: string }>) => {
    const sequence = ++runSequence.current;
    setPhase("loading");
    setErrorMessage(undefined);
    setSubQuery({ kind: "idle" });
    const collected: ProbeResult[] = [];
    for (const candidate of candidates) {
      try {
        const trace = await api.traceDecisionChain(projectId, candidate.nodeId);
        if (!alive.current || sequence !== runSequence.current) return;
        collected.push({ ...candidate, trace });
      } catch (cause) {
        if (!alive.current || sequence !== runSequence.current) return;
        collected.push({ ...candidate, error: cause instanceof Error ? cause.message : String(cause) });
      }
      setResults([...collected]);
    }
    if (!alive.current || sequence !== runSequence.current) return;
    setPhase("ready");
  }, [projectId]);

  const toggle = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen || phase === "loading" || phase === "ready") return;
    const candidates = pkg ? computeDecisionChainProbes(pkg, objectKey, actionKey) : [];
    setProbes(candidates);
    if (candidates.length === 0) {
      setResults([]);
      setPhase("ready");
      return;
    }
    void runProbes(candidates);
  };

  const firstHit = results.find((item) => item.trace?.anchor.found);
  const firstVerdict = firstHit?.trace?.nodes.find((entry) => entry.kind === "verdict");
  const reasonCode = firstVerdict && firstVerdict.node.kind === "verdict" ? firstVerdict.node.reasonCode : undefined;
  const anchorNodeId = firstHit?.trace?.anchor.nodeId;

  const runSubQuery = async (kind: "similar" | "impact") => {
    const sequence = runSequence.current;
    setSubQuery({ kind: "loading" });
    try {
      if (kind === "similar" && reasonCode) {
        const result = await api.findSimilarDecisions(projectId, { reasonCode, limit: 10 });
        if (alive.current && sequence === runSequence.current) setSubQuery({ kind: "similar", result });
      } else if (kind === "impact" && anchorNodeId) {
        const result = await api.analyzeDecisionImpact(projectId, anchorNodeId);
        if (alive.current && sequence === runSequence.current) setSubQuery({ kind: "impact", result });
      }
    } catch (cause) {
      if (alive.current && sequence === runSequence.current) setSubQuery({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  return (
    <details className="odc-panel" open={open} onToggle={(event) => toggle((event.target as HTMLDetailsElement).open)}>
      <summary>
        <GitCommitHorizontal size={13} />
        <strong>{tr(locale, "AI 决策链", "AI decision chain")}</strong>
        <small>{tr(locale, "账本回放 · 先例 · 影响面", "Ledger replay · precedent · impact")}</small>
        <ChevronDown size={12} className="odc-chevron" />
      </summary>
      <div className="odc-body">
        {phase === "idle" && <p className="odc-subempty">{tr(locale, "展开以回放该对象绑定行动的账本链。", "Expand to replay ledger chains for this object's bound actions.")}</p>}
        {phase === "loading" && <p role="status" className="odc-loading"><LoaderCircle size={12} className="odc-spin" /> {tr(locale, "正在回放决策链…", "Replaying decision chains…")}</p>}
        {phase === "error" && <p role="alert" className="odc-error">{errorMessage}</p>}
        {phase === "ready" && probes.length === 0 && (
          <p className="odc-subempty">{tr(locale, "该对象没有绑定行动，账本侧无决策链探测入口；先在本体工作台为对象绑定行动。", "No actions bound to this object, so there is nothing to probe in the ledger; bind an action in the ontology workspace first.")}</p>
        )}
        {phase === "ready" && results.map((item) => (
          <section key={item.actionKey} className="odc-probe">
            <h5>{item.actionLabel} <code>{item.actionKey}</code></h5>
            {item.error && <p role="alert" className="odc-error">{item.error}</p>}
            {item.trace && !item.trace.anchor.found && (
              <p className="odc-subempty">
                {tr(locale, "账本中无该行动的决策链记录（以空参数计划指纹探测；带参执行的链不会被此探测命中）。", "No decision chain for this action in the ledger (probed by the empty-argument plan fingerprint; chains from parameterized runs will not match this probe).")}
              </p>
            )}
            {item.trace?.anchor.found && (
              <>
                <p className="odc-chain-type">
                  {item.trace.chainType === "action" ? tr(locale, "行动链", "Action chain") : tr(locale, "仿真链", "Verification chain")}
                  · {tr(locale, `锚 ${item.trace.anchor.kind ?? ""}`, `anchor ${item.trace.anchor.kind ?? ""}`)}
                  · {tr(locale, `${item.trace.nodes.length} 节点`, `${item.trace.nodes.length} nodes`)}
                </p>
                <DecisionChainTimeline trace={item.trace} locale={locale} />
                <DecisionChainGaps trace={item.trace} locale={locale} />
              </>
            )}
          </section>
        ))}
        {phase === "ready" && firstHit && (
          <div className="odc-subactions">
            <button type="button" disabled={!reasonCode || subQuery.kind === "loading"} title={reasonCode ? undefined : tr(locale, "链上无判定节点，无法按理由码检索先例", "No verdict on the chain; precedent search needs a reason code")} onClick={() => void runSubQuery("similar")}>
              <History size={12} />
              {tr(locale, "查先例", "Find precedents")}
            </button>
            <button type="button" disabled={!anchorNodeId || subQuery.kind === "loading"} onClick={() => void runSubQuery("impact")}>
              <Network size={12} />
              {tr(locale, "影响面", "Impact")}
            </button>
          </div>
        )}
        {subQuery.kind === "loading" && <p role="status" className="odc-loading"><LoaderCircle size={12} className="odc-spin" /> {tr(locale, "查询中…", "Querying…")}</p>}
        {subQuery.kind === "error" && <p role="alert" className="odc-error">{subQuery.message}</p>}
        {subQuery.kind === "similar" && <SimilarDecisionsView result={subQuery.result} locale={locale} />}
        {subQuery.kind === "impact" && <DecisionImpactView result={subQuery.result} locale={locale} />}
        <p className="odc-footnote">
          {tr(locale, "只读回放：时间与指纹均来自 Provenance 账本，断链如实标注，不伪造连续性。", "Read-only replay: times and fingerprints come from the provenance ledger; broken links are labeled honestly, never stitched.")}
        </p>
      </div>
    </details>
  );
}
