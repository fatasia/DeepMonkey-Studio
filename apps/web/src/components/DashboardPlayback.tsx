import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Pause, Play, Terminal, X } from "lucide-react";
import { api } from "../api";
import type { JsonValue } from "@bim-studio/contracts";
import { ApplicationPlaybackSession } from "../behavior/ApplicationPlaybackSession";
import { PlaybackContext } from "../behavior/playbackContext";
import { loadScriptDependencyModules, type ScriptDependencyReader } from "../behavior/scriptDependencyRuntime";
import { translate as tr } from "../i18n";
import { DashboardRuntimePreview } from "./DashboardRuntimePreview";
import { useDashboardMetrics, type DashboardMetric } from "./DashboardWidgetRuntime";
import "./DashboardPlayback.css";

type Props = ComponentProps<typeof DashboardRuntimePreview> & { readDependency?: ScriptDependencyReader };
const NO_WIDGETS: never[] = [];

/** Preview mounts a fresh disposable session; closing never saves runtime mutations. */
export function DashboardPlayback(props: Props) {
  const initial = useRef(props);
  const [session, setSession] = useState<ApplicationPlaybackSession>();
  const [, refresh] = useState(0);
  useEffect(() => {
    const { application, page, variables, filters, project, readOnly, readDependency } = initial.current;
    const next = new ApplicationPlaybackSession(application, page.id, {
      project, variables, filters, protectedDataEnabled: !readOnly,
      hostOptions: {
        executeNetworkRequest: async ({ binding, variables: requestVariables }) => {
          if (readOnly) throw new Error("公开页未启用受保护数据网关，请联系发布者配置发布授权。");
          const result = await api.executeDirectBinding(binding, requestVariables);
          return { ok: true, status: result.status, data: result.data as JsonValue, value: result.value as JsonValue };
        },
        executeCapabilityRequest: async ({ capabilityId, input }) => {
          if (readOnly) throw new Error("公开页未启用 AI 网关，请联系发布者配置发布授权。");
          return JSON.parse(JSON.stringify(await api.invokeCapability(application.metadata.projectId, capabilityId, input, "script-runtime")));
        },
      },
    });
    let frame = 0;
    let last = performance.now();
    let lastPaint = 0;
    let changed = true;
    next.onChange = () => { changed = true; };
    const advance = (now: number) => {
      next.advance(now - last);
      last = now;
      // Diagnostics do not make the whole dashboard render at Worker tick rate.
      if (changed && now - lastPaint >= 100) { refresh((value) => value + 1); changed = false; lastPaint = now; }
      frame = requestAnimationFrame(advance);
    };
    setSession(next);
    void next.start(() => loadScriptDependencyModules(application.metadata.projectId, application.scriptDependencies ?? [], readDependency ?? api.readScriptDependency));
    frame = requestAnimationFrame(advance);
    return () => { cancelAnimationFrame(frame); next.dispose(); };
  }, []);
  useEffect(() => session?.selectPage(props.page.id), [session, props.page.id]);
  if (!session) return <div role="status">{tr(props.locale, "正在进入预览…", "Opening preview…")}</div>;
  return <PlaybackContext.Provider value={session}><PlaybackView {...props} session={session} /></PlaybackContext.Provider>;
}

