import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ScriptModule } from "@bim-studio/contracts";
import {
  AlertTriangle,
  CheckCircle2,
  CloudDownload,
  CloudUpload,
  GitBranch,
  GitCommitHorizontal,
  History,
  Link2,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Unlink,
  X,
} from "lucide-react";
import { api, type ScriptGitCommit, type ScriptGitPullResult, type ScriptGitStatus } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import {
  diffScriptSnapshots,
  formatCommitTime,
  hasScriptSnapshotChanges,
  resolveEscapeAction,
  resolveFocusTrapIndex,
  validateCommitMessage,
  validateRemoteDraft,
  type ScriptSnapshotDiff,
} from "./scriptVersionManagerModel";
import "./ScriptVersionManager.css";

export type ScriptVersionClient = Pick<
  typeof api,
  | "getScriptGitStatus"
  | "listScriptGitHistory"
  | "commitScriptSnapshot"
  | "configureScriptGitRemote"
  | "removeScriptGitRemote"
  | "pullScriptGit"
  | "pushScriptGit"
>;

export interface ScriptVersionManagerProps {
  locale: AppLocale;
  projectId?: string;
  scripts: readonly ScriptModule[];
  hasUnappliedDraft?: boolean;
  unavailableReason?: string;
  client?: ScriptVersionClient;
  onReplaceScripts: (scripts: readonly ScriptModule[]) => void | Promise<void>;
  onClose: () => void;
}

type Feedback = { tone: "success" | "warning" | "error"; text: string };
type PendingPull = { result: ScriptGitPullResult; diff: ScriptSnapshotDiff };

