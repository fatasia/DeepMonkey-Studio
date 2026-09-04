import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import type { ApplicationScriptDependency, ApplicationScriptTarget, ScriptModule } from "@bim-studio/contracts";
import type { SceneCapability } from "@bim-studio/scene-sdk";
import { Braces, ChevronDown, ChevronUp, Download, Upload, Plus, Power, RotateCcw, Save, Sparkles, Trash2 } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { SceneBehaviorManagerEntry } from "../behavior/SceneBehaviorManager";
import { ProfessionalCodeEditor, type CodeInsertRequest } from "./ProfessionalCodeEditor";
import type { SceneScriptIntelligenceContext, SceneScriptTarget } from "../studio/sceneScriptContext";
import { analyzeSceneScript } from "../studio/sceneScriptAnalysis";
import { SceneBehaviorAgentWorkspace, type SceneBehaviorAiMode } from "./SceneBehaviorAgentWorkspace";
import { SceneBehaviorTargetPicker } from "./SceneBehaviorTargetPicker";
import { BehaviorPanelHeader } from "./BehaviorPanelHeader";
import type { BehaviorLayoutMode } from "../appDefaults";
import { BehaviorScriptListResizer, persistBehaviorScriptListCollapsed, readBehaviorScriptListCollapsed, readBehaviorScriptListWidth } from "./BehaviorScriptListResizer";
import { downloadTextFile } from "../browserDownload";
import { ScriptDependencyManager } from "./ScriptDependencyManager";
import { ScriptVersionManager } from "./ScriptVersionManager";
import { SceneBehaviorInspector } from "./SceneBehaviorInspector";
import { isLocalDesktopMode } from "../adapters/desktopRuntimeMode";
import { createImportedBehaviorScript, scriptDownloadFileName } from "../behavior/scriptFileTransfer";
import {
  defaultBehaviorCode,
  runtimeStatus,
  scriptTargetLabel,
  targetMatches,
} from "./sceneBehaviorPanelModel";
export { sceneScriptResourceSnippet } from "./sceneBehaviorPanelModel";
export interface SceneBehaviorLogEntry {
  id: string;
  moduleId: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp: string;
}
export type BehaviorCodeTarget = SceneScriptTarget;
export function SceneBehaviorPanel(props: {
  locale: AppLocale;
  projectId?: string;
  scripts: readonly ScriptModule[];
  dependencies: readonly ApplicationScriptDependency[];
  runtimeEntries: readonly SceneBehaviorManagerEntry[];
  logs: readonly SceneBehaviorLogEntry[];
  codeTargets: readonly BehaviorCodeTarget[];
  intelligence: SceneScriptIntelligenceContext;
  preferredTarget?: BehaviorCodeTarget;
  paused: boolean;
  onUpsert: (script: ScriptModule) => void;
  autoSaveEnabled: boolean;
  onAutoSaveChange: (enabled: boolean) => void;
  onSaveWorkspace: () => void | Promise<unknown>;
  onDelete: (scriptId: string) => void;
  onDependenciesChange: (dependencies: readonly ApplicationScriptDependency[]) => void | Promise<void>;
  onReplaceScripts: (scripts: readonly ScriptModule[]) => void | Promise<void>;
  onRun: (draft?: ScriptModule) => void | Promise<void>;
  onPauseResume: () => void;
  onStop: () => void;
  onClearLogs: () => void;
  onOpenDocs: (documentId: string) => void;
  resolveSceneId: (target: BehaviorCodeTarget) => string | undefined;
  onFocusTarget: (target: BehaviorCodeTarget) => void | Promise<void>;
  layoutMode: BehaviorLayoutMode;
  onLayoutModeChange: (mode: BehaviorLayoutMode) => void;
  onPendingDraftChange?: (draft: ScriptModule | undefined) => void;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState(() => props.scripts.find((script) => targetMatches(script.target, props.preferredTarget))?.id ?? props.scripts[0]?.id ?? "");
  const [pendingScript, setPendingScript] = useState<ScriptModule>();
  const selected = props.scripts.find((script) => script.id === selectedId)
    ?? (pendingScript?.id === selectedId ? pendingScript : undefined)
    ?? props.scripts[0];
  // 当前脚本的挂载目标始终显示在标题区，避免用户在 2D/3D 切换后误编辑对象。
  const selectedContextLabel = selected ? scriptTargetLabel(selected.target, props.codeTargets, props.locale) : tr(props.locale, "未选择脚本", "No script selected");
  const attachedTarget =
    selected?.target && selected.target.kind !== "scene"
      ? props.codeTargets.find((target) => target.kind === selected.target?.kind && target.id === selected.target.id)
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
    setAiDraftUndo(undefined);
    setAiDraftInserted(false);
  }, [selected?.id, selected?.code, selected?.name, selected?.enabled, selected?.lifecycle.join("|"), selected?.permissions.join("|"), selected?.capabilities.join("|")]);
  useEffect(() => {
    if (pendingScript && props.scripts.some((script) => script.id === pendingScript.id)) setPendingScript(undefined);
  }, [pendingScript, props.scripts]);
  const dirty = Boolean(selected && draft && JSON.stringify(selected) !== JSON.stringify(draft));
  useEffect(() => {
    // 连同无名称草稿一起上报：全局 2D/3D/返回导航需要阻止丢稿，而不是把校验失败
    // 误判成“没有待保存修改”。具体错误由全局导航统一反馈给用户。
    props.onPendingDraftChange?.(dirty ? draft : undefined);
    return () => props.onPendingDraftChange?.(undefined);
  }, [dirty, draft, props.onPendingDraftChange]);
  const runtime = selected ? props.runtimeEntries.find((entry) => entry.module.id === selected.id) : undefined;
  const selectedLogs = useMemo(() => (selected ? props.logs.filter((entry) => entry.moduleId === selected.id) : props.logs), [props.logs, selected?.id]);
  const [logsOpen, setLogsOpen] = useState(false);
  // 默认把注意力留给脚本和诊断；资源与高级声明按需展开，降低首次使用的信息负担。
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [insertRequest, setInsertRequest] = useState<CodeInsertRequest>();
  const [agentOpen, setAgentOpen] = useState(false);
  const [dependenciesOpen, setDependenciesOpen] = useState(false);
  const [versionOpen, setVersionOpen] = useState(false);
  const [agentMode, setAgentMode] = useState<SceneBehaviorAiMode>("generate");
  const [scriptListCollapsed, setScriptListCollapsed] = useState(readBehaviorScriptListCollapsed);
  const [scriptListWidth, setScriptListWidth] = useState(readBehaviorScriptListWidth);
  const [aiDraftInserted, setAiDraftInserted] = useState(false);
  const [aiDraftUndo, setAiDraftUndo] = useState<ScriptModule>();
  const [actionFeedback, setActionFeedback] = useState("");
  const scriptFileInputRef = useRef<HTMLInputElement>(null);
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
  const aiDraftTarget = draft?.target && draft.target.kind !== "scene"
    ? props.codeTargets.find((target) => target.kind === draft.target?.kind && target.id === draft.target.id)
    : props.preferredTarget;
  const aiDraftSceneId = aiDraftTarget ? props.resolveSceneId(aiDraftTarget) : undefined;
  function insertCode(text: string) {
    setInsertRequest({ id: Date.now() + Math.random(), text: text.endsWith("\n") ? text : `${text}\n` });
  }
  function changeAttachedTarget(target: ApplicationScriptTarget) {
    setAiDraftUndo(undefined);
    setAiDraftInserted(false);
    setDraft((current) => {
      if (!current) return current;
      const capability: SceneCapability | undefined =
        target.kind === "object" ? "studio.object" : target.kind === "component" ? "studio.component" : undefined;
      return {
        ...current,
        target,
        capabilities: capability && !current.capabilities.includes(capability) ? [...current.capabilities, capability] : current.capabilities,
      };
    });
  }
  function addScript() {
    const id = `behavior:${crypto.randomUUID()}`;
    const targetCapability: SceneCapability | undefined =
      props.preferredTarget?.runtime === "unity"
        ? "studio.unity"
        : props.preferredTarget?.kind === "component"
          ? "studio.component"
          : props.preferredTarget?.kind === "object"
            ? "studio.object"
            : undefined;
    const script: ScriptModule = {
      id,
      name: tr(props.locale, "新建行为", "New behavior"),
      enabled: true,
      apiVersion: "1.0",
      entrypoint: "behavior",
      runtime: "worker-sandbox",
      code: defaultBehaviorCode(),
      lifecycle: ["onStart", "onUpdate", "onDispose"],
      capabilities: [...(targetCapability ? [targetCapability] : []), "studio.runtime"],
      permissions: ["scene.read", "scene.write"],
      target: props.preferredTarget ? { kind: props.preferredTarget.kind, id: props.preferredTarget.id } : { kind: "scene" },
    };
    setPendingScript(script);
    props.onUpsert(script);
    setSelectedId(id);
    setDraft(structuredClone(script));
  }
  async function importScriptFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])].slice(0, 50);
    event.target.value = "";
    if (!files.length) return;
    try {
      const imported = await Promise.all(files.map(async (file) => createImportedBehaviorScript(file, props.preferredTarget)));
      imported.forEach(props.onUpsert);
      setSelectedId(imported[0]!.id);
      setActionFeedback(tr(props.locale, `已导入 ${imported.length} 个独立脚本`, `Imported ${imported.length} separate scripts`));
    } catch (reason) {
      setActionFeedback(reason instanceof Error ? reason.message : tr(props.locale, "脚本导入失败", "Script import failed"));
    }
  }
  function applyAndRun() {
    if (!draft || !draft.name.trim()) return;
    props.onUpsert(draft);
    props.onRun(draft);
    setAiDraftInserted(false);
    setAiDraftUndo(undefined);
    setActionFeedback(tr(props.locale, "修改已应用，正在运行", "Changes applied; running"));
  }
  function applyChanges() {
    if (!draft || !dirty || !draft.name.trim()) return;
    props.onUpsert(draft);
    setAiDraftInserted(false);
    setAiDraftUndo(undefined);
    globalThis.setTimeout(() => void props.onSaveWorkspace(), 0);
    setActionFeedback(tr(props.locale, "脚本已保存", "Script saved"));
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


  return (
    <section
      className={`behavior-panel layout-${props.layoutMode} ${logsOpen ? "logs-open" : "logs-collapsed"} ${inspectorOpen ? "inspector-open" : "inspector-collapsed"} ${scriptListCollapsed ? "script-list-collapsed" : ""} ${agentOpen ? "agent-open" : ""}`}
      style={{ "--behavior-script-list-width": `${scriptListWidth}px` } as CSSProperties}
      aria-label={tr(props.locale, "场景行为脚本", "Scene behavior scripts")}
    >
      <BehaviorPanelHeader locale={props.locale} layoutMode={props.layoutMode} contextLabel={selectedContextLabel} dirty={dirty} paused={props.paused} running={Boolean(props.runtimeEntries.length)} hasDraft={Boolean(draft)} hasTarget={Boolean(attachedTarget)} agentOpen={agentOpen} dependenciesOpen={dependenciesOpen} versionOpen={versionOpen} inspectorOpen={inspectorOpen} scriptListCollapsed={scriptListCollapsed} onLayoutModeChange={props.onLayoutModeChange} onToggleScriptList={() => { const next = !scriptListCollapsed; setScriptListCollapsed(next); persistBehaviorScriptListCollapsed(next); }} onToggleAgent={() => { setAgentMode("explain"); setDependenciesOpen(false); setVersionOpen(false); setAgentOpen((open) => !open); }} onToggleDependencies={() => { setAgentOpen(false); setVersionOpen(false); setDependenciesOpen((open) => !open); }} onToggleVersion={() => { setAgentOpen(false); setDependenciesOpen(false); setVersionOpen((open) => !open); }} onFocusTarget={() => attachedTarget && leaveForWorkspace(() => props.onFocusTarget(attachedTarget))} onRun={applyAndRun} onPauseResume={props.onPauseResume} onStop={props.onStop} onToggleInspector={() => setInspectorOpen((value) => !value)} onClose={closePanel} />
      <div className="behavior-panel-body">
        {!scriptListCollapsed && <aside className="behavior-script-list">
          <button className="behavior-add" onClick={addScript}>
            <Plus size={13} />
            {tr(props.locale, "新建行为", "New behavior")}
          </button>
          <input ref={scriptFileInputRef} hidden type="file" accept=".js,.mjs,text/javascript,application/javascript" multiple onChange={(event) => void importScriptFiles(event)} />
          <button type="button" onClick={() => scriptFileInputRef.current?.click()}><Upload size={13} /><span><strong>{tr(props.locale, "导入 JS", "Import JS")}</strong><small>{tr(props.locale, "支持多选，保留多文件", "Multi-select; keeps separate files")}</small></span></button>
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
        </aside>}
        {!scriptListCollapsed && <BehaviorScriptListResizer locale={props.locale} width={scriptListWidth} onWidthChange={setScriptListWidth} />}
        {draft ? (
          <>
            <section className="behavior-editor" aria-label={tr(props.locale, "脚本代码编辑器", "Script code editor")}>
              <div className="behavior-editor-toolbar">
                <label>
                  <span className="behavior-field-label">{tr(props.locale, "名称", "Name")}</span>
                  <input aria-label={tr(props.locale, "脚本名称", "Script name")} title={tr(props.locale, "脚本名称", "Script name")} placeholder={tr(props.locale, "脚本名称", "Script name")} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                </label>
                <SceneBehaviorTargetPicker
                  locale={props.locale}
                  value={draft.target}
                  targets={props.codeTargets}
                  {...(props.preferredTarget ? { preferredTarget: props.preferredTarget } : {})}
                  onChange={changeAttachedTarget}
                />
                <label className="behavior-auto-save" title={tr(props.locale, "与二维、三维工作区使用同一自动保存设置", "Uses the same auto-save setting as the 2D and 3D workspaces")}>
                  <input type="checkbox" checked={props.autoSaveEnabled} onChange={(event) => props.onAutoSaveChange(event.target.checked)} />
                  <span>{tr(props.locale, "自动保存", "Auto save")}</span>
                </label>
                <label className="behavior-enabled" aria-label={draft.enabled ? tr(props.locale, "停用脚本", "Disable script") : tr(props.locale, "启用脚本", "Enable script")} title={draft.enabled ? tr(props.locale, "停用脚本", "Disable script") : tr(props.locale, "启用脚本", "Enable script")}>
                  <input aria-label={draft.enabled ? tr(props.locale, "停用脚本", "Disable script") : tr(props.locale, "启用脚本", "Enable script")} type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
                  <Power size={13} aria-hidden="true" />
                </label>
                <button
                  className="behavior-toolbar-icon"
                  type="button"
                  disabled={!aiDraftTarget || !aiDraftSceneId}
                  aria-label={tr(props.locale, "AI 生成草稿", "Generate AI draft")}
                  title={
                    aiDraftTarget && aiDraftSceneId
                      ? tr(props.locale, "生成后先审查，只插入本地编辑器", "Review first; only insert into the local editor")
                      : tr(props.locale, "请先选择有效的 2D、3D 或 Unity 目标", "Select a valid 2D, 3D, or Unity target first")
                  }
                  onClick={() => {
                    setAgentMode("generate");
                    setAgentOpen(true);
                  }}
                >
                  <Sparkles size={13} />
                </button>
                <button className="behavior-save-action" aria-label={tr(props.locale, "保存脚本", "Save script")} title={tr(props.locale, "保存脚本（Ctrl/Cmd+S）", "Save script (Ctrl/Cmd+S)")} disabled={!dirty || !draft.name.trim()} onClick={applyChanges}>
                  <Save size={13} />
                  {tr(props.locale, "保存", "Save")}
                </button>
                <button className="behavior-toolbar-icon" aria-label={tr(props.locale, "下载当前 JS", "Download current JS")} title={tr(props.locale, "下载当前 JS", "Download current JS")} onClick={() => downloadTextFile(draft.code, scriptDownloadFileName(draft.name), "text/javascript;charset=utf-8")}>
                  <Download size={13} />
                </button>
                <button className="behavior-toolbar-icon" aria-label={tr(props.locale, "还原修改", "Revert changes")} title={tr(props.locale, "还原修改", "Revert changes")} disabled={!dirty} onClick={() => { setDraft(structuredClone(selected!)); setAiDraftInserted(false); setAiDraftUndo(undefined); }}>
                  <RotateCcw size={13} />
                </button>
                <button
                  className="danger behavior-toolbar-icon"
                  aria-label={tr(props.locale, `删除脚本“${draft.name}”`, `Delete script “${draft.name}”`)}
                  title={tr(props.locale, "删除脚本", "Delete script")}
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
                moduleSpecifiers={props.dependencies.map((dependency) => dependency.specifier)}
                {...(insertRequest ? { insertRequest } : {})}
                onChange={(code) => {
                  setDraft({ ...draft, code });
                  setAiDraftUndo(undefined);
                  setAiDraftInserted(false);
                }}
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
            </section>
            <SceneBehaviorInspector
              locale={props.locale}
              draft={draft}
              {...(analysis ? { analysis } : {})}
              {...(runtime ? { runtime } : {})}
              codeTargets={props.codeTargets}
              intelligence={props.intelligence}
              onDraftChange={setDraft}
              onInsertCode={insertCode}
            />
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
          {...(aiDraftSceneId ? { sceneId: aiDraftSceneId } : {})}
          {...(aiDraftTarget ? { target: aiDraftTarget } : {})}
          intelligence={props.intelligence}
          initialMode={agentMode}
          canUndoInsert={Boolean(aiDraftUndo && aiDraftInserted)}
          onInsertIntoEditor={(script) => {
            if (draft) setAiDraftUndo(structuredClone(draft));
            setDraft(script);
            setAiDraftInserted(true);
          }}
          onUndoInsert={() => {
            if (!aiDraftUndo) return;
            setDraft(structuredClone(aiDraftUndo));
            setAiDraftUndo(undefined);
            setAiDraftInserted(false);
          }}
          onBack={() => setAgentOpen(false)}
        />
      )}
      {dependenciesOpen && (
        <ScriptDependencyManager
          {...(props.projectId ? { projectId: props.projectId } : {})}
          dependencies={props.dependencies}
          scripts={props.scripts}
          {...(draft?.name ? { activeScriptName: draft.name } : {})}
          onDependenciesChange={props.onDependenciesChange}
          onInsertImport={(snippet) => insertCode(snippet)}
          onClose={() => setDependenciesOpen(false)}
        />
      )}
      {versionOpen && (
        <ScriptVersionManager
          locale={props.locale}
          {...(props.projectId ? { projectId: props.projectId } : {})}
          scripts={props.scripts}
          hasUnappliedDraft={dirty}
          {...(isLocalDesktopMode() ? { unavailableReason: tr(props.locale, "当前为本地工作区；脚本 Git 需要系统 Git 服务，请切换到服务器模式后使用。", "This is a local workspace. Script Git requires the system Git service; switch to server mode to use it.") } : {})}
          onReplaceScripts={props.onReplaceScripts}
          onClose={() => setVersionOpen(false)}
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
