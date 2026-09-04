import { useEffect } from "react";
import { Clock3, Download, History, RotateCcw, Trash2 } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { WorkspaceRecoveryDraft } from "../studio/workspaceRecoveryStore";

interface WorkspaceRecoveryDialogProps {
  locale: AppLocale;
  draft: WorkspaceRecoveryDraft;
  serverRevision?: number;
  busy: boolean;
  onRestore: () => void;
  onExport: () => void;
  onDefer: () => void;
  onDiscard: () => void;
}

export function WorkspaceRecoveryDialog(props: WorkspaceRecoveryDialogProps) {
  const t = (zh: string, en: string) => tr(props.locale, zh, en);
  const serverIsNewer = props.serverRevision !== undefined && props.draft.baseRevision !== undefined && props.serverRevision > props.draft.baseRevision;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || props.busy) return;
      event.preventDefault();
      props.onDefer();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.busy, props.onDefer]);
  return (
    <div className="dialog-backdrop workspace-recovery-backdrop">
      <section className="dialog workspace-recovery-dialog" role="dialog" aria-modal="true" aria-label={t("恢复未保存工作", "Recover unsaved work")}>
        <header>
          <i>
            <History size={21} />
          </i>
          <span>
            <h2>{t("恢复未保存修改", "Recover unsaved changes")}</h2>
            <p>
              {props.draft.scene.name} · {new Date(props.draft.savedAt).toLocaleString(props.locale)}
            </p>
          </span>
        </header>
        <div className={serverIsNewer ? "workspace-recovery-warning" : "workspace-recovery-safe"}>
          <strong>{serverIsNewer ? t("服务器已有更新版本", "A newer server version exists") : t("本地修改尚未保存", "Local changes are not saved")}</strong>
          <small>
            {serverIsNewer
              ? t(
                  `本地基于 v${props.draft.baseRevision}，服务器为 v${props.serverRevision}。建议先导出副本，再恢复查看。`,
                  `Local changes use v${props.draft.baseRevision}; the server is v${props.serverRevision}. Export before restoring.`,
                )
              : t("恢复后可继续编辑或保存。", "Restore to continue editing or save.")}
          </small>
        </div>
        <div className="dialog-actions workspace-recovery-actions">
          <button className="button" disabled={props.busy} onClick={props.onDefer} title={t("保留本地副本，先使用服务器版本进入编辑器", "Keep the local copy and continue with the server version") }>
            <Clock3 size={13} />
            {t("稍后处理", "Decide later")}
          </button>
          <button className="button ghost" disabled={props.busy} onClick={props.onDiscard}>
            <Trash2 size={13} />
            {t("丢弃副本", "Discard")}
          </button>
          <button className="button" disabled={props.busy} onClick={props.onExport}>
            <Download size={13} />
            {t("导出副本", "Export copy")}
          </button>
          <button className="button primary" disabled={props.busy} onClick={props.onRestore}>
            <RotateCcw size={13} />
            {t("恢复到当前页", "Restore here")}
          </button>
        </div>
      </section>
    </div>
  );
}
