import { useEffect, useMemo, useState } from "react";
import type { ApplicationScriptLifecycle, ApplicationScriptPermission, ApplicationScriptTarget, ScriptModule } from "@bim-studio/contracts";
import type { SceneCapability } from "@bim-studio/scene-sdk";
import {
  AlertTriangle, Box, Braces, ChevronDown, ChevronUp, CircleStop, Code2, Database,
  Focus, LayoutPanelTop, Pause, Play, Plus, Radio, RotateCcw, Save, Search,
  Settings2, Sparkles, Trash2, Workflow, X,
} from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { SceneBehaviorManagerEntry } from "../behavior/SceneBehaviorManager";
import { ProfessionalCodeEditor, type CodeInsertRequest } from "./ProfessionalCodeEditor";
import { SceneBehaviorAiDraftDialog } from "./SceneBehaviorAiDraftDialog";
import { WorkspaceModeSwitch } from "./WorkspaceModeSwitch";
import type { SceneScriptIntelligenceContext, SceneScriptTarget } from "../studio/sceneScriptContext";
import { analyzeSceneScript, applySceneScriptDeclarations } from "../studio/sceneScriptAnalysis";
import { SceneBehaviorAgentWorkspace } from "./SceneBehaviorAgentWorkspace";

export interface SceneBehaviorLogEntry {
  id: string;
  moduleId: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp: string;
}

export type BehaviorCodeTarget = SceneScriptTarget;

export interface SceneBehaviorWorkspaceNavigation {
  contextLabel: string;
  sceneAvailable: boolean;
  onSelect2D: () => void | Promise<void>;
  onSelect3D: () => void | Promise<void>;
}

const lifecycleOptions: ApplicationScriptLifecycle[] = ["onStart", "onUpdate", "onFixedUpdate", "onData", "onEvent", "onStop", "onDispose"];
const permissionOptions: ApplicationScriptPermission[] = ["scene.read", "scene.write", "data.read", "data.write", "network.connect", "renderer.extend", "editor.extend"];
const capabilityOptions: SceneCapability[] = ["studio.object", "studio.component", "studio.unity", "studio.camera", "studio.animation", "studio.data", "studio.runtime"];

