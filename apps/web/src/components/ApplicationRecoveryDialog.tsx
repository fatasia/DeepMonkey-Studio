import { useDialogEscape } from "../hooks/useGlobalDialogEscape";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { useApplicationRecovery } from "../hooks/useApplicationRecovery";

export function ApplicationRecoveryDialog({ recovery, locale }: { recovery: ReturnType<typeof useApplicationRecovery>; locale: AppLocale }) {
  const escapeRef = useDialogEscape(recovery.defer, recovery.busy);
  const draft = recovery.draft;
  if (!draft) return null;
  const t = (zh: string, en: string) => tr(locale, zh, en);
  return <div className="dialog-backdrop workspace-recovery-backdrop" ref={escapeRef}>
    <section className="dialog workspace-recovery-dialog" role="dialog" aria-modal="true" aria-label={t("恢复应用修改", "Recover application changes")}>
      <h2>{t("恢复应用修改", "Recover application changes")}</h2>
      <p>{draft.document.metadata.name} · {new Date(draft.savedAt).toLocaleString(locale)}</p>
      <p>{t("本地副本包含页面、拓扑和脚本修改。恢复后可检查并手动保存。", "The local copy contains page, topology and script edits. Review and save after restoring.")}</p>
      <div className="dialog-actions workspace-recovery-actions">
        <button className="button" disabled={recovery.busy} onClick={recovery.defer}>{t("稍后处理", "Decide later")}</button>
        <button className="button ghost" disabled={recovery.busy} onClick={() => void recovery.discard()}>{t("丢弃副本", "Discard")}</button>
        <button className="button" disabled={recovery.busy} onClick={recovery.export}>{t("导出副本", "Export copy")}</button>
        <button className="button primary" disabled={recovery.busy} onClick={() => void recovery.restore()}>{t("恢复修改", "Restore")}</button>
      </div>
    </section>
  </div>;
}
