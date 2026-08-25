import { useEffect, useMemo, useState } from "react";
import type { ApplicationScriptLifecycle, ApplicationScriptPermission, ScriptModule } from "@bim-studio/contracts";
import type { SceneCapability } from "@bim-studio/scene-sdk";
import { AlertTriangle, Braces, CircleStop, Pause, Play, Plus, RotateCcw, Save, Trash2, X } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { SceneBehaviorManagerEntry } from "../behavior/SceneBehaviorManager";

export interface SceneBehaviorLogEntry {
  id: string;
  moduleId: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp: string;
}

const lifecycleOptions: ApplicationScriptLifecycle[] = ["onStart", "onUpdate", "onFixedUpdate", "onData", "onEvent", "onStop", "onDispose"];
const permissionOptions: ApplicationScriptPermission[] = ["scene.read", "scene.write", "data.read", "data.write", "network.connect"];
const capabilityOptions: SceneCapability[] = ["studio.scene", "studio.object", "studio.mesh", "studio.material", "studio.camera", "studio.animation", "studio.data", "studio.runtime"];

export function SceneBehaviorPanel(props: {
  locale: AppLocale;
  scripts: readonly ScriptModule[];
  runtimeEntries: readonly SceneBehaviorManagerEntry[];
  logs: readonly SceneBehaviorLogEntry[];
  paused: boolean;
  onUpsert: (script: ScriptModule) => void;
  onDelete: (scriptId: string) => void;
  onRun: () => void;
  onPauseResume: () => void;
  onStop: () => void;
  onClearLogs: () => void;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState(props.scripts[0]?.id ?? "");
  const selected = props.scripts.find((script) => script.id === selectedId) ?? props.scripts[0];
  const [draft, setDraft] = useState<ScriptModule | undefined>(() => selected ? structuredClone(selected) : undefined);
  useEffect(() => {
    if (!selected && props.scripts[0]) setSelectedId(props.scripts[0].id);
    setDraft(selected ? structuredClone(selected) : undefined);
  }, [selected?.id, selected?.code, selected?.name, selected?.enabled, selected?.lifecycle.join("|"), selected?.permissions.join("|"), selected?.capabilities.join("|")]);
  const dirty = Boolean(selected && draft && JSON.stringify(selected) !== JSON.stringify(draft));
  const runtime = selected ? props.runtimeEntries.find((entry) => entry.module.id === selected.id) : undefined;
  const selectedLogs = useMemo(() => selected ? props.logs.filter((entry) => entry.moduleId === selected.id) : props.logs, [props.logs, selected?.id]);

  function addScript() {
    const id = `behavior:${crypto.randomUUID()}`;
    const script: ScriptModule = {
      id,
      name: tr(props.locale, "新建行为", "New behavior"),
      enabled: true,
      apiVersion: "1.0",
      entrypoint: "behavior",
      runtime: "worker-sandbox",
      code: defaultBehaviorCode(),
      lifecycle: ["onStart", "onUpdate", "onDispose"],
      capabilities: ["studio.object", "studio.runtime"],
      permissions: ["scene.read", "scene.write"]
    };
    props.onUpsert(script);
    setSelectedId(id);
  }

  function toggleListValue<T extends string>(key: "lifecycle" | "permissions" | "capabilities", value: T) {
    if (!draft) return;
    const current = draft[key] as string[];
    setDraft({ ...draft, [key]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] });
  }

  return <section className="behavior-panel" aria-label={tr(props.locale, "场景行为脚本", "Scene behavior scripts")}>
    <header className="behavior-panel-header">
      <div><span><Braces size={16} /></span><div><strong>{tr(props.locale, "行为脚本", "Behavior scripts")}</strong><small>{tr(props.locale, "Worker 隔离 · Scene SDK 命令 · 固定时间步", "Worker isolation · Scene SDK commands · fixed timestep")}</small></div></div>
      <nav>
        <button onClick={props.onRun}><Play size={13} />{props.runtimeEntries.length ? tr(props.locale, "重新运行", "Restart") : tr(props.locale, "运行已启用", "Run enabled")}</button>
        <button disabled={!props.runtimeEntries.length} onClick={props.onPauseResume}>{props.paused ? <Play size={13} /> : <Pause size={13} />}{props.paused ? tr(props.locale, "继续", "Resume") : tr(props.locale, "暂停", "Pause")}</button>
        <button disabled={!props.runtimeEntries.length} onClick={props.onStop}><CircleStop size={13} />{tr(props.locale, "停止", "Stop")}</button>
        <button className="icon-button" aria-label={tr(props.locale, "关闭行为脚本", "Close behavior scripts")} onClick={props.onClose}><X size={14} /></button>
      </nav>
    </header>
    <div className="behavior-panel-body">
      <aside className="behavior-script-list">
        <button className="behavior-add" onClick={addScript}><Plus size={13} />{tr(props.locale, "新建行为", "New behavior")}</button>
        {props.scripts.map((script) => {
          const entry = props.runtimeEntries.find((candidate) => candidate.module.id === script.id);
          return <button key={script.id} className={script.id === selected?.id ? "selected" : ""} onClick={() => setSelectedId(script.id)}><i className={entry?.diagnostics.status ?? (script.enabled ? "idle" : "disabled")} /><span><strong>{script.name}</strong><small>{entry ? runtimeStatus(entry.diagnostics.status, props.locale) : script.enabled ? tr(props.locale, "未运行", "Not running") : tr(props.locale, "已禁用", "Disabled")}</small></span></button>;
        })}
        {!props.scripts.length && <div className="behavior-empty"><Braces size={22} /><strong>{tr(props.locale, "还没有行为脚本", "No behavior scripts yet")}</strong><span>{tr(props.locale, "创建后可通过公开 Scene SDK 控制对象、相机和动画。", "Create one to control objects, cameras and animation through the public Scene SDK.")}</span></div>}
      </aside>
      {draft ? <>
        <main className="behavior-editor">
          <div className="behavior-editor-toolbar">
            <label><span>{tr(props.locale, "名称", "Name")}</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label className="behavior-enabled"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />{tr(props.locale, "启用", "Enabled")}</label>
            <button disabled={!dirty || !draft.name.trim()} onClick={() => props.onUpsert(draft)}><Save size={13} />{tr(props.locale, "应用修改", "Apply changes")}</button>
            <button disabled={!dirty} onClick={() => setDraft(structuredClone(selected!))}><RotateCcw size={13} />{tr(props.locale, "还原", "Revert")}</button>
            <button className="danger" onClick={() => { if (window.confirm(tr(props.locale, `删除“${draft.name}”吗？`, `Delete “${draft.name}”?`))) props.onDelete(draft.id); }}><Trash2 size={13} /></button>
          </div>
          <textarea className="behavior-code" spellCheck={false} value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value })} aria-label={tr(props.locale, "行为脚本代码", "Behavior script code")} />
          <footer><span>JavaScript · Scene SDK 1.0</span><span>{draft.code.split("\n").length} {tr(props.locale, "行", "lines")}</span>{dirty && <em>{tr(props.locale, "有未应用的修改", "Unapplied changes")}</em>}</footer>
        </main>
        <aside className="behavior-inspector">
          <section><strong>{tr(props.locale, "生命周期", "Lifecycle")}</strong><div className="behavior-option-grid">{lifecycleOptions.map((item) => <label key={item}><input type="checkbox" checked={draft.lifecycle.includes(item)} onChange={() => toggleListValue("lifecycle", item)} /><code>{item}</code></label>)}</div></section>
          <section><strong>{tr(props.locale, "场景能力", "Scene capabilities")}</strong><div className="behavior-option-grid compact">{capabilityOptions.map((item) => <label key={item}><input type="checkbox" checked={draft.capabilities.includes(item)} onChange={() => toggleListValue("capabilities", item)} /><code>{item.replace("studio.", "")}</code></label>)}</div></section>
          <section><strong>{tr(props.locale, "权限", "Permissions")}</strong><div className="behavior-option-grid compact">{permissionOptions.map((item) => <label key={item}><input type="checkbox" checked={draft.permissions.includes(item)} onChange={() => toggleListValue("permissions", item)} /><code>{item}</code></label>)}</div>{draft.permissions.includes("network.connect") && <p className="behavior-warning"><AlertTriangle size={12} />{tr(props.locale, "发布前需审核网络域名与数据出域。", "Review network domains and data egress before publishing.")}</p>}</section>
          <section className="behavior-runtime-summary"><strong>{tr(props.locale, "运行诊断", "Runtime diagnostics")}</strong>{runtime ? <dl><div><dt>{tr(props.locale, "状态", "Status")}</dt><dd>{runtimeStatus(runtime.diagnostics.status, props.locale)}</dd></div><div><dt>{tr(props.locale, "待处理", "Pending")}</dt><dd>{runtime.diagnostics.pendingInvocations}</dd></div><div><dt>{tr(props.locale, "平均耗时", "Average")}</dt><dd>{runtime.diagnostics.averageExecutionMs.toFixed(2)} ms</dd></div><div><dt>{tr(props.locale, "丢弃调用", "Dropped")}</dt><dd>{runtime.diagnostics.droppedInvocations}</dd></div></dl> : <small>{tr(props.locale, "点击“运行已启用”开始预览。", "Select Run enabled to start the preview.")}</small>}</section>
        </aside>
      </> : <div className="behavior-editor-placeholder"><Braces size={28} /><strong>{tr(props.locale, "选择或创建行为脚本", "Select or create a behavior script")}</strong></div>}
    </div>
    <footer className="behavior-console"><header><strong>{tr(props.locale, "运行日志", "Runtime log")}</strong><span>{selectedLogs.length}</span><button onClick={props.onClearLogs}>{tr(props.locale, "清空", "Clear")}</button></header><div>{selectedLogs.length ? selectedLogs.slice(-80).map((entry) => <p key={entry.id} className={entry.level}><time>{new Date(entry.timestamp).toLocaleTimeString()}</time><span>{entry.message}</span></p>) : <small>{tr(props.locale, "运行、错误和权限诊断会显示在这里。", "Runtime, error and permission diagnostics appear here.")}</small>}</div></footer>
  </section>;
}

function runtimeStatus(status: SceneBehaviorManagerEntry["diagnostics"]["status"], locale: AppLocale): string {
  const labels = { idle: ["空闲", "Idle"], initializing: ["初始化", "Initializing"], running: ["运行中", "Running"], paused: ["已暂停", "Paused"], disposing: ["停止中", "Stopping"], disposed: ["已停止", "Stopped"], error: ["错误", "Error"] } as const;
  const pair = labels[status];
  return locale === "zh-CN" ? pair[0] : pair[1];
}

function defaultBehaviorCode(): string {
  return `function onStart(ctx) {
  ctx.log("Behavior started", { sceneId: ctx.sceneId });
}

function onUpdate(ctx) {
  // Use ctx.command({ id, type, ...payload }) to change the scene.
}

function onDispose(ctx) {
  ctx.log("Behavior stopped");
}`;
}
