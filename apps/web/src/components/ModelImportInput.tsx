import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ACCEPTED_MODELS } from "../appDefaults";
import { translate as tr, type AppLocale } from "../i18n";
import { selectRobotImports } from "../robots/robotImportSelection";
import { RobotEntryDialog } from "./RobotEntryDialog";

interface Choice { name: string; entries: string[]; resolve: (entry: string | undefined) => void }

/** 三个模型入口共享同一选择流程，取消和切项目都不能提交先前文件。 */
export function ModelImportInput({ inputRef, locale, scopeKey, multiple, onFiles }: {
  inputRef: RefObject<HTMLInputElement | null>;
  locale: AppLocale;
  scopeKey: string | undefined;
  multiple?: boolean;
  onFiles: (files: File[], entries: ReadonlyMap<File, string>) => Promise<void>;
}) {
  const [choice, setChoice] = useState<Choice>();
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const version = useRef(0);
  const pendingChoice = useRef<Choice | undefined>(undefined);
  useEffect(() => {
    setChoice(undefined); setReading(false); setError("");
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
      if (entries) await onFiles(files, entries);
    } catch (reason) {
      if (version.current === ticket) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (version.current === ticket) setReading(false); }
  }
  return <>
    <input ref={inputRef} hidden multiple={multiple} type="file" accept={ACCEPTED_MODELS} onChange={event => {
      const files = [...(event.target.files ?? [])]; event.target.value = ""; void select(files);
    }} />
    {reading && !choice && <span role="status">{tr(locale, "正在导入…", "Importing…")}</span>}
    {error && <span role="alert">{error}</span>}
    {choice && createPortal(<RobotEntryDialog locale={locale} name={choice.name} entries={choice.entries} onSelect={settle} />, document.body)}
  </>;
}