/** 版本面板只管理应用行为脚本，不读取、提交或覆盖项目中的其他文件。 */
export function ScriptVersionManager(props: ScriptVersionManagerProps) {
  const client = props.client ?? api;
  const canUseGit = Boolean(props.projectId) && !props.unavailableReason;
  const [status, setStatus] = useState<ScriptGitStatus>();
  const [history, setHistory] = useState<ScriptGitCommit[]>([]);
  const [commitMessage, setCommitMessage] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteBranch, setRemoteBranch] = useState("main");
  const [loading, setLoading] = useState(canUseGit);
  const [busyAction, setBusyAction] = useState("");
  const [confirmRemoveRemote, setConfirmRemoveRemote] = useState(false);
  const [pendingPull, setPendingPull] = useState<PendingPull>();
  const [feedback, setFeedback] = useState<Feedback>();
  const managerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const pullButtonRef = useRef<HTMLButtonElement>(null);
  const confirmDialogRef = useRef<HTMLElement>(null);
  const confirmApplyRef = useRef<HTMLButtonElement>(null);
  const busyActionRef = useRef(busyAction);
  const pendingPullRef = useRef(pendingPull);
  const onCloseRef = useRef(props.onClose);

  busyActionRef.current = busyAction;
  pendingPullRef.current = pendingPull;
  onCloseRef.current = props.onClose;

  useEffect(() => {
    if (!canUseGit || !props.projectId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([client.getScriptGitStatus(props.projectId), client.listScriptGitHistory(props.projectId)])
      .then(([nextStatus, nextHistory]) => {
        if (cancelled) return;
        applyStatus(nextStatus, setStatus, setRemoteUrl, setRemoteBranch);
        setHistory(nextHistory);
      })
      .catch((reason) => !cancelled && setFeedback({ tone: "error", text: errorMessage(reason, tr(props.locale, "脚本版本状态读取失败", "Failed to read script version status")) }))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [canUseGit, client, props.locale, props.projectId]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyActionRef.current) {
        const action = resolveEscapeAction(Boolean(pendingPullRef.current), Boolean(busyActionRef.current));
        if (action === "none") return;
        event.preventDefault();
        if (action === "cancel-pull") {
          setPendingPull(undefined);
          queueMicrotask(() => pullButtonRef.current?.focus());
        } else {
          onCloseRef.current();
        }
        return;
      }
      if (event.key !== "Tab") return;
      const focusRoot = pendingPullRef.current ? confirmDialogRef.current : managerRef.current;
      trapKeyboardFocus(event, focusRoot);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (pendingPull) confirmApplyRef.current?.focus();
  }, [pendingPull]);

  const remoteConfigured = status?.remote.configured === true;
  const hasCommit = history.length > 0;
  const statusMessage = useMemo(() => {
    if (!status) return "";
    if (!status.clean) return tr(props.locale, `Git 工作区有 ${status.changes.length} 项待处理`, `Git workspace has ${status.changes.length} pending changes`);
    return status.initialized
      ? tr(props.locale, "脚本仓库正常", "Script repository ready")
      : tr(props.locale, "提交首个快照后创建仓库", "Commit the first snapshot to create the repository");
  }, [props.locale, status]);

  async function refreshHistory() {
    if (!props.projectId) return;
    setHistory(await client.listScriptGitHistory(props.projectId));
  }

  async function commitScripts(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!props.projectId || guardUnappliedDraft()) return;
    const validationError = validateCommitMessage(commitMessage);
    if (validationError) return setFeedback({ tone: "warning", text: validationError });
    setBusyAction("commit");
    setFeedback(undefined);
    try {
      const result = await client.commitScriptSnapshot(props.projectId, props.scripts, commitMessage.trim());
      setStatus(result.status);
      await refreshHistory();
      setCommitMessage("");
      setFeedback({
        tone: "success",
        text: result.committed
          ? tr(props.locale, `已提交 ${result.commit?.shortHash ?? "新快照"}`, `Committed ${result.commit?.shortHash ?? "new snapshot"}`)
          : tr(props.locale, "脚本与最新快照一致，无需重复提交", "Scripts already match the latest snapshot"),
      });
    } catch (reason) {
      setFeedback({ tone: "error", text: errorMessage(reason, tr(props.locale, "提交脚本快照失败", "Failed to commit script snapshot")) });
    } finally {
      setBusyAction("");
    }
  }

  async function configureRemote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!props.projectId) return;
    const validationError = validateRemoteDraft(remoteUrl, remoteBranch);
    if (validationError) return setFeedback({ tone: "warning", text: validationError });
    setBusyAction("remote");
    setFeedback(undefined);
    try {
      setStatus(await client.configureScriptGitRemote(props.projectId, remoteUrl.trim(), remoteBranch.trim()));
      setConfirmRemoveRemote(false);
      setFeedback({ tone: "success", text: tr(props.locale, "远端已配置；凭据由系统 Git 凭据管理器或 SSH 管理", "Remote configured; credentials stay in the system Git manager or SSH") });
    } catch (reason) {
      setFeedback({ tone: "error", text: errorMessage(reason, tr(props.locale, "远端配置失败", "Failed to configure remote")) });
    } finally {
      setBusyAction("");
    }
  }

  async function removeRemote() {
    if (!props.projectId) return;
    setBusyAction("remove-remote");
    try {
      setStatus(await client.removeScriptGitRemote(props.projectId));
      setConfirmRemoveRemote(false);
      setFeedback({ tone: "success", text: tr(props.locale, "已移除远端配置，本地提交历史保留", "Remote removed; local history was preserved") });
    } catch (reason) {
      setFeedback({ tone: "error", text: errorMessage(reason, tr(props.locale, "移除远端失败", "Failed to remove remote")) });
    } finally {
      setBusyAction("");
    }
  }

  async function pullScripts() {
    if (!props.projectId || guardUnappliedDraft()) return;
    setBusyAction("pull");
    setFeedback(undefined);
    try {
      const result = await client.pullScriptGit(props.projectId);
      setStatus(result.status);
      await refreshHistory();
      const diff = diffScriptSnapshots(props.scripts, result.scripts);
      if (hasScriptSnapshotChanges(diff)) {
        setPendingPull({ result, diff });
        setFeedback({ tone: "warning", text: tr(props.locale, "远端脚本已完成安全校验，请确认后再替换当前项目脚本", "Remote scripts passed validation; confirm before replacing project scripts") });
      } else {
        setFeedback({ tone: "success", text: tr(props.locale, "当前项目脚本已与远端一致", "Project scripts already match the remote") });
      }
    } catch (reason) {
      setFeedback({ tone: "error", text: errorMessage(reason, tr(props.locale, "拉取远端脚本失败", "Failed to pull remote scripts")) });
    } finally {
      setBusyAction("");
    }
  }

  async function applyPulledScripts() {
    if (!pendingPull || guardUnappliedDraft()) return;
    setBusyAction("apply-pull");
    try {
      await props.onReplaceScripts(pendingPull.result.scripts);
      const count = pendingPull.result.scripts.length;
      setPendingPull(undefined);
      setFeedback({ tone: "success", text: tr(props.locale, `已替换并保存 ${count} 个项目脚本`, `Replaced and saved ${count} project scripts`) });
    } catch (reason) {
      setFeedback({ tone: "error", text: errorMessage(reason, tr(props.locale, "项目保存失败，原脚本已恢复", "Project save failed; original scripts were restored")) });
    } finally {
      setBusyAction("");
    }
  }

  async function pushScripts() {
    if (!props.projectId || guardUnappliedDraft()) return;
    setBusyAction("push");
    setFeedback(undefined);
    try {
      const result = await client.pushScriptGit(props.projectId);
      setStatus(result.status);
      setFeedback({ tone: "success", text: result.pushed ? tr(props.locale, "脚本提交已推送到远端", "Script commits pushed to remote") : tr(props.locale, "没有需要推送的提交", "No commits to push") });
    } catch (reason) {
      setFeedback({ tone: "error", text: errorMessage(reason, tr(props.locale, "推送脚本失败", "Failed to push scripts")) });
    } finally {
      setBusyAction("");
    }
  }

  function guardUnappliedDraft(): boolean {
    if (!props.hasUnappliedDraft) return false;
    setFeedback({ tone: "warning", text: tr(props.locale, "请先应用当前编辑器中的修改，再执行版本操作", "Apply the current editor changes before using version control") });
    return true;
  }

  return (
    <div className="script-version-overlay">
      <aside ref={managerRef} className="script-version-manager" role="dialog" aria-modal="true" aria-labelledby="script-version-title" tabIndex={-1}>
        <header className="script-version-header">
          <span><GitBranch size={17} /></span>
          <div>
            <strong id="script-version-title">{tr(props.locale, "脚本版本", "Script versions")}</strong>
            <small>{tr(props.locale, "只跟踪脚本编辑器中的多个脚本，不提交场景与资源", "Tracks editor scripts only; scenes and assets are excluded")}</small>
          </div>
          <button ref={closeButtonRef} type="button" aria-label={tr(props.locale, "关闭脚本版本", "Close script versions")} title={tr(props.locale, "关闭脚本版本", "Close script versions")} disabled={Boolean(busyAction)} onClick={props.onClose}><X size={15} /></button>
        </header>

        {props.unavailableReason || !props.projectId ? (
          <div className="script-version-unavailable" role="status">
            <AlertTriangle size={18} />
            <div><strong>{tr(props.locale, "脚本 Git 当前不可用", "Script Git is unavailable")}</strong><p>{props.unavailableReason ?? tr(props.locale, "请先保存项目，再创建脚本版本。", "Save the project before creating script versions.")}</p></div>
          </div>
        ) : loading ? (
          <div className="script-version-loading" role="status"><LoaderCircle className="spin" size={16} />{tr(props.locale, "正在读取脚本版本", "Loading script versions")}</div>
        ) : (
          <>
            <section className="script-version-status" aria-label={tr(props.locale, "脚本仓库状态", "Script repository status")}>
              <div><small>{tr(props.locale, "分支", "Branch")}</small><strong><GitBranch size={12} />{status?.branch ?? "main"}</strong></div>
              <div><small>{tr(props.locale, "本地", "Local")}</small><strong className={status?.clean === false ? "warning" : "ready"}>{status?.clean === false ? <AlertTriangle size={12} /> : <ShieldCheck size={12} />}{statusMessage}</strong></div>
              <div><small>{tr(props.locale, "同步", "Sync")}</small><strong>{tr(props.locale, `领先 ${status?.ahead ?? 0} · 落后 ${status?.behind ?? 0}`, `Ahead ${status?.ahead ?? 0} · behind ${status?.behind ?? 0}`)}</strong></div>
            </section>

            {props.hasUnappliedDraft && <div className="script-version-draft-warning"><AlertTriangle size={14} />{tr(props.locale, "编辑器有未应用修改；提交、拉取和推送已暂停。", "The editor has unapplied changes; commit, pull and push are paused.")}</div>}

            <form className="script-version-commit" onSubmit={(event) => void commitScripts(event)}>
              <header><div><GitCommitHorizontal size={15} /><span><strong>{tr(props.locale, "本地提交", "Local commit")}</strong><small>{tr(props.locale, `${props.scripts.length} 个脚本将作为一个可追溯快照`, `${props.scripts.length} scripts will be one traceable snapshot`)}</small></span></div></header>
              <div>
                <label><span>{tr(props.locale, "修改说明", "Change summary")}</span><input value={commitMessage} maxLength={200} placeholder={tr(props.locale, "例如：完善 AGV 路线控制", "Example: refine AGV route control")} disabled={Boolean(busyAction)} onChange={(event) => setCommitMessage(event.target.value)} /></label>
                <button className="primary" type="submit" disabled={Boolean(busyAction) || props.hasUnappliedDraft}>{busyAction === "commit" ? <LoaderCircle className="spin" size={13} /> : <GitCommitHorizontal size={13} />}{tr(props.locale, "提交快照", "Commit snapshot")}</button>
              </div>
            </form>

            <form className="script-version-remote" onSubmit={(event) => void configureRemote(event)}>
              <header>
                <div><Link2 size={15} /><span><strong>{tr(props.locale, "远端同步（可选）", "Remote sync (optional)")}</strong><small>{remoteConfigured ? tr(props.locale, "已连接远端；不会强制覆盖历史", "Remote connected; history is never force-overwritten") : tr(props.locale, "支持公司 Git 服务与离线局域网 Git", "Supports company Git and offline LAN Git")}</small></span></div>
                <b className={remoteConfigured ? "configured" : ""}>{remoteConfigured ? tr(props.locale, "已配置", "Configured") : tr(props.locale, "未配置", "Not configured")}</b>
              </header>
              <div className="script-version-remote-fields">
                <label><span>{tr(props.locale, "远端地址", "Remote URL")}</span><input type="text" value={remoteUrl} placeholder="https://git.example.com/team/scripts.git" disabled={Boolean(busyAction)} onChange={(event) => setRemoteUrl(event.target.value)} /></label>
                <label><span>{tr(props.locale, "分支", "Branch")}</span><input type="text" value={remoteBranch} placeholder="main" disabled={Boolean(busyAction)} onChange={(event) => setRemoteBranch(event.target.value)} /></label>
              </div>
              <small className="script-version-credential-note">{tr(props.locale, "地址中不保存密码；HTTPS 凭据和 SSH 密钥由系统 Git 管理。", "Passwords are not stored in URLs; system Git manages HTTPS credentials and SSH keys.")}</small>
              <div className="script-version-remote-actions">
                <button type="submit" disabled={Boolean(busyAction)}>{busyAction === "remote" ? <LoaderCircle className="spin" size={13} /> : <Link2 size={13} />}{remoteConfigured ? tr(props.locale, "更新配置", "Update") : tr(props.locale, "保存配置", "Save")}</button>
                <button ref={pullButtonRef} type="button" disabled={Boolean(busyAction) || !remoteConfigured || !hasCommit || props.hasUnappliedDraft} onClick={() => void pullScripts()}><CloudDownload size={13} />{tr(props.locale, "拉取", "Pull")}</button>
                <button type="button" disabled={Boolean(busyAction) || !remoteConfigured || !hasCommit || props.hasUnappliedDraft} onClick={() => void pushScripts()}><CloudUpload size={13} />{tr(props.locale, "推送", "Push")}</button>
                {remoteConfigured && (confirmRemoveRemote ? <span className="script-version-remove-confirm"><button className="danger" type="button" disabled={Boolean(busyAction)} onClick={() => void removeRemote()}>{tr(props.locale, "确认移除", "Confirm remove")}</button><button type="button" disabled={Boolean(busyAction)} onClick={() => setConfirmRemoveRemote(false)}>{tr(props.locale, "取消", "Cancel")}</button></span> : <button className="danger push-right" type="button" disabled={Boolean(busyAction)} onClick={() => setConfirmRemoveRemote(true)}><Unlink size={13} />{tr(props.locale, "移除远端", "Remove remote")}</button>)}
              </div>
            </form>

            {feedback && <div className={`script-version-feedback ${feedback.tone}`} role="status" aria-live="polite">{feedback.tone === "success" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}{feedback.text}</div>}

            <section className="script-version-history">
              <header><div><History size={15} /><strong>{tr(props.locale, "提交历史", "Commit history")}</strong></div><button type="button" aria-label={tr(props.locale, "刷新提交历史", "Refresh commit history")} title={tr(props.locale, "刷新提交历史", "Refresh commit history")} disabled={Boolean(busyAction)} onClick={() => void refreshHistory().catch((reason) => setFeedback({ tone: "error", text: errorMessage(reason, tr(props.locale, "历史刷新失败", "Failed to refresh history")) }))}><RefreshCw size={13} /></button></header>
              <div>
                {history.map((commit) => <article key={commit.hash}><code>{commit.shortHash}</code><span><strong>{commit.message}</strong><small>{commit.author} · {formatCommitTime(commit.committedAt)}</small></span></article>)}
                {!history.length && <div className="script-version-empty"><GitCommitHorizontal size={24} /><strong>{tr(props.locale, "还没有脚本快照", "No script snapshots yet")}</strong><span>{tr(props.locale, "填写修改说明并提交，之后即可比较和远端同步。", "Add a change summary and commit to enable history and remote sync.")}</span></div>}
              </div>
            </section>
          </>
        )}

        {pendingPull && <PullConfirmation locale={props.locale} pending={pendingPull} busy={busyAction === "apply-pull"} dialogRef={confirmDialogRef} applyRef={confirmApplyRef} onCancel={() => { setPendingPull(undefined); setFeedback({ tone: "warning", text: tr(props.locale, "已保留当前项目脚本，远端结果尚未应用", "Current project scripts were kept; remote result was not applied") }); }} onApply={() => void applyPulledScripts()} />}
      </aside>
    </div>
  );
}

