import { useEffect, useMemo, useState } from "react";
import type { ApplicationScriptLifecycle, ApplicationScriptPermission, ScriptModule } from "@bim-studio/contracts";
import type { SceneCapability } from "@bim-studio/scene-sdk";
import { AlertTriangle, Box, Braces, ChevronDown, ChevronUp, CircleStop, Code2, LayoutPanelTop, Pause, Play, Plus, RotateCcw, Save, Search, Trash2, X } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { SceneBehaviorManagerEntry } from "../behavior/SceneBehaviorManager";
import { ProfessionalCodeEditor, type CodeInsertRequest } from "./ProfessionalCodeEditor";

export interface SceneBehaviorLogEntry {
  id: string;
  moduleId: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp: string;
}

export interface BehaviorCodeTarget {
  id: string;
  name: string;
  kind: "object" | "component";
  context: string;
}

const lifecycleOptions: ApplicationScriptLifecycle[] = ["onStart", "onUpdate", "onFixedUpdate", "onData", "onEvent", "onStop", "onDispose"];
const permissionOptions: ApplicationScriptPermission[] = ["scene.read", "scene.write", "data.read", "data.write", "network.connect", "renderer.extend", "editor.extend"];
const capabilityOptions: SceneCapability[] = ["studio.scene", "studio.object", "studio.component", "studio.mesh", "studio.material", "studio.camera", "studio.controls", "studio.animation", "studio.timeline", "studio.input", "studio.data", "studio.runtime"];

export function SceneBehaviorPanel(props: {
  locale: AppLocale;
  scripts: readonly ScriptModule[];
  runtimeEntries: readonly SceneBehaviorManagerEntry[];
  logs: readonly SceneBehaviorLogEntry[];
  codeTargets: readonly BehaviorCodeTarget[];
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
  const [logsOpen, setLogsOpen] = useState(false);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [insertedTargets, setInsertedTargets] = useState<Set<string>>(new Set());
  const [insertRequest, setInsertRequest] = useState<CodeInsertRequest>();
  const visibleTargets = useMemo(() => {
    const query = libraryQuery.trim().toLocaleLowerCase();
    return props.codeTargets.filter((target) => !query || `${target.name} ${target.id} ${target.context}`.toLocaleLowerCase().includes(query)).slice(0, 120);
  }, [libraryQuery, props.codeTargets]);

  function insertCode(text: string) {
    setInsertRequest({ id: Date.now() + Math.random(), text: text.endsWith("\n") ? text : `${text}\n` });
  }

  function insertTarget(target: BehaviorCodeTarget) {
    const variable = safeIdentifier(target.name, target.kind === "object" ? "object" : "component");
    insertCode(target.kind === "object"
      ? `const ${variable} = studio.object(${JSON.stringify(target.id)});\n${variable}?.focus();`
      : `const ${variable} = studio.component(${JSON.stringify(target.id)});\n${variable}?.update({});`);
    setInsertedTargets((current) => new Set(current).add(`${target.kind}:${target.id}`));
    const requiredCapability: SceneCapability = target.kind === "object" ? "studio.object" : "studio.component";
    setDraft((current) => current && !current.capabilities.includes(requiredCapability) ? { ...current, capabilities: [...current.capabilities, requiredCapability] } : current);
  }

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

  return <section className={`behavior-panel ${logsOpen ? "logs-open" : "logs-collapsed"}`} aria-label={tr(props.locale, "场景行为脚本", "Scene behavior scripts")}>
    <header className="behavior-panel-header">
      <div><span><Braces size={16} /></span><div><strong>{tr(props.locale, "行为脚本", "Behavior scripts")}</strong><small>{tr(props.locale, "Three.js · Studio SDK · 网关网络 · 固定时间步", "Three.js · Studio SDK · gateway network · fixed timestep")}</small></div></div>
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
          <ProfessionalCodeEditor locale={props.locale} path={`bim-studio://behavior/${draft.id}.js`} value={draft.code} {...(insertRequest ? { insertRequest } : {})} onChange={(code) => setDraft({ ...draft, code })} onSave={() => { if (dirty && draft.name.trim()) props.onUpsert(draft); }} onRun={props.onRun} />
          <footer><span>JavaScript · Scene SDK 1.0</span><span>{draft.code.split("\n").length} {tr(props.locale, "行", "lines")}</span>{dirty && <em>{tr(props.locale, "有未应用的修改", "Unapplied changes")}</em>}</footer>
        </main>
        <aside className="behavior-inspector">
          <section className="behavior-code-library"><header><strong>{tr(props.locale, "对象与组件", "Objects & components")}</strong><small>{tr(props.locale, "勾选即插入光标处", "Check to insert at cursor")}</small></header><label className="behavior-library-search"><Search size={11} /><input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder={tr(props.locale, "搜索名称或 ID", "Search name or ID")} /></label><div className="behavior-target-list">{visibleTargets.map((target) => {
            const key = `${target.kind}:${target.id}`;
            return <label key={key} title={`${target.context} · ${target.id}`}><input type="checkbox" checked={insertedTargets.has(key)} onChange={() => insertTarget(target)} />{target.kind === "object" ? <Box size={11} /> : <LayoutPanelTop size={11} />}<span><b>{target.name}</b><small>{target.context}</small></span></label>;
          })}{!visibleTargets.length && <p>{tr(props.locale, "没有匹配的对象或组件", "No matching objects or components")}</p>}</div></section>
          <section><strong>{tr(props.locale, "生命周期", "Lifecycle")}</strong><div className="behavior-option-grid">{lifecycleOptions.map((item) => <label key={item}><input type="checkbox" checked={draft.lifecycle.includes(item)} onChange={() => toggleListValue("lifecycle", item)} /><code>{item}</code></label>)}</div></section>
          <section><header className="behavior-section-heading"><strong>{tr(props.locale, "API 能力", "API capabilities")}</strong><small>{tr(props.locale, "启用并插入示例", "Enable and insert example")}</small></header><div className="behavior-option-grid compact">{capabilityOptions.map((item) => <label key={item}><input type="checkbox" checked={draft.capabilities.includes(item)} onChange={() => {
            const enabling = !draft.capabilities.includes(item);
            toggleListValue("capabilities", item);
            if (enabling) insertCode(capabilitySnippet(item));
          }} /><Code2 size={10} /><code>{item}</code></label>)}</div></section>
          <section><strong>{tr(props.locale, "权限", "Permissions")}</strong><div className="behavior-option-grid compact">{permissionOptions.map((item) => <label key={item}><input type="checkbox" checked={draft.permissions.includes(item)} onChange={() => { const enabling = !draft.permissions.includes(item); toggleListValue("permissions", item); if (enabling && item === "network.connect") insertCode("const response = await studio.net.fetch(\"https://api.example.com/data\", { credentialRef: \"api-credential\" });\nstudio.log(\"gateway response\", response.value);"); }} /><code>{item}</code></label>)}</div>{draft.permissions.includes("network.connect") && <p className="behavior-warning"><AlertTriangle size={12} />{tr(props.locale, "HTTP 经服务器代理并执行域名、端口、凭据与响应大小策略；WebSocket 数据通过 onData 接收。", "HTTP runs through the server gateway policy; receive WebSocket binding updates through onData.")}</p>}</section>
          <section className="behavior-runtime-summary"><strong>{tr(props.locale, "运行诊断", "Runtime diagnostics")}</strong>{runtime ? <dl><div><dt>{tr(props.locale, "状态", "Status")}</dt><dd>{runtimeStatus(runtime.diagnostics.status, props.locale)}</dd></div><div><dt>{tr(props.locale, "待处理", "Pending")}</dt><dd>{runtime.diagnostics.pendingInvocations}</dd></div><div><dt>{tr(props.locale, "平均耗时", "Average")}</dt><dd>{runtime.diagnostics.averageExecutionMs.toFixed(2)} ms</dd></div><div><dt>{tr(props.locale, "丢弃调用", "Dropped")}</dt><dd>{runtime.diagnostics.droppedInvocations}</dd></div></dl> : <small>{tr(props.locale, "点击“运行已启用”开始预览。", "Select Run enabled to start the preview.")}</small>}</section>
        </aside>
      </> : <div className="behavior-editor-placeholder"><Braces size={28} /><strong>{tr(props.locale, "选择或创建行为脚本", "Select or create a behavior script")}</strong></div>}
    </div>
    <footer className="behavior-console"><header><button className="behavior-console-toggle" onClick={() => setLogsOpen((open) => !open)}>{logsOpen ? <ChevronDown size={12} /> : <ChevronUp size={12} />}<strong>{tr(props.locale, "运行日志", "Runtime log")}</strong><span>{selectedLogs.length}</span></button><button onClick={props.onClearLogs}>{tr(props.locale, "清空", "Clear")}</button></header>{logsOpen && <div>{selectedLogs.length ? selectedLogs.slice(-80).map((entry) => <p key={entry.id} className={entry.level}><time>{new Date(entry.timestamp).toLocaleTimeString()}</time><span>{entry.message}</span></p>) : <small>{tr(props.locale, "运行、错误和权限诊断会显示在这里。", "Runtime, error and permission diagnostics appear here.")}</small>}</div>}</footer>
  </section>;
}

