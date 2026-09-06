import { useEffect, useRef, useState } from "react";
import { translate as tr, type AppLocale } from "../i18n";
import { useDialogEscape } from "../hooks/useGlobalDialogEscape";
import "./RobotEntryDialog.css";

export function RobotEntryDialog({ locale, name, entries, onSelect }: {
  locale: AppLocale; name: string; entries: string[]; onSelect: (entry: string | undefined) => void;
}) {
  const [selected, setSelected] = useState("");
  const input = useRef<HTMLSelectElement>(null);
  const escape = useDialogEscape(() => onSelect(undefined));
  useEffect(() => {
    const previous = document.activeElement; input.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <div className="dialog-backdrop" ref={escape} onMouseDown={event => { if (event.target === event.currentTarget) onSelect(undefined); }}>
    <section className="dialog robot-entry-dialog" role="dialog" aria-modal="true" aria-label={tr(locale, "选择机器人", "Choose robot")} onKeyDown={event => {
      if (event.key !== "Tab") return;
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>("select,button:not(:disabled)")];
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    }}>
      <h2 title={name}>{tr(locale, "选择机器人", "Choose robot")}</h2>
      <label className="field"><span>{tr(locale, "描述文件", "Description file")}</span>
        <select ref={input} value={selected} onChange={event => setSelected(event.target.value)}>
          <option value="">{tr(locale, "选择 URDF", "Select URDF")}</option>
          {entries.map(entry => <option key={entry} value={entry}>{entry}</option>)}
        </select>
      </label>
      <footer><button className="button" onClick={() => onSelect(undefined)}>{tr(locale, "取消", "Cancel")}</button>
        <button className="button primary" disabled={!entries.includes(selected)} onClick={() => onSelect(selected)}>{tr(locale, "导入", "Import")}</button></footer>
    </section>
  </div>;
}