function PullConfirmation(props: { locale: AppLocale; pending: PendingPull; busy: boolean; dialogRef: React.RefObject<HTMLElement | null>; applyRef: React.RefObject<HTMLButtonElement | null>; onCancel: () => void; onApply: () => void }) {
  const { diff } = props.pending;
  const incomingCount = props.pending.result.scripts.length;
  return <div className="script-version-confirm-layer">
    <section ref={props.dialogRef} className="script-version-confirm" role="alertdialog" aria-modal="true" aria-labelledby="script-pull-confirm-title" aria-describedby="script-pull-confirm-description">
      <span><AlertTriangle size={19} /></span>
      <div><strong id="script-pull-confirm-title">{tr(props.locale, "确认整体替换当前脚本？", "Replace all current scripts?")}</strong><p id="script-pull-confirm-description">{tr(props.locale, `远端快照包含 ${incomingCount} 个脚本。确认后会新增 ${diff.added.length}、更新 ${diff.updated.length}、删除 ${diff.removed.length} 个脚本，并立即保存项目。`, `The remote snapshot has ${incomingCount} scripts. This will add ${diff.added.length}, update ${diff.updated.length}, remove ${diff.removed.length}, and save the project.`)}</p></div>
      <ScriptChangeList locale={props.locale} label={tr(props.locale, "新增", "Add")} tone="added" scripts={diff.added} />
      <ScriptChangeList locale={props.locale} label={tr(props.locale, "更新", "Update")} tone="updated" scripts={diff.updated} />
      <ScriptChangeList locale={props.locale} label={tr(props.locale, "删除", "Remove")} tone="removed" scripts={diff.removed} />
      <small>{tr(props.locale, "只替换脚本；2D、3D、拓扑、资源和项目依赖不受影响。保存失败会恢复原脚本。", "Only scripts are replaced. 2D, 3D, topology, assets, and dependencies stay unchanged. A failed save restores the original scripts.")}</small>
      <footer><button type="button" disabled={props.busy} onClick={props.onCancel}>{tr(props.locale, "保留当前脚本", "Keep current scripts")}</button><button ref={props.applyRef} className="danger-primary" type="button" disabled={props.busy} onClick={props.onApply}>{props.busy ? <LoaderCircle className="spin" size={13} /> : <CloudDownload size={13} />}{tr(props.locale, "确认替换并保存", "Replace and save")}</button></footer>
    </section>
  </div>;
}

