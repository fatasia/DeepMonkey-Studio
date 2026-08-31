import { AlertTriangle, CheckCircle2, ChevronDown, CircleHelp, Unlink } from "lucide-react";
import { useState } from "react";
import type { SmartBindingCandidate, SmartBindingEvidenceFactor } from "@bim-studio/studio-core";
import { translate as tr, type AppLocale } from "../i18n";
import { candidateKey, type SmartBindingWorkbenchView } from "./smartAssetBindingWorkbenchModel";

interface SmartAssetBindingResultsProps {
  locale: AppLocale;
  view: SmartBindingWorkbenchView;
  selectedKeys: ReadonlySet<string>;
  onToggle: (candidate: SmartBindingCandidate, selected: boolean) => void;
}

export function SmartAssetBindingResults(props: SmartAssetBindingResultsProps) {
  const unmatchedCount = props.view.unmatchedSceneObjects.length + props.view.unmatchedDevices.length;
  return (
    <div className="smart-binding-results">
      <div className="smart-binding-metrics" aria-label={tr(props.locale, "匹配结果概览", "Binding result summary")}>
        <Metric tone="strong" value={props.view.strongCandidates.length} label={tr(props.locale, "强候选", "Strong")} />
        <Metric tone="review" value={props.view.reviewCandidates.length} label={tr(props.locale, "待复核", "Review")} />
        <Metric tone="conflict" value={props.view.conflicts.length} label={tr(props.locale, "冲突", "Conflicts")} />
        <Metric tone="muted" value={unmatchedCount} label={tr(props.locale, "未匹配", "Unmatched")} />
      </div>

      <CandidateGroup
        locale={props.locale}
        title={tr(props.locale, "强候选", "Strong candidates")}
        description={tr(props.locale, "高置信且不存在一对一冲突，已预选但仍需确认。", "High confidence without one-to-one conflicts; preselected but not yet confirmed.")}
        tone="strong"
        candidates={props.view.strongCandidates}
        view={props.view}
        selectedKeys={props.selectedKeys}
        onToggle={props.onToggle}
      />
      <CandidateGroup
        locale={props.locale}
        title={tr(props.locale, "待复核", "Needs review")}
        description={tr(props.locale, "证据不足或存在竞争关系，默认不勾选。", "Evidence is limited or contested; not selected by default.")}
        tone="review"
        candidates={props.view.reviewCandidates}
        view={props.view}
        selectedKeys={props.selectedKeys}
        onToggle={props.onToggle}
      />
      <ConflictGroup locale={props.locale} view={props.view} />
      <UnmatchedGroup locale={props.locale} view={props.view} />
    </div>
  );
}

function Metric(props: { tone: string; value: number; label: string }) {
  return <div className={`smart-binding-metric ${props.tone}`}><strong>{props.value}</strong><span>{props.label}</span></div>;
}

function CandidateGroup(props: SmartAssetBindingResultsProps & {
  title: string;
  description: string;
  tone: "strong" | "review";
  candidates: SmartBindingCandidate[];
  view: SmartBindingWorkbenchView;
}) {
  const [visible, setVisible] = useState(80);
  return (
    <section className={`smart-binding-group ${props.tone}`}>
      <header>
        <span>{props.tone === "strong" ? <CheckCircle2 size={15} /> : <CircleHelp size={15} />}</span>
        <div><strong>{props.title}</strong><small>{props.description}</small></div>
        <b>{props.candidates.length}</b>
      </header>
      <div className="smart-binding-candidate-list">
        {props.candidates.slice(0, visible).map((candidate) => (
          <CandidateRow key={candidateKey(candidate)} {...props} candidate={candidate} />
        ))}
        {props.candidates.length === 0 && <EmptyLine locale={props.locale} />}
      </div>
      {visible < props.candidates.length && (
        <button type="button" className="smart-binding-load-more" onClick={() => setVisible((value) => value + 80)}>
          {tr(props.locale, `再显示 ${Math.min(80, props.candidates.length - visible)} 条`, `Show ${Math.min(80, props.candidates.length - visible)} more`)}
        </button>
      )}
    </section>
  );
}

function CandidateRow(props: SmartAssetBindingResultsProps & { candidate: SmartBindingCandidate; view: SmartBindingWorkbenchView }) {
  const { candidate } = props;
  const selected = props.selectedKeys.has(candidateKey(candidate));
  return (
    <article className={`smart-binding-candidate ${selected ? "selected" : ""}`}>
      <div className="smart-binding-candidate-main">
        <input
          type="checkbox"
          checked={selected}
          onChange={(event) => props.onToggle(candidate, event.target.checked)}
          aria-label={tr(props.locale, `选择 ${candidate.deviceId} 映射`, `Select mapping ${candidate.deviceId}`)}
        />
        <span className="smart-binding-pair">
          <strong title={props.view.sceneNames.get(candidate.sceneObjectId)}>{props.view.sceneNames.get(candidate.sceneObjectId) ?? candidate.sceneObjectId}</strong>
          <small>{candidate.sceneObjectId}</small>
        </span>
        <span className="smart-binding-arrow">→</span>
        <span className="smart-binding-pair">
          <strong title={props.view.deviceNames.get(candidate.deviceId)}>{props.view.deviceNames.get(candidate.deviceId) ?? candidate.deviceId}</strong>
          <small>{candidate.deviceId}</small>
        </span>
        <b>{formatPercent(candidate.confidence)}</b>
      </div>
      <details className="smart-binding-evidence">
        <summary><ChevronDown size={12} />{tr(props.locale, "查看五因子证据", "View five-factor evidence")}</summary>
        <div>{candidate.evidence.map((factor) => <EvidenceFactor key={factor.factor} locale={props.locale} factor={factor} />)}</div>
      </details>
    </article>
  );
}