function safeIdentifier(name: string, fallback: string): string {
  const normalized = name.trim().replace(/[^A-Za-z0-9_$]+/g, "_").replace(/^_+|_+$/g, "").replace(/_+/g, "_");
  if (!normalized) return fallback;
  return /^[A-Za-z_$]/.test(normalized) ? normalized : `_${normalized}`;
}

function capabilitySnippet(capability: SceneCapability): string {
  const snippets: Record<SceneCapability, string> = {
    "studio.scene": "const sceneState = studio.scene.statistics();",
    "studio.object": "const selectedObject = studio.selection.get();\nselectedObject?.focus();",
    "studio.component": "const component = studio.component(\"component-id\");\ncomponent?.update({ visible: true });",
    "studio.mesh": "const mesh = studio.raw.scene?.getObjectByName(\"mesh-name\");",
    "studio.material": "const materialOwner = studio.object(\"object-id\");\nmaterialOwner?.setColor(\"#35a7ff\");",
    "studio.camera": "studio.camera.setMode(\"orbit\");\nstudio.camera.setClip(0.05, 100000);",
    "studio.controls": "studio.camera.setMode(\"firstPerson\");\nstudio.camera.setCollision(true, 0.32);",
    "studio.animation": "studio.animation.play();",
    "studio.timeline": "studio.animation.seek(0);\nstudio.animation.play();",
    "studio.input": "// Handle input through onEvent(ctx) and inspect ctx.event.",
    "studio.data": "const value = studio.getData(\"data.key\");\nstudio.log(\"data.key\", value);",
    "studio.runtime": "studio.log(\"Runtime ready\", { version: studio.version });"
  };
  return snippets[capability];
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
  // ThingJS-style handles + Unity-style lifecycle; THREE is also available.
  // studio.object("AGV-01").setPosition(0, 0, ctx.elapsedTime);
}

function onDispose(ctx) {
  ctx.log("Behavior stopped");
}`;
}
