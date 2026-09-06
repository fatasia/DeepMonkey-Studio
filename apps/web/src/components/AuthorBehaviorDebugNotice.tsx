import { useState } from "react";
import { Bug, Copy, Play } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import type { SceneBehaviorManagerEntry } from "../behavior/SceneBehaviorManager";
import "./AuthorBehaviorDebugNotice.css";

/** The browser owns actual pause state and inspection; never infer them from a slow Worker. */
export function AuthorBehaviorDebugNotice({ locale, entries, onStart }: {
  locale: AppLocale;
  entries: readonly SceneBehaviorManagerEntry[];
  onStart: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const entry = entries[0];
  const debug = entry?.diagnostics.authorDebug;
  const ready = Boolean(debug?.awaitingStart && entry?.diagnostics.status === "paused");
  const loading = !entry || entry.diagnostics.status === "initializing";
  const failed = entry?.diagnostics.status === "error";
  return <aside className="author-debug-notice" aria-label={tr(locale, "DevTools 调试会话", "DevTools debug session")}>
    <div className="author-debug-heading">
      <Bug size={14} aria-hidden="true" />
      <strong>{tr(locale, "DevTools 调试", "DevTools debugging")}</strong>
      <span role="status">{tr(locale, failed ? "加载失败，请查看日志" : loading ? "正在加载源码" : ready ? "源码就绪，等待开始执行" : "会话已启动；断点状态见 DevTools", failed ? "Failed; check logs" : loading ? "Loading source" : ready ? "Source ready; waiting to start" : "Session started; pause state is in DevTools")}</span>
      {ready && <button type="button" onClick={onStart}><Play size={13} />{tr(locale, "开始执行", "Start execution")}</button>}
    </div>
    <p>{tr(locale, "在 Chrome / Edge 按 F12 → Sources → Threads，选择 bim-studio-author-debug。打开下面的源码并设置断点，再开始执行；单步、调用栈和变量在 DevTools 查看。", "In Chrome / Edge press F12 → Sources → Threads and select bim-studio-author-debug. Open the source below, set a breakpoint, then start execution. Stepping, call stacks and variables are in DevTools.")}</p>
    {debug && <div className="author-debug-source">
      <input readOnly aria-label={tr(locale, "调试源码文件", "Debug source file")} title={debug.sourceUrl} value={debug.sourceUrl} onFocus={event => event.currentTarget.select()} />
      <button type="button" aria-label={tr(locale, "复制源码文件名", "Copy source filename")} title={tr(locale, "复制源码文件名", "Copy source filename")} onClick={() => {
        setCopyStatus(tr(locale, "正在复制…", "Copying…"));
        void Promise.resolve().then(() => navigator.clipboard.writeText(debug.sourceUrl)).then(
          () => setCopyStatus(tr(locale, "已复制", "Copied")),
          () => setCopyStatus(tr(locale, "复制失败，请选中文件名复制", "Copy failed; select and copy the filename")),
        );
      }}><Copy size={13} /></button>
      <span role="status">{copyStatus}</span>
    </div>}
    <details onKeyDown={event => {
      if (event.key !== "Escape" || !event.currentTarget.open) return;
      event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
      event.currentTarget.querySelector("summary")?.focus();
    }}><summary>{tr(locale, "调试运行说明", "Debug run details")}</summary>
      <p>{tr(locale, `当前为运行副本；修改代码后需重新调试。生命周期开始前可设置断点，顶层代码在加载时执行。源码行号比编辑器多 ${debug?.lineOffset ?? 0} 行。断点等待期间不执行生命周期超时终止；无限循环请点击停止。外部请求保留网关超时。`, `This is a runtime snapshot; restart debugging after editing. Set lifecycle breakpoints before starting; top-level code runs during loading. Source lines have a ${debug?.lineOffset ?? 0}-line offset. Lifecycle watchdogs are suspended; click Stop for an infinite loop. External requests retain gateway timeouts.`)}</p>
    </details>
  </aside>;
}