export function SceneBehaviorPanel(props: {
  locale: AppLocale;
  projectId?: string;
  scripts: readonly ScriptModule[];
  runtimeEntries: readonly SceneBehaviorManagerEntry[];
  logs: readonly SceneBehaviorLogEntry[];
  codeTargets: readonly BehaviorCodeTarget[];
  intelligence: SceneScriptIntelligenceContext;
  workspaceNavigation: SceneBehaviorWorkspaceNavigation;
  preferredTarget?: BehaviorCodeTarget;
  paused: boolean;
  onUpsert: (script: ScriptModule) => void;
  onDelete: (scriptId: string) => void;
  onRun: (draft?: ScriptModule) => void;
  onPauseResume: () => void;
  onStop: () => void;
  onClearLogs: () => void;
  onOpenDocs: (documentId: string) => void;
  resolveSceneId: (target: BehaviorCodeTarget) => string | undefined;
  onFocusTarget: (target: BehaviorCodeTarget) => void | Promise<void>;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState(() => props.scripts.find((script) => targetMatches(script.target, props.preferredTarget))?.id ?? props.scripts[0]?.id ?? "");
  const selected = props.scripts.find((script) => script.id === selectedId) ?? props.scripts[0];
  // 当前脚本的挂载目标始终显示在标题区，避免用户在 2D/3D 切换后误编辑对象。
  const selectedContextLabel = selected ? scriptTargetLabel(selected.target, props.codeTargets, props.locale) : tr(props.locale, "未选择脚本", "No script selected");
  const attachedTarget =
    selected?.target && selected.target.kind !== "scene"
      ? (props.codeTargets.find((target) => target.kind === selected.target?.kind && target.id === selected.target.id) ?? props.preferredTarget)
      : undefined;
  const [draft, setDraft] = useState<ScriptModule | undefined>(() => (selected ? structuredClone(selected) : undefined));
  useEffect(() => {
    // 选中对象变化时，只切换到该对象已有脚本；没有匹配脚本时保留用户当前编辑项。
    const preferred = props.scripts.find((script) => targetMatches(script.target, props.preferredTarget));
    if (preferred) setSelectedId(preferred.id);
  }, [props.preferredTarget?.kind, props.preferredTarget?.id]);
  useEffect(() => {
    if (!selected && props.scripts[0]) setSelectedId(props.scripts[0].id);
    setDraft(selected ? structuredClone(selected) : undefined);
  }, [selected?.id, selected?.code, selected?.name, selected?.enabled, selected?.lifecycle.join("|"), selected?.permissions.join("|"), selected?.capabilities.join("|")]);
  const dirty = Boolean(selected && draft && JSON.stringify(selected) !== JSON.stringify(draft));
  const runtime = selected ? props.runtimeEntries.find((entry) => entry.module.id === selected.id) : undefined;
  const selectedLogs = useMemo(() => (selected ? props.logs.filter((entry) => entry.moduleId === selected.id) : props.logs), [props.logs, selected?.id]);
  const [logsOpen, setLogsOpen] = useState(false);
  // 默认把注意力留给脚本和诊断；资源与高级声明按需展开，降低首次使用的信息负担。
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [insertedTargets, setInsertedTargets] = useState<Set<string>>(new Set());
  const [insertRequest, setInsertRequest] = useState<CodeInsertRequest>();
  const [aiDraftOpen, setAiDraftOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [aiDraftInserted, setAiDraftInserted] = useState(false);
  const [actionFeedback, setActionFeedback] = useState("");
  const analysis = useMemo(() => (draft ? analyzeSceneScript(draft.code, draft, props.intelligence) : undefined), [draft, props.intelligence]);
  const editorDiagnostics = useMemo(() => {
    const diagnostics = [...(analysis?.issues ?? [])];
    if (runtime?.diagnostics.lastError) {
      const location = runtime.diagnostics.lastErrorLocation ?? { line: 1, column: 1 };
      diagnostics.push({
        code: "runtime-error",
        severity: "error",
        message: runtime.diagnostics.lastError,
        line: location.line,
        column: location.column,
        endColumn: location.column + 1,
      });
    }
    return diagnostics;
  }, [analysis?.issues, runtime?.diagnostics.lastError, runtime?.diagnostics.lastErrorLocation]);
  const declarationGap = Boolean(
    analysis?.missingCapabilities.length || analysis?.missingPermissions.length || (analysis && analysis.lifecycle.some((item) => !draft?.lifecycle.includes(item))),
  );
  const visibleTargets = useMemo(() => {
    const query = libraryQuery.trim().toLocaleLowerCase();
    return props.codeTargets.filter((target) => !query || `${target.name} ${target.id} ${target.context}`.toLocaleLowerCase().includes(query)).slice(0, 120);
  }, [libraryQuery, props.codeTargets]);
  const visibleDataKeys = useMemo(() => {
    const query = libraryQuery.trim().toLocaleLowerCase();
    return props.intelligence.dataKeys.filter((key) => !query || key.toLocaleLowerCase().includes(query)).slice(0, 40);
  }, [libraryQuery, props.intelligence.dataKeys]);
  const visibleEvents = useMemo(() => {
    const query = libraryQuery.trim().toLocaleLowerCase();
    return props.intelligence.eventNames.filter((name) => !query || name.toLocaleLowerCase().includes(query)).slice(0, 40);
  }, [libraryQuery, props.intelligence.eventNames]);
  const targetOptions = useMemo(() => {
    const targets = [...props.codeTargets];
    if (props.preferredTarget && !targets.some((target) => target.kind === props.preferredTarget?.kind && target.id === props.preferredTarget.id))
      targets.unshift(props.preferredTarget);
    return targets.slice(0, 300);
  }, [props.codeTargets, props.preferredTarget]);
  const aiDraftTarget = draft?.target && draft.target.kind !== "scene"
    ? props.codeTargets.find((target) => target.kind === draft.target?.kind && target.id === draft.target.id)
    : props.preferredTarget;
  const aiDraftSceneId = aiDraftTarget ? props.resolveSceneId(aiDraftTarget) : undefined;

  function insertCode(text: string) {
    setInsertRequest({ id: Date.now() + Math.random(), text: text.endsWith("\n") ? text : `${text}\n` });
  }

  function insertTarget(target: BehaviorCodeTarget) {
    const variable = safeIdentifier(target.name, target.kind === "object" ? "object" : "component");
    insertCode(
      target.kind === "object"
        ? `const ${variable} = studio.object(${JSON.stringify(target.id)});\n${variable}?.focus();`
        : target.runtime === "unity"
          ? `const ${variable} = studio.unity(${JSON.stringify(target.id)});\n${variable}.setProperties({ lightIntensity: 1.5 });`
          : `const ${variable} = studio.component(${JSON.stringify(target.id)});\n${variable}?.update({});`,
    );
    setInsertedTargets((current) => new Set(current).add(`${target.kind}:${target.id}`));
    const requiredCapability: SceneCapability = target.kind === "object" ? "studio.object" : target.runtime === "unity" ? "studio.unity" : "studio.component";
    setDraft((current) => (current && !current.capabilities.includes(requiredCapability) ? { ...current, capabilities: [...current.capabilities, requiredCapability] } : current));
  }

  function insertDataResource(key: string, mode: "data-read" | "data-write") {
    insertCode(sceneScriptResourceSnippet(mode, key));
    setDraft((current) =>
      current
        ? {
            ...current,
            capabilities: current.capabilities.includes("studio.data") ? current.capabilities : [...current.capabilities, "studio.data"],
            permissions: current.permissions.includes(mode === "data-read" ? "data.read" : "data.write")
              ? current.permissions
              : [...current.permissions, mode === "data-read" ? "data.read" : "data.write"],
          }
        : current,
    );
  }

  function insertEventResource(name: string, mode: "event-listen" | "event-emit") {
    const hasOnEvent = Boolean(draft && /\b(?:async\s+)?function\s+onEvent\s*\(|\b(?:const|let|var)\s+onEvent\s*=/.test(draft.code));
    insertCode(sceneScriptResourceSnippet(mode === "event-listen" && hasOnEvent ? "event-condition" : mode, name));
    setDraft((current) =>
      current
        ? {
            ...current,
            lifecycle: mode === "event-listen" && !current.lifecycle.includes("onEvent") ? [...current.lifecycle, "onEvent"] : current.lifecycle,
            capabilities: mode === "event-emit" && !current.capabilities.includes("studio.runtime") ? [...current.capabilities, "studio.runtime"] : current.capabilities,
          }
        : current,
    );
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
      capabilities: [
        props.preferredTarget?.runtime === "unity" ? "studio.unity" : props.preferredTarget?.kind === "component" ? "studio.component" : "studio.object",
        "studio.runtime",
      ],
      permissions: ["scene.read", "scene.write"],
      target: props.preferredTarget ? { kind: props.preferredTarget.kind, id: props.preferredTarget.id } : { kind: "scene" },
    };
    props.onUpsert(script);
    setSelectedId(id);
  }

  function applyAndRun() {
    if (!draft || !draft.name.trim()) return;
    props.onUpsert(draft);
    props.onRun(draft);
    setAiDraftInserted(false);
    setActionFeedback(tr(props.locale, "修改已应用，正在运行", "Changes applied; running"));
  }

  function applyChanges() {
    if (!draft || !dirty || !draft.name.trim()) return;
    props.onUpsert(draft);
    setAiDraftInserted(false);
    setActionFeedback(tr(props.locale, "修改已应用", "Changes applied"));
  }

  function leaveForWorkspace(action: () => void | Promise<void>) {
    if (dirty && !draft?.name.trim()) {
      setActionFeedback(tr(props.locale, "请先填写脚本名称", "Enter a script name first"));
      return;
    }
    if (dirty && draft) {
      props.onUpsert(draft);
      setAiDraftInserted(false);
      // 先让应用文档提交本轮变更，再卸载脚本面板，避免 React 同事件批处理丢失草稿。
      globalThis.setTimeout(() => void action(), 0);
      return;
    }
    void action();
  }

  function closePanel() {
    const discard = !dirty || window.confirm(tr(props.locale, "还有未应用的修改，放弃并关闭吗？", "Discard unapplied changes and close?"));
    if (discard) props.onClose();
  }

  function completeDeclarations() {
    if (!draft || !analysis) return;
    setDraft(applySceneScriptDeclarations(draft, analysis));
  }

  function toggleListValue<T extends string>(key: "lifecycle" | "permissions" | "capabilities", value: T) {
    if (!draft) return;
    const current = draft[key] as string[];
    setDraft({ ...draft, [key]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] });
  }

  return (
    <section
      className={`behavior-panel ${logsOpen ? "logs-open" : "logs-collapsed"} ${inspectorOpen ? "inspector-open" : "inspector-collapsed"} ${agentOpen ? "agent-open" : ""}`}
      aria-label={tr(props.locale, "场景行为脚本", "Scene behavior scripts")}
    >
      <header className="behavior-panel-header">
        <div className="behavior-panel-heading">
          <span>
            <Braces size={16} />
          </span>
          <div>
            <strong>{tr(props.locale, "行为脚本", "Behavior scripts")}</strong>
            <small>{tr(props.locale, "对象行为组件 · Scene SDK · Worker 沙箱", "Object behaviors · Scene SDK · Worker sandbox")}</small>
            <em className="behavior-context-badge">
              {tr(props.locale, "当前挂载", "Attached")}：{selectedContextLabel}
            </em>
          </div>
        </div>
        <WorkspaceModeSwitch
          locale={props.locale}
          active="script"
          contextLabel={props.workspaceNavigation.contextLabel}
          sceneAvailable={props.workspaceNavigation.sceneAvailable}
          onSelect2D={() => leaveForWorkspace(props.workspaceNavigation.onSelect2D)}
          onSelect3D={() => leaveForWorkspace(props.workspaceNavigation.onSelect3D)}
        />
        <nav className="behavior-panel-actions" aria-label={tr(props.locale, "脚本运行操作", "Script runtime actions")}>
          <button className={agentOpen ? "active" : ""} onClick={() => setAgentOpen((open) => !open)}>
            <Workflow size={13} />
            {tr(props.locale, "工业任务", "Agent task")}
          </button>
          <button disabled={!attachedTarget} onClick={() => attachedTarget && leaveForWorkspace(() => props.onFocusTarget(attachedTarget))}>
            <Focus size={13} />
            {tr(props.locale, "定位目标", "Focus target")}
          </button>
          <button onClick={applyAndRun} disabled={!draft}>
            <Play size={13} />
            {dirty
              ? tr(props.locale, "应用并运行", "Apply & run")
              : props.runtimeEntries.length
                ? tr(props.locale, "重新运行", "Restart")
                : tr(props.locale, "运行已启用", "Run enabled")}
          </button>
          <button disabled={!props.runtimeEntries.length} onClick={props.onPauseResume}>
            {props.paused ? <Play size={13} /> : <Pause size={13} />}
            {props.paused ? tr(props.locale, "继续", "Resume") : tr(props.locale, "暂停", "Pause")}
          </button>
          <button disabled={!props.runtimeEntries.length} onClick={props.onStop}>
            <CircleStop size={13} />
            {tr(props.locale, "停止", "Stop")}
          </button>
          <button
            className={inspectorOpen ? "active" : ""}
            aria-expanded={inspectorOpen}
            title={tr(props.locale, "显示或隐藏脚本设置", "Show or hide script settings")}
            onClick={() => setInspectorOpen((value) => !value)}
          >
            <Settings2 size={13} />
            {tr(props.locale, "设置", "Settings")}
          </button>
          <button className="icon-button" aria-label={tr(props.locale, "关闭行为脚本", "Close behavior scripts")} onClick={closePanel}>
            <X size={14} />
          </button>
        </nav>
      </header>
      <div className="behavior-panel-body">
        <aside className="behavior-script-list">
          <button className="behavior-add" onClick={addScript}>
            <Plus size={13} />
            {tr(props.locale, "新建行为", "New behavior")}
          </button>
          {props.scripts.map((script) => {
            const entry = props.runtimeEntries.find((candidate) => candidate.module.id === script.id);
            const targetLabel = scriptTargetLabel(script.target, props.codeTargets, props.locale);
            const statusLabel = entry
              ? runtimeStatus(entry.diagnostics.status, props.locale)
              : script.enabled
                ? tr(props.locale, "未运行", "Not running")
                : tr(props.locale, "已禁用", "Disabled");
            return (
              <button key={script.id} className={script.id === selected?.id ? "selected" : ""} onClick={() => leaveForWorkspace(() => setSelectedId(script.id))}>
                <i className={entry?.diagnostics.status ?? (script.enabled ? "idle" : "disabled")} />
                <span>
                  <strong>{script.name}</strong>
                  <small>
                    {targetLabel} · {statusLabel}
                  </small>
                </span>
              </button>
            );
          })}
          {!props.scripts.length && (
            <div className="behavior-empty">
              <Braces size={22} />
              <strong>{tr(props.locale, "还没有行为脚本", "No behavior scripts yet")}</strong>
              <span>
                {tr(props.locale, "创建后可通过公开 Scene SDK 控制对象、相机和动画。", "Create one to control objects, cameras and animation through the public Scene SDK.")}
              </span>
            </div>
          )}
        </aside>
        {draft ? (
          <>
            <main className="behavior-editor">
              <div className="behavior-editor-toolbar">
                <label>
                  <span>{tr(props.locale, "名称", "Name")}</span>
                  <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                </label>
                <label className="behavior-target-field">
                  <span>{tr(props.locale, "挂载到", "Attach to")}</span>
                  <select value={scriptTargetValue(draft.target)} onChange={(event) => setDraft({ ...draft, target: parseScriptTarget(event.target.value) })}>
                    <option value="scene">{tr(props.locale, "整个场景", "Whole scene")}</option>
                    {targetOptions.map((target) => (
                      <option key={`${target.kind}:${target.id}`} value={`${target.kind}:${target.id}`}>
                        {target.name} · {target.kind === "object" ? tr(props.locale, "对象", "Object") : tr(props.locale, "二维组件", "2D component")}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="behavior-enabled">
                  <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
                  {tr(props.locale, "启用", "Enabled")}
                </label>
                <button
                  type="button"
                  disabled={!aiDraftTarget || !aiDraftSceneId}
                  title={
                    aiDraftTarget && aiDraftSceneId
                      ? tr(props.locale, "生成后先审查，只插入本地编辑器", "Review first; only insert into the local editor")
                      : tr(props.locale, "请先选择有效的 2D、3D 或 Unity 目标", "Select a valid 2D, 3D, or Unity target first")
                  }
                  onClick={() => setAiDraftOpen(true)}
                >
                  <Sparkles size={13} />
                  {tr(props.locale, "AI 生成草稿", "AI draft")}
                </button>
                <button disabled={!dirty || !draft.name.trim()} onClick={applyChanges}>
                  <Save size={13} />
                  {tr(props.locale, "应用修改", "Apply changes")}
                </button>
                <button disabled={!dirty} onClick={() => { setDraft(structuredClone(selected!)); setAiDraftInserted(false); }}>
                  <RotateCcw size={13} />
                  {tr(props.locale, "还原", "Revert")}
                </button>
                <button
                  className="danger"
                  aria-label={tr(props.locale, `删除脚本“${draft.name}”`, `Delete script “${draft.name}”`)}
                  onClick={() => {
                    if (window.confirm(tr(props.locale, `删除“${draft.name}”吗？`, `Delete “${draft.name}”?`))) props.onDelete(draft.id);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <ProfessionalCodeEditor
                locale={props.locale}
                path={`bim-studio://behavior/${draft.id}.js`}
                value={draft.code}
                intelligence={props.intelligence}
                diagnostics={editorDiagnostics}
                {...(insertRequest ? { insertRequest } : {})}
                onChange={(code) => setDraft({ ...draft, code })}
                onSave={() => {
                  applyChanges();
                }}
                onRun={applyAndRun}
                onOpenDocs={() => props.onOpenDocs("behavior-script")}
              />
              <footer>
                <span>JavaScript · Scene SDK 1.0</span>
                <span>
                  {draft.code.split("\n").length} {tr(props.locale, "行", "lines")}
                </span>
                <em className={dirty ? "pending" : runtime?.diagnostics.status === "error" ? "error" : "ready"} role="status" aria-live="polite">
                  {dirty
                    ? aiDraftInserted
                      ? tr(props.locale, "AI 草稿待应用", "AI draft awaiting apply")
                      : tr(props.locale, "有未应用的修改", "Unapplied changes")
                    : runtime?.diagnostics.status === "error"
                      ? tr(props.locale, "运行失败，请查看问题", "Run failed; review problems")
                      : actionFeedback || tr(props.locale, "编辑器与应用状态一致", "Editor is in sync")}
                </em>
              </footer>
            </main>
            <aside className="behavior-inspector">
              <section
                className={`behavior-script-assistant ${analysis?.issues.some((issue) => issue.severity === "error") ? "has-error" : declarationGap ? "has-warning" : "ready"}`}
              >
                <header>
                  <span>
                    <Sparkles size={12} />
                    <strong>{tr(props.locale, "脚本助手", "Script assistant")}</strong>
                  </span>
                  <small>
                    {analysis?.issues.length ?? 0} {tr(props.locale, "项诊断", "diagnostics")}
                  </small>
                </header>
                {analysis && (
                  <>
                    <p>
                      {analysis.lifecycle.length
                        ? tr(
                            props.locale,
                            `已识别 ${analysis.lifecycle.length} 个生命周期，${analysis.capabilities.length} 类场景能力。`,
                            `${analysis.lifecycle.length} lifecycle hooks and ${analysis.capabilities.length} SDK capabilities detected.`,
                          )
                        : tr(props.locale, "请先添加 onStart、onUpdate 等生命周期函数。", "Add an onStart, onUpdate, or another lifecycle function.")}
                    </p>
                    {declarationGap && (
                      <button type="button" onClick={completeDeclarations}>
                        <Sparkles size={11} />
                        {tr(props.locale, "一键补齐声明", "Complete declarations")}
                      </button>
                    )}
                    {!declarationGap && analysis.lifecycle.length > 0 && (
                      <small>{tr(props.locale, "代码与生命周期、能力、权限声明已对齐。", "Code and lifecycle, capability, and permission declarations are aligned.")}</small>
                    )}
                  </>
                )}
              </section>
              <section className="behavior-code-library">
                <header>
                  <strong>{tr(props.locale, "对象与组件", "Objects & components")}</strong>
                  <small>{tr(props.locale, "勾选即插入光标处", "Check to insert at cursor")}</small>
                </header>
                <label className="behavior-library-search">
                  <Search size={11} />
                  <input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder={tr(props.locale, "搜索名称或 ID", "Search name or ID")} />
                </label>
                <div className="behavior-target-list">
                  {visibleTargets.map((target) => {
                    const key = `${target.kind}:${target.id}`;
                    return (
                      <label key={key} title={`${target.context} · ${target.id}`}>
                        <input type="checkbox" checked={insertedTargets.has(key)} onChange={() => insertTarget(target)} />
                        {target.kind === "object" ? <Box size={11} /> : <LayoutPanelTop size={11} />}
                        <span>
                          <b>{target.name}</b>
                          <small>{target.context}</small>
                        </span>
                      </label>
                    );
                  })}
                  {!visibleTargets.length && <p>{tr(props.locale, "没有匹配的对象或组件", "No matching objects or components")}</p>}
                </div>
              </section>
              <section className="behavior-code-library behavior-project-resources">
                <header>
                  <strong>{tr(props.locale, "数据与事件", "Data & events")}</strong>
                  <small>
                    {props.intelligence.dataKeys.length} + {props.intelligence.eventNames.length}
                  </small>
                </header>
                <div className="behavior-resource-group">
                  <b>
                    <Database size={11} />
                    {tr(props.locale, "项目数据键", "Project data keys")}
                  </b>
                  <div>
                    {visibleDataKeys.map((key) => (
                      <div key={key} title={key}>
                        <code>{key}</code>
                        <span>
                          <button type="button" onClick={() => insertDataResource(key, "data-read")}>
                            {tr(props.locale, "读取", "Read")}
                          </button>
                          <button type="button" onClick={() => insertDataResource(key, "data-write")}>
                            {tr(props.locale, "写入", "Write")}
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                  {!visibleDataKeys.length && <small>{tr(props.locale, "没有匹配的数据键", "No matching data keys")}</small>}
                </div>
                <div className="behavior-resource-group">
                  <b>
                    <Radio size={11} />
                    {tr(props.locale, "场景事件", "Scene events")}
                  </b>
                  <div>
                    {visibleEvents.map((name) => (
                      <div key={name} title={name}>
                        <code>{name}</code>
                        <span>
                          <button type="button" onClick={() => insertEventResource(name, "event-listen")}>
                            {tr(props.locale, "监听", "Listen")}
                          </button>
                          <button type="button" onClick={() => insertEventResource(name, "event-emit")}>
                            {tr(props.locale, "发出", "Emit")}
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                  {!visibleEvents.length && <small>{tr(props.locale, "没有匹配的事件", "No matching events")}</small>}
                </div>
              </section>
              <section>
                <strong>{tr(props.locale, "生命周期", "Lifecycle")}</strong>
                <div className="behavior-option-grid">
                  {lifecycleOptions.map((item) => (
                    <label key={item}>
                      <input type="checkbox" checked={draft.lifecycle.includes(item)} onChange={() => toggleListValue("lifecycle", item)} />
                      <code>{item}</code>
                    </label>
                  ))}
                </div>
              </section>
              <section>
                <header className="behavior-section-heading">
                  <strong>{tr(props.locale, "API 能力", "API capabilities")}</strong>
                  <small>{tr(props.locale, "启用并插入示例", "Enable and insert example")}</small>
                </header>
                <div className="behavior-option-grid compact">
                  {capabilityOptions.map((item) => (
                    <label key={item}>
                      <input
                        type="checkbox"
                        checked={draft.capabilities.includes(item)}
                        onChange={() => {
                          const enabling = !draft.capabilities.includes(item);
                          toggleListValue("capabilities", item);
                          if (enabling) insertCode(capabilitySnippet(item));
                        }}
                      />
                      <Code2 size={10} />
                      <code>{item}</code>
                    </label>
                  ))}
                </div>
              </section>
              <section>
                <strong>{tr(props.locale, "权限", "Permissions")}</strong>
                <div className="behavior-option-grid compact">
                  {permissionOptions.map((item) => (
                    <label key={item}>
                      <input
                        type="checkbox"
                        checked={draft.permissions.includes(item)}
                        onChange={() => {
                          const enabling = !draft.permissions.includes(item);
                          toggleListValue("permissions", item);
                          if (enabling && item === "network.connect")
                            insertCode(
                              'const response = await studio.net.fetch("https://api.example.com/data", { credentialRef: "api-credential" });\nstudio.log("gateway response", response.value);',
                            );
                        }}
                      />
                      <code>{item}</code>
                    </label>
                  ))}
                </div>
                {draft.permissions.includes("network.connect") && (
                  <p className="behavior-warning">
                    <AlertTriangle size={12} />
                    {tr(
                      props.locale,
                      "HTTP 经服务器代理并执行域名、端口、凭据与响应大小策略；WebSocket 数据通过 onData 接收。",
                      "HTTP runs through the server gateway policy; receive WebSocket binding updates through onData.",
                    )}
                  </p>
                )}
              </section>
              <section className="behavior-runtime-summary">
                <strong>{tr(props.locale, "运行诊断", "Runtime diagnostics")}</strong>
                {runtime ? (
                  <dl>
                    <div>
                      <dt>{tr(props.locale, "状态", "Status")}</dt>
                      <dd>{runtimeStatus(runtime.diagnostics.status, props.locale)}</dd>
                    </div>
                    <div>
                      <dt>{tr(props.locale, "待处理", "Pending")}</dt>
                      <dd>{runtime.diagnostics.pendingInvocations}</dd>
                    </div>
                    <div>
                      <dt>{tr(props.locale, "平均耗时", "Average")}</dt>
                      <dd>{runtime.diagnostics.averageExecutionMs.toFixed(2)} ms</dd>
                    </div>
                    <div>
                      <dt>{tr(props.locale, "丢弃调用", "Dropped")}</dt>
                      <dd>{runtime.diagnostics.droppedInvocations}</dd>
                    </div>
                  </dl>
                ) : (
                  <small>{tr(props.locale, "点击“运行已启用”开始预览。", "Select Run enabled to start the preview.")}</small>
                )}
              </section>
            </aside>
          </>
        ) : (
          <div className="behavior-editor-placeholder">
            <Braces size={28} />
            <strong>{tr(props.locale, "选择或创建行为脚本", "Select or create a behavior script")}</strong>
          </div>
        )}
      </div>
      {agentOpen && (
        <SceneBehaviorAgentWorkspace
          locale={props.locale}
          {...(props.projectId ? { projectId: props.projectId } : {})}
          {...(draft ? { draft } : {})}
          {...(analysis ? { analysis } : {})}
          onBack={() => setAgentOpen(false)}
        />
      )}
      {aiDraftOpen && draft && aiDraftTarget && aiDraftSceneId && (
        <SceneBehaviorAiDraftDialog
          locale={props.locale}
          sceneId={aiDraftSceneId}
          target={aiDraftTarget}
          intelligence={props.intelligence}
          existingScript={draft}
          onClose={() => setAiDraftOpen(false)}
          onInsertIntoEditor={(script) => {
            setDraft(script);
            setAiDraftInserted(true);
            setAiDraftOpen(false);
          }}
        />
      )}
      <footer className="behavior-console">
        <header>
          <button className="behavior-console-toggle" onClick={() => setLogsOpen((open) => !open)}>
            {logsOpen ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
            <strong>{tr(props.locale, "运行日志", "Runtime log")}</strong>
            <span>{selectedLogs.length}</span>
          </button>
          <button onClick={props.onClearLogs}>{tr(props.locale, "清空", "Clear")}</button>
        </header>
        {logsOpen && (
          <div>
            {selectedLogs.length ? (
              selectedLogs.slice(-80).map((entry) => (
                <p key={entry.id} className={entry.level}>
                  <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                  <span>{entry.message}</span>
                </p>
              ))
            ) : (
              <small>{tr(props.locale, "运行、错误和权限诊断会显示在这里。", "Runtime, error and permission diagnostics appear here.")}</small>
            )}
          </div>
        )}
      </footer>
    </section>
  );
}

export type SceneScriptResourceSnippetKind = "data-read" | "data-write" | "event-listen" | "event-condition" | "event-emit";

export function sceneScriptResourceSnippet(kind: SceneScriptResourceSnippetKind, value: string): string {
  const literal = JSON.stringify(value);
  const variable = safeIdentifier(value.split(/[./:-]/).at(-1) ?? "value", "value");
  if (kind === "data-read") return `const ${variable} = ctx.getData(${literal});\nctx.log(${literal}, ${variable});`;
  if (kind === "data-write") return `ctx.setData(${literal}, 0);`;
  if (kind === "event-emit") return `ctx.emit(${literal}, { source: ctx.sceneId });`;
  const condition = `if (ctx.event?.name === ${literal}) {\n  ctx.log(${literal}, ctx.event.data);\n}`;
  return kind === "event-condition" ? condition : `function onEvent(ctx) {\n  ${condition.replaceAll("\n", "\n  ")}\n}`;
}

function safeIdentifier(name: string, fallback: string): string {
  const normalized = name
    .trim()
    .replace(/[^A-Za-z0-9_$]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!normalized) return fallback;
  return /^[A-Za-z_$]/.test(normalized) ? normalized : `_${normalized}`;
}

function capabilitySnippet(capability: SceneCapability): string {
  const snippets: Record<SceneCapability, string> = {
    "studio.scene": "const sceneState = studio.scene.statistics();",
    "studio.object": 'const selectedObject = studio.object("object-id");\nselectedObject?.focus();',
    "studio.component": 'const component = studio.component("component-id");\ncomponent?.update({ visible: true });',
    "studio.unity": 'const unity = studio.unity("unity-component-id");\nunity.setProperties({ lightIntensity: 1.5 });',
    "studio.mesh": 'const mesh = studio.raw.scene?.getObjectByName("mesh-name");',
    "studio.material": 'const materialOwner = studio.object("object-id");\nmaterialOwner?.setColor("#35a7ff");',
    "studio.camera": "studio.camera.setPose([12, 6, 12], [0, 1, 0], { near: 0.05, far: 100000 });",
    "studio.controls": 'studio.camera.setMode("firstPerson");\nstudio.camera.setCollision(true, 0.32);',
    "studio.animation": 'studio.object("object-id")?.playAnimation();',
    "studio.timeline": "studio.animation.seek(0);\nstudio.animation.play();",
    "studio.input": "// Handle input through onEvent(ctx) and inspect ctx.event.",
    "studio.data": 'const value = studio.getData("data.key");\nstudio.log("data.key", value);',
    "studio.runtime": 'studio.log("Runtime ready", { version: studio.version });',
  };
  return snippets[capability];
}

function runtimeStatus(status: SceneBehaviorManagerEntry["diagnostics"]["status"], locale: AppLocale): string {
  const labels = {
    idle: ["空闲", "Idle"],
    initializing: ["初始化", "Initializing"],
    running: ["运行中", "Running"],
    paused: ["已暂停", "Paused"],
    disposing: ["停止中", "Stopping"],
    disposed: ["已停止", "Stopped"],
    error: ["错误", "Error"],
  } as const;
  const pair = labels[status];
  return locale === "zh-CN" ? pair[0] : pair[1];
}

function defaultBehaviorCode(): string {
  return `function onStart(ctx) {
  ctx.log("Behavior started", { sceneId: ctx.sceneId });
  // 挂载到对象或组件时，ctx.self 指向当前目标。
  ctx.self?.show();
}

function onUpdate(ctx) {
  // 通过稳定对象句柄和生命周期编辑场景；高级用户也可使用 THREE。
  // studio.object("AGV-01").setPosition(0, 0, ctx.elapsedTime);
}

function onDispose(ctx) {
  ctx.log("Behavior stopped");
}`;
}

function scriptTargetValue(target: ApplicationScriptTarget | undefined): string {
  return target && target.kind !== "scene" ? `${target.kind}:${target.id}` : "scene";
}

function parseScriptTarget(value: string): ApplicationScriptTarget {
  if (value === "scene") return { kind: "scene" };
  const separator = value.indexOf(":");
  const kind = value.slice(0, separator);
  return { kind: kind === "component" ? "component" : "object", id: value.slice(separator + 1) };
}

function targetMatches(target: ApplicationScriptTarget | undefined, preferred: BehaviorCodeTarget | undefined): boolean {
  return Boolean(preferred && target && target.kind !== "scene" && target.kind === preferred.kind && target.id === preferred.id);
}

function scriptTargetLabel(target: ApplicationScriptTarget | undefined, targets: readonly BehaviorCodeTarget[], locale: AppLocale): string {
  if (!target || target.kind === "scene") return tr(locale, "整个场景", "Whole scene");
  return targets.find((candidate) => candidate.kind === target.kind && candidate.id === target.id)?.name ?? target.id;
}