function EvidenceFactor(props: { locale: AppLocale; factor: SmartBindingEvidenceFactor }) {
  const label = factorLabel(props.locale, props.factor.factor);
  return (
    <span className={!props.factor.available ? "unavailable" : ""}>
      <i style={{ "--factor-score": `${props.factor.score * 100}%` } as React.CSSProperties} />
      <b>{label}</b>
      <em>{props.factor.available ? formatPercent(props.factor.score) : "—"}</em>
      <small>{props.factor.explanation}</small>
    </span>
  );
}

function ConflictGroup(props: { locale: AppLocale; view: SmartBindingWorkbenchView }) {
  const [visible, setVisible] = useState(50);
  return (
    <section className="smart-binding-group conflict">
      <header><span><AlertTriangle size={15} /></span><div><strong>{tr(props.locale, "冲突", "Conflicts")}</strong><small>{tr(props.locale, "稳定算法已给出暂定解析，仍必须人工复核。", "A deterministic winner is shown, but human review is mandatory.")}</small></div><b>{props.view.conflicts.length}</b></header>
      <div className="smart-binding-conflict-list">
        {props.view.conflicts.slice(0, visible).map((conflict, index) => (
          <details key={`${conflict.type}-${conflict.sceneObjectIds.join("-")}-${index}`}>
            <summary><span>{conflict.type === "device-contended" ? tr(props.locale, "设备竞争", "Device contested") : tr(props.locale, "候选接近", "Close candidates")}</span><small>{conflict.explanation}</small></summary>
            <p>{tr(props.locale, "场景对象", "Scene objects")}: {conflict.sceneObjectIds.map((id) => props.view.sceneNames.get(id) ?? id).join("、")}</p>
            <p>{tr(props.locale, "设备/测点", "Devices/points")}: {conflict.deviceIds.map((id) => props.view.deviceNames.get(id) ?? id).join("、")}</p>
          </details>
        ))}
        {props.view.conflicts.length === 0 && <EmptyLine locale={props.locale} />}
      </div>
      {visible < props.view.conflicts.length && <button type="button" className="smart-binding-load-more" onClick={() => setVisible((value) => value + 50)}>{tr(props.locale, "显示更多冲突", "Show more conflicts")}</button>}
    </section>
  );
}

function UnmatchedGroup(props: { locale: AppLocale; view: SmartBindingWorkbenchView }) {
  const count = props.view.unmatchedSceneObjects.length + props.view.unmatchedDevices.length;
  return (
    <details className="smart-binding-group unmatched">
      <summary><span><Unlink size={15} /></span><div><strong>{tr(props.locale, "未匹配", "Unmatched")}</strong><small>{tr(props.locale, "默认收起，避免低价值明细干扰校核。", "Collapsed by default to keep low-value details out of the review flow.")}</small></div><b>{count}</b></summary>
      <div className="smart-binding-unmatched-list">
        {props.view.unmatchedSceneObjects.slice(0, 100).map((item) => <span key={item.sceneObjectId}><strong>{item.name}</strong><small>{item.reason === "lost-one-to-one-conflict" ? tr(props.locale, "一对一冲突未胜出", "Lost one-to-one conflict") : tr(props.locale, "没有达到最低置信度", "Below minimum confidence")} · {formatPercent(item.confidence)}</small></span>)}
        {props.view.unmatchedDevices.slice(0, 100).map((item) => <span key={item.deviceId}><strong>{item.name}</strong><small>{item.deviceId}</small></span>)}
        {count > 200 && <p>{tr(props.locale, `仅显示前 200 项，其余 ${count - 200} 项请缩小范围查看。`, `Showing the first 200; narrow the scope to inspect the remaining ${count - 200}.`)}</p>}
        {count === 0 && <EmptyLine locale={props.locale} />}
      </div>
    </details>
  );
}

function EmptyLine(props: { locale: AppLocale }) {
  return <p className="smart-binding-empty-line">{tr(props.locale, "当前没有记录", "No records")}</p>;
}

function factorLabel(locale: AppLocale, factor: SmartBindingEvidenceFactor["factor"]): string {
  const labels = {
    "stable-identifier": ["稳定标识", "Stable ID"],
    name: ["名称", "Name"],
    space: ["空间", "Space"],
    category: ["类别", "Category"],
    distance: ["距离", "Distance"],
  } as const;
  return tr(locale, labels[factor][0], labels[factor][1]);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