function ScriptChangeList(props: { locale: AppLocale; label: string; tone: string; scripts: readonly ScriptModule[] }) {
  if (!props.scripts.length) return null;
  const names = props.scripts.slice(0, 5).map((script) => script.name).join("、");
  const remainder = props.scripts.length - 5;
  return <p className={`script-version-change-list ${props.tone}`}><b>{props.label} {props.scripts.length}</b><span>{names}{remainder > 0 ? tr(props.locale, ` 等 ${remainder} 个`, ` and ${remainder} more`) : ""}</span></p>;
}

function applyStatus(status: ScriptGitStatus, setStatus: (status: ScriptGitStatus) => void, setUrl: React.Dispatch<React.SetStateAction<string>>, setBranch: React.Dispatch<React.SetStateAction<string>>): void {
  setStatus(status);
  if (!status.remote.configured) return;
  const remote = status.remote;
  setUrl((current) => current || remote.url);
  setBranch((current) => current === "main" ? remote.branch : current);
}

function trapKeyboardFocus(event: KeyboardEvent, root?: HTMLElement | null): void {
  if (!root) return;
  const selector = "button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex='-1'])";
  const focusable = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
  if (!focusable.length) return event.preventDefault();
  const index = focusable.indexOf(document.activeElement as HTMLElement);
  const targetIndex = resolveFocusTrapIndex(focusable.length, index, event.shiftKey);
  const target = targetIndex === undefined ? undefined : focusable[targetIndex];
  if (target) { event.preventDefault(); target.focus(); }
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message.trim() ? reason.message : fallback;
}
