import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ACCEPTED_MODELS } from "../appDefaults";
import { translate as tr, type AppLocale } from "../i18n";
import { selectRobotImports } from "../robots/robotImportSelection";
import { useDialogEscape } from "../hooks/useGlobalDialogEscape";
import { RobotEntryDialog } from "./RobotEntryDialog";
import { RvtImportSettings, type RvtImportSettingsProps } from "./RvtImportSettings";

interface Choice { name: string; entries: string[]; resolve: (entry: string | undefined) => void }
interface PendingImport { files: File[]; entries: ReadonlyMap<File, string>; ticket: number }

/** 三个模型入口共享同一选择流程，取消和切项目都不能提交先前文件。 */
export function ModelImportInput({ inputRef, locale, scopeKey, multiple, onFiles, rvtSettings, accept=ACCEPTED_MODELS }: {
  inputRef: RefObject<HTMLInputElement | null>;
  locale: AppLocale;
  scopeKey: string | undefined;
  multiple?: boolean;
  accept?:string;
  onFiles: (files: File[], entries: ReadonlyMap<File, string>) => Promise<unknown>;
  rvtSettings?: Omit<RvtImportSettingsProps, "locale">;
}) {
  const [choice, setChoice] = useState<Choice>();
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [pendingImport, setPendingImport] = useState<PendingImport>();
  const version = useRef(0);
  const pendingChoice = useRef<Choice | undefined>(undefined);
  useEffect(() => {
    setChoice(undefined); setPendingImport(undefined); setReading(false); setError("");
    return () => { version.current++; pendingChoice.current?.resolve(undefined); pendingChoice.current = undefined; };
  }, [scopeKey]);
  function settle(entry: string | undefined) {
    const pending = pendingChoice.current;
    pendingChoice.current = undefined; setChoice(undefined); pending?.resolve(entry);
  }
  async function select(files: File[]) {
    if (!files.length) return;
    const ticket = ++version.current;
    pendingChoice.current?.resolve(undefined); pendingChoice.current = undefined;
    setChoice(undefined); setError(""); setReading(true);
    const current = () => { if (version.current !== ticket) throw new DOMException("已取消", "AbortError"); };
    try {
      const entries = await selectRobotImports(files, (file, paths) => new Promise(resolve => {
        current();
        const next = { name: file.name, entries: paths, resolve };
        pendingChoice.current = next; setChoice(next);
      }), current);
      current();
      if (entries && rvtSettings && files.some((file) => /\.rvt$/i.test(file.name))) {
        setPendingImport({ files, entries, ticket });
      } else if (entries) await onFiles(files, entries);
    } catch (reason) {
      if (version.current === ticket) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (version.current === ticket) setReading(false); }
  }
  const pendingImportEscapeRef = useDialogEscape(() => setPendingImport(undefined), reading);
  async function confirmPendingImport() {
    const pending = pendingImport;
    if (!pending || pending.ticket !== version.current) return;
    setReading(true); setError("");
    try {
      await onFiles(pending.files, pending.entries);
      if (pending.ticket === version.current) setPendingImport(undefined);
    } catch (reason) {
      if (pending.ticket === version.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (pending.ticket === version.current) setReading(false);
    }
  }
  return <>
    <input ref={inputRef} hidden multiple={multiple} type="file" accept={accept} onChange={event => {
      const files = [...(event.target.files ?? [])]; event.target.value = ""; void select(files);
    }} />
    {reading && !choice && <span role="status">{tr(locale, "正在导入…", "Importing…")}</span>}
    {error && <span role="alert">{error}</span>}
    {choice && createPortal(<RobotEntryDialog locale={locale} name={choice.name} entries={choice.entries} onSelect={settle} />, document.body)}
    {pendingImport && rvtSettings && createPortal(
      <div className="dialog-backdrop" data-escape-dialog="" ref={pendingImportEscapeRef} onMouseDown={() => { if (!reading) setPendingImport(undefined); }}>
        <section className="dialog scene-import-settings-dialog" role="dialog" aria-modal="true" aria-label={tr(locale, "RVT 导入设置", "RVT import settings")} onMouseDown={(event) => event.stopPropagation()}>
          <span className="eyebrow">RVT / REVIT</span>
          <h2>{tr(locale, "确认导入设置", "Confirm import settings")}</h2>
          <p title={pendingImport.files.map((file) => file.name).join("、")}>{tr(locale, `将导入 ${pendingImport.files.length} 个文件；RVT 使用以下转换设置。`, `Importing ${pendingImport.files.length} file(s); RVT files use these conversion settings.`)}</p>
          <RvtImportSettings locale={locale} {...rvtSettings} />
          {error && <p className="scene-import-settings-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="button" disabled={reading} onClick={() => setPendingImport(undefined)}>{tr(locale, "取消", "Cancel")}</button>
            <button type="button" className="button primary" disabled={reading} onClick={() => void confirmPendingImport()}>{reading ? tr(locale, "正在导入…", "Importing…") : tr(locale, "开始导入", "Import")}</button>
          </div>
        </section>
      </div>,
      document.body,
    )}
  </>;
}
