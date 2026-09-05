import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { ScriptModule } from "@bim-studio/contracts";
import type { SceneBehaviorManagerEntry } from "../behavior/SceneBehaviorManager";
import { filterBehaviorLogs, type BehaviorLogEntry } from "../behavior/behaviorLogModel";
import { translate as tr, type AppLocale } from "../i18n";
import "./BehaviorConsole.css";

export function BehaviorConsole(props: {
  locale: AppLocale;
  logs: readonly BehaviorLogEntry[];
  entries: readonly SceneBehaviorManagerEntry[];
  scripts: readonly ScriptModule[];
  selectedId: string | undefined;
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
  onReveal: (moduleId: string, location: { line: number; column: number }) => void;
}) {
  const [scope, setScope] = useState("all");
  const [level, setLevel] = useState<BehaviorLogEntry["level"] | "all">("all");
  const [search, setSearch] = useState("");
  const [collapse, setCollapse] = useState(false);
  const logs = useMemo<BehaviorLogEntry[]>(() => [...props.logs, ...props.entries.flatMap(({ module, diagnostics }) => diagnostics.lastError ? [{
    id: `runtime:${module.id}`, moduleId: module.id, level: "error" as const,
    message: diagnostics.lastError, timestamp: "", location: diagnostics.lastErrorLocation ?? { line: 1, column: 1 },
  }] : [])], [props.logs, props.entries]);
  const visible = useMemo(() => filterBehaviorLogs(logs, { ...(scope === "current" && props.selectedId ? { moduleId: props.selectedId } : {}), level, search, collapse }), [logs, scope, props.selectedId, level, search, collapse]);
  const errors = logs.filter((entry) => entry.level === "error").length;
  return <footer className="behavior-console">
    <header>
      <button type="button" className="behavior-console-toggle" onClick={props.onToggle} aria-expanded={props.open}>
        {props.open ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        <strong>{tr(props.locale, "运行日志", "Runtime log")}</strong><span>{logs.length}</span>
        {errors > 0 && <b className="behavior-console-errors">{tr(props.locale, `${errors} 个错误`, `${errors} errors`)}</b>}
      </button>
      <button type="button" onClick={props.onClear} title={tr(props.locale, "清空日志；当前运行错误保留至修复重跑", "Clear logs; active runtime errors remain until rerun")}>{tr(props.locale, "清空", "Clear")}</button>
    </header>
    {props.open && <div className="behavior-console-content">
      <div className="behavior-console-filters">
        <select aria-label={tr(props.locale, "日志范围", "Log scope")} value={scope} onChange={(event) => setScope(event.target.value)}>
          <option value="all">{tr(props.locale, "全部脚本", "All scripts")}</option><option value="current">{tr(props.locale, "当前脚本", "Current script")}</option>
        </select>
        <select aria-label={tr(props.locale, "日志等级", "Log level")} value={level} onChange={(event) => setLevel(event.target.value as typeof level)}>
          <option value="all">{tr(props.locale, "全部等级", "All levels")}</option><option value="error">{tr(props.locale, "错误", "Error")}</option><option value="warn">{tr(props.locale, "警告", "Warning")}</option><option value="info">{tr(props.locale, "信息", "Info")}</option><option value="debug">{tr(props.locale, "调试", "Debug")}</option>
        </select>
        <input type="search" aria-label={tr(props.locale, "搜索运行日志", "Search runtime logs")} placeholder={tr(props.locale, "搜索日志与数据", "Search logs and data")} value={search} onChange={(event) => setSearch(event.target.value)} />
        <label><input type="checkbox" checked={collapse} onChange={(event) => setCollapse(event.target.checked)} />{tr(props.locale, "折叠重复", "Collapse")}</label>
      </div>
      <div className="behavior-console-rows" role="log" aria-live="off">
        {visible.map((entry) => <p key={entry.id} className={entry.level}>
          <time>{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "—"}</time>
          <span>
            <small>{props.scripts.find((script) => script.id === entry.moduleId)?.name ?? entry.moduleId}</small>
            {entry.location ? <button type="button" className="behavior-console-source" onClick={() => props.onReveal(entry.moduleId, entry.location!)}>{entry.message} · {entry.location.line}:{entry.location.column}</button> : <span>{entry.message}</span>}
            {entry.data !== undefined && <code>{JSON.stringify(entry.data)}</code>}
          </span>
          {entry.count > 1 && <b className="behavior-log-repeat">×{entry.count}</b>}
        </p>)}
        {!visible.length && <small>{logs.length ? tr(props.locale, "没有匹配的日志，请调整筛选。", "No matching logs. Adjust filters.") : tr(props.locale, "预览会自动加载脚本；作者试运行用 Ctrl+Enter，ctx.log 可输出变量。", "Preview loads scripts automatically. Use Ctrl+Enter for a test run and ctx.log to inspect values.")}</small>}
      </div>
    </div>}
  </footer>;
}