export function PlaybackView({ session, ...props }: Props & { session: ApplicationPlaybackSession }) {
  const { document: application, variables, filters } = session.state;
  const page = application.pages.find((page) => page.id === props.page.id) ?? application.pages[0]!;
  const widgets = useMemo(() => page.nodes.flatMap((node) => node.kind === "data-widget" ? [node.widget] : []), [page.nodes]);
  const live = useDashboardMetrics(application.metadata.projectId, props.readOnly ? NO_WIDGETS : widgets, undefined, filters, !props.readOnly, props.project.semanticModels);
  useEffect(() => {
    const updates = Object.fromEntries(Object.entries(live.metrics).filter(([, metric]) => metric.value !== undefined).map(([key, metric]) => [key, JSON.parse(JSON.stringify(metric.value)) as JsonValue]));
    session.setVariables(updates);
  }, [session, live.metrics]);
  const metrics = useMemo<Record<string, DashboardMetric>>(() => ({ ...props.metrics, ...live.metrics, ...Object.fromEntries(Object.entries(variables).map(([key, value]) => [key, { ...live.metrics[key], value, samples: live.metrics[key]?.samples ?? [] }])) }), [props.metrics, live.metrics, variables]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const errors = session.entries.filter((entry) => entry.diagnostics.status === "error");
  const logErrors = session.logs.filter((entry) => entry.level === "error");
  const failed = errors.length + logErrors.length;
  const active = session.entries.filter((entry) => entry.diagnostics.status === "running" || entry.diagnostics.status === "paused").length;
  const label = session.loading ? tr(props.locale, "正在自动加载", "Loading scripts") : failed ? tr(props.locale, `${failed} 项运行错误`, `${failed} runtime errors`) : tr(props.locale, session.paused ? `已暂停 · ${active} 个脚本` : `自动运行 · ${active} 个脚本`, session.paused ? `Paused · ${active} scripts` : `Auto · ${active} scripts`);
  return <DashboardRuntimePreview {...props} application={application} page={page} variables={variables} filters={filters} metrics={metrics} connected={live.connected || props.connected}
      onFilterChange={(key, value) => session.state.setFilter(key, value)}
      onVariableChange={(key, value) => session.setVariables({ [key]: value })}
      onSelectionChange={() => undefined}
      onNodeInteraction={(id, trigger = "click", payload) => session.interact({ source: { kind: "widget", id }, trigger, selectSource: false, timestamp: new Date().toISOString(), ...(payload === undefined ? {} : { payload }) })}
      onObjectInteraction={(sceneId, trigger, target) => {
        if (target.kind !== "object") return;
        const timestamp = new Date().toISOString();
        session.dispatchEvent({ type: "object.event", name: trigger, target: { kind: "object", sceneId, objectId: target.modelId }, timestamp });
        session.interact({ source: { kind: "object", sceneId, modelId: target.modelId }, trigger, timestamp });
      }}>
    <aside className={`playback-status ${failed ? "has-errors" : ""}`} aria-label={tr(props.locale, "预览脚本运行状态", "Preview script status")}>
      <span role="status">{label}</span>
      <button type="button" disabled={!active} onClick={() => session.togglePause()} aria-label={tr(props.locale, session.paused ? "继续生命周期" : "暂停生命周期", session.paused ? "Resume lifecycle" : "Pause lifecycle")} title={tr(props.locale, "暂停或继续生命周期调度，不是代码断点", "Pause or resume lifecycle scheduling, not a code breakpoint")}>
        {session.paused ? <Play size={14} /> : <Pause size={14} />}
      </button>
      <button type="button" onClick={() => setConsoleOpen((open) => !open)} aria-expanded={consoleOpen} aria-label={tr(props.locale, "运行日志", "Runtime logs")}><Terminal size={14} /></button>
    </aside>
    {consoleOpen && <aside className="playback-console" aria-label={tr(props.locale, "运行日志", "Runtime logs")}>
      <header><strong>{tr(props.locale, "运行日志", "Runtime logs")}</strong><small>{tr(props.locale, "运行态不写入草稿", "Runtime changes are not saved")}</small><button type="button" onClick={() => setConsoleOpen(false)} aria-label={tr(props.locale, "关闭运行日志", "Close runtime logs")}><X size={14} /></button></header>
      <div>{!session.logs.length && !errors.length && <p>{tr(props.locale, "暂无日志。使用 ctx.log 输出运行信息。", "No logs. Use ctx.log to inspect runtime information.")}</p>}
        {errors.map(({ module, diagnostics }) => <p className="error" key={module.id}><b>{module.name}</b> {diagnostics.lastError}{diagnostics.lastErrorLocation && ` · ${diagnostics.lastErrorLocation.line}:${diagnostics.lastErrorLocation.column}`}</p>)}
        {session.logs.map((entry, index) => <p className={entry.level} key={index}><b>{application.scripts.find((script) => script.id === entry.moduleId)?.name ?? entry.moduleId}</b> {entry.message}{entry.data !== undefined && <code>{JSON.stringify(entry.data)}</code>}</p>)}
      </div>
    </aside>}
  </DashboardRuntimePreview>;
}
