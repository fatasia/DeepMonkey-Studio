import {
  AlertTriangle, Ban, Camera, CheckCircle2, CircleHelp, ClipboardList, FileCheck2, LoaderCircle,
  Minus, Pencil, Play, Plus, ShieldCheck, Undo2, X, Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { translate as tr, type AppLocale } from "../i18n";
import type { SceneDiffEntry, SceneDiffKind } from "../ai/sceneEditState";
import type { SceneEditRound, SceneEditSession, SceneEditSessionStatus } from "../ai/sceneEditSession";
import "./SceneEditLoopCard.css";

type Tone = "success" | "warning" | "danger" | "info" | "accent" | "muted";

const STATUS: Record<SceneEditSessionStatus, { tone: Tone; zh: string; en: string }> = {
  proposing: { tone: "accent", zh: "生成方案中", en: "Drafting plan" },
  "awaiting-approval": { tone: "warning", zh: "待确认", en: "Awaiting approval" },
  "plan-only": { tone: "info", zh: "仅计划", en: "Plan only" },
  applying: { tone: "accent", zh: "应用中", en: "Applying" },
  verifying: { tone: "accent", zh: "验证中", en: "Verifying" },
  achieved: { tone: "success", zh: "已达成", en: "Achieved" },
  unachieved: { tone: "danger", zh: "未达成", en: "Not achieved" },
  unverified: { tone: "warning", zh: "未验证", en: "Unverified" },
  failed: { tone: "danger", zh: "失败", en: "Failed" },
  cancelled: { tone: "muted", zh: "已取消", en: "Cancelled" },
  undone: { tone: "muted", zh: "已撤销", en: "Undone" },
};
const KIND: Record<SceneDiffKind, { icon: ReactNode; zh: string; en: string }> = {
  add: { icon: <Plus size={11} aria-hidden="true" />, zh: "新增", en: "Add" },
  modify: { icon: <Pencil size={11} aria-hidden="true" />, zh: "修改", en: "Modify" },
  delete: { icon: <Minus size={11} aria-hidden="true" />, zh: "删除", en: "Delete" },
  action: { icon: <Zap size={11} aria-hidden="true" />, zh: "动作", en: "Action" },
};
const RUNNING = new Set<SceneEditSessionStatus>(["proposing", "applying", "verifying"]);

function StatusIcon({ status }: { status: SceneEditSessionStatus }) {
  if (RUNNING.has(status)) return <LoaderCircle className="scene-edit-spin" size={16} aria-hidden="true" />;
  if (status === "achieved") return <CheckCircle2 size={16} aria-hidden="true" />;
  if (status === "unachieved" || status === "failed") return <AlertTriangle size={16} aria-hidden="true" />;
  if (status === "unverified") return <CircleHelp size={16} aria-hidden="true" />;
  if (status === "awaiting-approval") return <ShieldCheck size={16} aria-hidden="true" />;
  if (status === "plan-only") return <ClipboardList size={16} aria-hidden="true" />;
  if (status === "undone") return <Undo2 size={16} aria-hidden="true" />;
  return <Ban size={16} aria-hidden="true" />;
}

function DiffRow({ entry, locale }: { entry: SceneDiffEntry; locale: AppLocale }) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const kind = KIND[entry.kind];
  return (
    <li className={`scene-edit-diff-row kind-${entry.kind}${entry.noop ? " is-noop" : ""}`}>
      <span className="scene-edit-kind">{kind.icon}{t(kind.zh, kind.en)}</span>
      <strong title={entry.subject}>{entry.subject}</strong>
      {entry.irreversible && <em className="scene-edit-flag"><AlertTriangle size={10} aria-hidden="true" />{t("不可撤销", "Not undoable")}</em>}
      {entry.noop && <em className="scene-edit-flag muted">{t("无变化", "No change")}</em>}
      {entry.fields.length > 0 && (
        <dl>
          {entry.fields.map((field) => (
            <div key={field.key}>
              <dt>{field.label}</dt>
              <dd>{field.before !== undefined && <><s>{field.before}</s><span aria-hidden="true">→</span></>}<b>{field.after}</b></dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

const roundTitle = (round: SceneEditRound, session: SceneEditSession, locale: AppLocale) => round.index === 1 ? tr(locale, "改动方案", "Plan") : tr(locale, `修正方案 ${round.index - 1}/${session.maxCorrections}`, `Correction ${round.index - 1}/${session.maxCorrections}`);

function RoundView(props: { locale: AppLocale; round: SceneEditRound; session: SceneEditSession; busy: boolean; isLast: boolean; onApprove: () => void; onReject: () => void }) {
  const { round, session, locale } = props;
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const title = roundTitle(round, session, locale);
  const waiting = props.isLast && (round.status === "awaiting-approval" || round.status === "plan-only");
  const applied = round.applied;
  const failedChecks = applied?.checks.filter((check) => !check.ok) ?? [];
  const verdict = round.verdict;
  return (
    <section className={`scene-edit-round status-${round.status}`} aria-label={title}>
      <header><strong>{title}</strong>{round.fingerprint && <code title={t("命令批指纹", "Command batch fingerprint")}>{round.fingerprint}</code>}</header>
      {round.status === "proposing" && <div className="scene-edit-skeleton" aria-hidden="true"><i /><i /><i /></div>}
      {round.summary && <p className="scene-edit-summary">{round.summary}</p>}
      {round.diff && (
        <>
          <p className="scene-edit-counts" aria-label={t("改动统计", "Change counts")}>
            {(["add", "modify", "delete", "action"] as const).filter((kind) => round.diff!.counts[kind] > 0).map((kind) => (
              <span key={kind} className={`kind-${kind}`}>{KIND[kind].icon}{t(KIND[kind].zh, KIND[kind].en)} {round.diff!.counts[kind]}</span>
            ))}
          </p>
          <ol className="scene-edit-diff">{round.diff.entries.map((entry) => <DiffRow key={entry.commandId} entry={entry} locale={locale} />)}</ol>
        </>
      )}
      {round.error && <p className="scene-edit-error" role="alert"><AlertTriangle size={13} aria-hidden="true" /><span>{round.error}</span></p>}
      {round.confirmReason && <p className="scene-edit-note"><ShieldCheck size={12} aria-hidden="true" />{round.confirmReason}</p>}
      {waiting && (
        <div className="scene-edit-actions">
          <p className="scene-edit-note">{round.status === "plan-only"
            ? t("只出计划:尚未改动场景。确认后才会应用,整批可一键撤销。", "Plan only: the scene is untouched. Applying is atomic and undoable in one step.")
            : t("应用整批为一次撤销单元;任一命令失败将整体回滚。", "Applied as one undo unit; any failure rolls the whole batch back.")}</p>
          <button type="button" disabled={props.busy} onClick={props.onReject}><X size={13} aria-hidden="true" />{t("放弃", "Discard")}</button>
          <button type="button" className="primary" disabled={props.busy} onClick={props.onApprove}><Play size={13} aria-hidden="true" />{t("应用改动", "Apply changes")}</button>
        </div>
      )}
      {applied && (
        <div className="scene-edit-observe">
          {(applied.beforeShot || applied.afterShot) && (
            <div className="scene-edit-shots">
              {([["beforeShot", t("应用前", "Before")], ["afterShot", t("应用后", "After")]] as const).map(([key, caption]) => applied[key] && (
                <figure key={key}>
                  <img src={applied[key]!.dataUrl} alt={t(`${caption}视口截图`, `${caption} viewport screenshot`)} />
                  <figcaption><Camera size={10} aria-hidden="true" />{caption}<small>{applied[key]!.metrics.width}×{applied[key]!.metrics.height} · {applied[key]!.metrics.fingerprint.slice(0, 8)}</small></figcaption>
                </figure>
              ))}
            </div>
          )}
          {!applied.afterShot && <p className="scene-edit-note"><Camera size={12} aria-hidden="true" />{t("视口截图不可用,仅基于对象状态核对。", "Viewport capture unavailable; verified from object state only.")}</p>}
          {applied.checks.length > 0 && (
            <details className="scene-edit-checks" open={failedChecks.length > 0}>
              <summary><FileCheck2 size={13} aria-hidden="true" />{t("状态核对", "State checks")}<span>{applied.checks.length - failedChecks.length}/{applied.checks.length}</span></summary>
              <ul>{applied.checks.map((check) => (
                <li key={check.key} className={check.ok ? "ok" : "bad"}>
                  {check.ok ? <CheckCircle2 size={12} aria-hidden="true" /> : <AlertTriangle size={12} aria-hidden="true" />}
                  <span>{check.label}</span><b>{check.ok ? t("一致", "Match") : t("不一致", "Mismatch")}</b>
                  {!check.ok && <small>{t("预期", "Expected")} {check.expected} · {t("实际", "Actual")} {check.actual}</small>}
                </li>
              ))}</ul>
            </details>
          )}
        </div>
      )}
      {verdict && (
        <p className={`scene-edit-verdict outcome-${verdict.outcome}`} role="status">
          {verdict.outcome === "achieved" ? <CheckCircle2 size={14} aria-hidden="true" /> : verdict.outcome === "unachieved" ? <AlertTriangle size={14} aria-hidden="true" /> : <CircleHelp size={14} aria-hidden="true" />}
          <span><strong>{verdict.outcome === "achieved" ? t("达成", "Achieved") : verdict.outcome === "unachieved" ? t("未达成", "Not achieved") : t("未验证", "Unverified")}</strong>
            <small>{verdict.reason}<em>{verdict.source === "model" ? t("模型自检", "Model check") : t("确定性核对", "Deterministic check")}</em></small></span>
        </p>
      )}
      {round.undone && <p className={`scene-edit-note${round.undone.ok && round.undone.restored ? " ok" : ""}`}><Undo2 size={12} aria-hidden="true" />{round.undone.ok ? (round.undone.restored ? t("已撤销,作者状态已校验还原", "Undone; authoring state verified restored") : round.undone.message ?? t("已撤销", "Undone")) : round.undone.message}</p>}
    </section>
  );
}

export function SceneEditLoopCard(props: {
  locale: AppLocale;
  session: SceneEditSession;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onCancel: () => void;
  onUndo: () => void;
  onNew: () => void;
}) {
  const { session, locale } = props;
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const status = STATUS[session.status];
  const running = RUNNING.has(session.status);
  const undoable = session.rounds.filter((round) => round.applied?.undoable && !round.undone).length;
  const last = session.rounds.at(-1);
  return (
    <div className="scene-edit-loop">
      <header className={`scene-edit-status tone-${status.tone}`} aria-live="polite">
        <span><StatusIcon status={session.status} /></span>
        <div><strong>{t(status.zh, status.en)}</strong><small title={session.objective}>{session.objective}</small></div>
        <em title={t("修正轮次上限", "Correction round limit")}>{t(`第 ${Math.max(1, session.rounds.length)} 轮 · 修正上限 ${session.maxCorrections}`, `Round ${Math.max(1, session.rounds.length)} · max ${session.maxCorrections} corrections`)}</em>
      </header>
      {session.rounds.map((round, index) => {
        const isLast = index === session.rounds.length - 1;
        const view = <RoundView key={round.index} locale={locale} round={round} session={session} busy={props.busy} isLast={isLast} onApprove={props.onApprove} onReject={props.onReject} />;
        if (isLast) return view;
        // 较早的轮次折叠为一行,保持卡片长度可控;展开可复核完整差异与观测。
        return (
          <details key={round.index} className="scene-edit-fold">
            <summary><strong>{roundTitle(round, session, locale)}</strong><span>{round.summary}</span>
              <em className={`outcome-${round.verdict?.outcome ?? "none"}`}>{round.undone?.ok ? t("已撤销", "Undone") : round.verdict ? (round.verdict.outcome === "achieved" ? t("达成", "Achieved") : round.verdict.outcome === "unachieved" ? t("未达成", "Not achieved") : t("未验证", "Unverified")) : t("未应用", "Not applied")}</em></summary>
            {view}
          </details>
        );
      })}
      {session.error && !last?.error && <p className="scene-edit-error" role="alert"><AlertTriangle size={13} aria-hidden="true" /><span>{session.error}</span></p>}
      {session.audit && (session.audit.recorded > 0 || session.audit.failed > 0) && (
        <p className={`scene-edit-note${session.audit.failed ? " warn" : ""}`} role="status">
          {session.audit.failed ? <AlertTriangle size={12} aria-hidden="true" /> : <ShieldCheck size={12} aria-hidden="true" />}
          {session.audit.failed
            ? t(`审计记录失败 ${session.audit.failed} 条(改动不受影响,请检查服务端)`, `Audit write failed for ${session.audit.failed} record(s); the edit itself is unaffected`)
            : t(`已写入审计链 ${session.audit.recorded} 条`, `Recorded ${session.audit.recorded} audit record(s)`)}
        </p>
      )}
      <footer className="scene-edit-footer">
        {running && <button type="button" onClick={props.onCancel}><X size={13} aria-hidden="true" />{t("取消", "Cancel")}</button>}
        {!running && undoable > 0 && (
          <button type="button" disabled={props.busy} onClick={props.onUndo} title={t("倒序撤销本任务已应用的各轮改动并校验还原", "Undo every applied round in reverse and verify restoration")}>
            <Undo2 size={13} aria-hidden="true" />{undoable > 1 ? t(`撤销全部改动(${undoable} 轮)`, `Undo all changes (${undoable} rounds)`) : t("撤销改动", "Undo changes")}
          </button>
        )}
        {!running && <button type="button" disabled={props.busy} onClick={props.onNew}>{t("新任务", "New task")}</button>}
      </footer>
    </div>
  );
}
