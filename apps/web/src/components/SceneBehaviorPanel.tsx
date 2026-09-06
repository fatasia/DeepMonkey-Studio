import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import type { ApplicationScriptDependency, ApplicationScriptTarget, ScriptModule } from "@bim-studio/contracts";
import type { SceneCapability } from "@bim-studio/scene-sdk";
import { Braces } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { SceneBehaviorManagerEntry } from "../behavior/SceneBehaviorManager";
import { ProfessionalCodeEditor, type CodeInsertRequest } from "./ProfessionalCodeEditor";
import type { SceneScriptIntelligenceContext, SceneScriptTarget } from "../studio/sceneScriptContext";
import { analyzeSceneScript } from "../studio/sceneScriptAnalysis";
import { SceneBehaviorAgentWorkspace, type SceneBehaviorAiMode } from "./SceneBehaviorAgentWorkspace";
import { BehaviorEditorToolbar } from "./BehaviorEditorToolbar";
import { AuthorBehaviorDebugNotice } from "./AuthorBehaviorDebugNotice";
import { createSdkExampleScript, type SdkExampleInsertRequest } from "../behavior/sdkExampleInsertion";
import { useBehaviorDraft } from "./useBehaviorDraft";
import { BehaviorPanelHeader } from "./BehaviorPanelHeader";
import { BehaviorConsole } from "./BehaviorConsole";
import { BehaviorScriptList } from "./BehaviorScriptList";
import type { BehaviorLogEntry } from "../behavior/behaviorLogModel";
import type { AuthorBehaviorScope } from "../behavior/authorBehaviorDocument";
import type { BehaviorLayoutMode } from "../appDefaults";
import { BehaviorScriptListResizer, persistBehaviorScriptListCollapsed, readBehaviorScriptListCollapsed, readBehaviorScriptListWidth } from "./BehaviorScriptListResizer";
import { downloadTextFile } from "../browserDownload";
import { ScriptDependencyManager } from "./ScriptDependencyManager";
import { ScriptVersionManager } from "./ScriptVersionManager";
import "./SceneBehaviorLayout.css";
import { SceneBehaviorInspector } from "./SceneBehaviorInspector";
import { isLocalDesktopMode } from "../adapters/desktopRuntimeMode";
import { createImportedBehaviorScript, scriptDownloadFileName } from "../behavior/scriptFileTransfer";
import {
  defaultBehaviorCode,
  scriptTargetLabel,
} from "./sceneBehaviorPanelModel";
export { sceneScriptResourceSnippet } from "./sceneBehaviorPanelModel";
export type SceneBehaviorLogEntry = BehaviorLogEntry;
export type BehaviorCodeTarget = SceneScriptTarget;
export function SceneBehaviorPanel(props: {
  locale: AppLocale;
  projectId?: string;
  applicationId?: string;
  sdkExampleRequest?: SdkExampleInsertRequest;
  onSdkExampleConsumed?: (requestId: string) => void;
  scripts: readonly ScriptModule[];
  dependencies: readonly ApplicationScriptDependency[];
  runtimeEntries: readonly SceneBehaviorManagerEntry[];
  logs: readonly SceneBehaviorLogEntry[];
  codeTargets: readonly BehaviorCodeTarget[];
  intelligence: SceneScriptIntelligenceContext;
  preferredTarget?: BehaviorCodeTarget;
  paused: boolean;
  hasSession?: boolean;
  canStep?: boolean;
  onStep?: () => void;
  onUpsert: (script: ScriptModule) => void;
  autoSaveEnabled: boolean;
  onAutoSaveChange: (enabled: boolean) => void;
  onSaveWorkspace: () => void | Promise<unknown>;
  onDelete: (scriptId: string) => void;
  onDependenciesChange: (dependencies: readonly ApplicationScriptDependency[]) => void | Promise<void>;
  onReplaceScripts: (scripts: readonly ScriptModule[]) => void | Promise<void>;
  onRun: (draft?: ScriptModule, scope?: AuthorBehaviorScope) => void | Promise<void>;
  onDebug?: (draft: ScriptModule) => void | Promise<void>;
  debugging?: boolean;
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
  const [feedback, setFeedback] = useState<{ scriptId: string | undefined; message: string }>({ scriptId: undefined, message: "" });
  const { selected, draft, setDraft, dirty, prepareLeave, selectScript, addScripts, captureOperation } = useBehaviorDraft({
    scripts: props.scripts, ...(props.preferredTarget ? { preferredTarget: props.preferredTarget } : {}),
    onUpsert: props.onUpsert,
    onInvalidName: () => setActionFeedback(tr(props.locale, "请先填写脚本名称", "Enter a script name first")),
  });
  const selectedContextLabel = draft ? scriptTargetLabel(draft.target, props.codeTargets, props.locale) : tr(props.locale, "未选择脚本", "No script selected");
  const attachedTarget = draft?.target && draft.target.kind !== "scene"
    ? props.codeTargets.find(target => target.kind === draft.target?.kind && target.id === draft.target.id)
    : undefined;
  const actionFeedback = feedback.scriptId === draft?.id ? feedback.message : "";
  function setActionFeedback(message: string, scriptId = draft?.id) { setFeedback({ scriptId, message }); }
  const consumedExample = useRef<string | undefined>(undefined);
  useEffect(() => {
    const request = props.sdkExampleRequest;
    if (!request || consumedExample.current === request.requestId) return;
    consumedExample.current = request.requestId;
    try {
      if (request.projectId === props.projectId && request.applicationId === props.applicationId) {
        const script = createSdkExampleScript(request.exampleId, props.scripts);
        if (addScripts([script])) setActionFeedback(tr(props.locale, "样例已插入，可修改并试运行；保存遵循当前自动保存设置", "Example inserted. Edit and test it; saving follows your auto-save setting."), script.id);
      }
    } catch (reason) {
      setActionFeedback(tr(props.locale, "样例插入失败：", "Could not insert example: ") + (reason instanceof Error ? reason.message : String(reason)));
    } finally {
      props.onSdkExampleConsumed?.(request.requestId);
    }
  }, [props.sdkExampleRequest, props.projectId, props.applicationId]);
  const debugContext = `${draft?.id ?? ""}:${draft?.target?.kind ?? ""}:${draft?.target && draft.target.kind !== "scene" ? draft.target.id : ""}`;
  const previousDebugContext = useRef(debugContext);
  useEffect(() => {
    if (previousDebugContext.current !== debugContext && props.debugging) props.onStop();
    previousDebugContext.current = debugContext;
  }, [debugContext, props.debugging, props.onStop]);
  useEffect(() => {
    setAiDraftUndo(undefined);
    setAiDraftInserted(false);
    setFeedback(current => current.scriptId === draft?.id ? current : { scriptId: undefined, message: "" });
  }, [draft?.id]);
  useEffect(() => {
    // 连同无名称草稿一起上报：全局 2D/3D/返回导航需要阻止丢稿，而不是把校验失败
    // 误判成“没有待保存修改”。具体错误由全局导航统一反馈给用户。
    props.onPendingDraftChange?.(dirty ? draft : undefined);
    return () => props.onPendingDraftChange?.(undefined);
  }, [dirty, draft, props.onPendingDraftChange]);
  const runtime = selected ? props.runtimeEntries.find((entry) => entry.module.id === selected.id) : undefined;
  const [logsOpen, setLogsOpen] = useState(false);
  // 默认把注意力留给脚本和诊断；资源与高级声明按需展开，降低首次使用的信息负担。
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [insertRequest, setInsertRequest] = useState<CodeInsertRequest>();
  const [revealRequest, setRevealRequest] = useState<{ id: number; line: number; column: number }>();
  const [agentOpen, setAgentOpen] = useState(false);
  const [dependenciesOpen, setDependenciesOpen] = useState(false);
  const [versionOpen, setVersionOpen] = useState(false);
  const [agentMode, setAgentMode] = useState<SceneBehaviorAiMode>("generate");
  const [scriptListCollapsed, setScriptListCollapsed] = useState(readBehaviorScriptListCollapsed);
  const [scriptListWidth, setScriptListWidth] = useState(readBehaviorScriptListWidth);
  const [aiDraftInserted, setAiDraftInserted] = useState(false);
  const [aiDraftUndo, setAiDraftUndo] = useState<ScriptModule>();
  const [saving, setSaving] = useState(false);
  const [runScope, setRunScope] = useState<AuthorBehaviorScope>("current");
  const savingRef = useRef(false);
  const runSequence = useRef(0);
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
    addScripts([script]);
  }
  async function importScriptFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])].slice(0, 50);
    event.target.value = "";
    if (!files.length || !prepareLeave()) return;
    const operation = captureOperation();
    try {
      const imported = await Promise.all(files.map(async (file) => createImportedBehaviorScript(file, props.preferredTarget)));
      const selectFirst = operation.isCurrent();
      if (!operation.isOpen() || !addScripts(imported, selectFirst)) return;
      setActionFeedback(tr(props.locale, `已导入 ${imported.length} 个独立脚本`, `Imported ${imported.length} separate scripts`), selectFirst ? imported[0]!.id : draft?.id);
    } catch (reason) {
      if (operation.isCurrent()) setActionFeedback(reason instanceof Error ? reason.message : tr(props.locale, "脚本导入失败", "Script import failed"));
    }
  }
  async function applyAndRun(mode?: unknown) {
    const debug = mode === true;
    if (!draft || !draft.name.trim()) return;
    const sequence = ++runSequence.current;
    const operation = captureOperation();
    setAiDraftInserted(false);
    setAiDraftUndo(undefined);
    setLogsOpen(true);
    setActionFeedback(tr(props.locale, "正在准备试运行…", "Preparing test run…"));
    try {
      if (debug && props.onDebug) await props.onDebug(draft);
      else await props.onRun(draft, runScope);
      if (sequence === runSequence.current && operation.isCurrent()) setActionFeedback(tr(props.locale, "试运行已提交，请查看运行状态与日志", "Test run submitted; check runtime status and logs"));
    } catch (reason) {
      if (sequence === runSequence.current && operation.isCurrent()) setActionFeedback(reason instanceof Error ? reason.message : String(reason));
    }
  }
  function stopRun() {
    runSequence.current++;
    props.onStop();
    setActionFeedback(tr(props.locale, "试运行已停止，编辑草稿保持不变", "Test stopped; the editing draft is unchanged"));
  }
  async function applyChanges() {
    if (!draft || !draft.name.trim() || savingRef.current) return;
    const operation = captureOperation();
    savingRef.current = true;
    setSaving(true);
    props.onUpsert(draft);
    setAiDraftInserted(false);
    setAiDraftUndo(undefined);
    setActionFeedback(tr(props.locale, "正在保存脚本…", "Saving script…"));
    try {
      const saved = await props.onSaveWorkspace();
      if (operation.isCurrent()) setActionFeedback(saved ? tr(props.locale, "脚本已保存", "Script saved") : tr(props.locale, "保存未完成，草稿已保留，请重试", "Save incomplete; draft retained. Retry saving."));
    } catch (reason) {
      if (operation.isCurrent()) setActionFeedback(tr(props.locale, "保存失败，草稿已保留：", "Save failed; draft retained: ") + (reason instanceof Error ? reason.message : String(reason)));
    } finally {
      savingRef.current = false;
      if (operation.isOpen()) setSaving(false);
    }
  }

  function leaveForWorkspace(action: () => void | Promise<void>) {
    if (!prepareLeave()) return;
    if (dirty && draft) {
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
      <BehaviorPanelHeader locale={props.locale} layoutMode={props.layoutMode} contextLabel={selectedContextLabel} dirty={dirty} paused={props.paused} running={props.runtimeEntries.some((entry) => ["initializing", "running", "paused"].includes(entry.diagnostics.status))} hasSession={props.hasSession ?? Boolean(props.runtimeEntries.length)} canStep={props.canStep ?? false} onStep={props.onStep ?? (() => undefined)} runScope={runScope} onRunScopeChange={setRunScope} hasDraft={Boolean(draft)} hasTarget={Boolean(attachedTarget)} agentOpen={agentOpen} dependenciesOpen={dependenciesOpen} versionOpen={versionOpen} inspectorOpen={inspectorOpen} scriptListCollapsed={scriptListCollapsed} onLayoutModeChange={props.onLayoutModeChange} onToggleScriptList={() => { const next = !scriptListCollapsed; setScriptListCollapsed(next); persistBehaviorScriptListCollapsed(next); }} onToggleAgent={() => { setAgentMode("explain"); setDependenciesOpen(false); setVersionOpen(false); setAgentOpen((open) => !open); }} onToggleDependencies={() => { setAgentOpen(false); setVersionOpen(false); setDependenciesOpen((open) => !open); }} onToggleVersion={() => { setAgentOpen(false); setDependenciesOpen(false); setVersionOpen((open) => !open); }} onFocusTarget={() => attachedTarget && leaveForWorkspace(() => props.onFocusTarget(attachedTarget))} onRun={() => void applyAndRun()} onDebug={props.onDebug ? () => { void applyAndRun(true); } : undefined} onPauseResume={props.onPauseResume} onStop={stopRun} onToggleInspector={() => setInspectorOpen((value) => !value)} onClose={closePanel} />
      <div className="behavior-panel-body">
        {!scriptListCollapsed && <BehaviorScriptList locale={props.locale} scripts={props.scripts} entries={props.runtimeEntries} targets={props.codeTargets} selectedId={selected?.id}
          onAdd={addScript} onImport={(event) => void importScriptFiles(event)} onSelect={selectScript}
          onCollapse={() => { setScriptListCollapsed(true); persistBehaviorScriptListCollapsed(true); }} />}
        {!scriptListCollapsed && <BehaviorScriptListResizer locale={props.locale} width={scriptListWidth} onWidthChange={setScriptListWidth} />}
        {draft ? (
          <>
            <section className="behavior-editor" aria-label={tr(props.locale, "脚本代码编辑器", "Script code editor")}>
              <BehaviorEditorToolbar locale={props.locale} draft={draft} targets={props.codeTargets} {...(props.preferredTarget ? { preferredTarget: props.preferredTarget } : {})}
                dirty={dirty} saving={saving} canGenerate={Boolean(aiDraftTarget && aiDraftSceneId)} showAutoSave={props.layoutMode === "window"}
                autoSaveEnabled={props.autoSaveEnabled} onAutoSaveChange={props.onAutoSaveChange} onChange={setDraft} onTargetChange={changeAttachedTarget}
                onSave={() => void applyChanges()} onGenerate={() => { setAgentMode("generate"); setAgentOpen(true); }}
                onDownload={() => downloadTextFile(draft.code, scriptDownloadFileName(draft.name), "text/javascript;charset=utf-8")}
                onRevert={() => { setDraft(structuredClone(selected!)); setAiDraftInserted(false); setAiDraftUndo(undefined); }}
                onDelete={() => { if (window.confirm(tr(props.locale, `删除“${draft.name}”吗？`, `Delete “${draft.name}”?`))) props.onDelete(draft.id); }} />
              {props.debugging && <AuthorBehaviorDebugNotice locale={props.locale} entries={props.runtimeEntries} onStart={props.onPauseResume} />}
              <ProfessionalCodeEditor
                locale={props.locale}
                path={`bim-studio://behavior/${draft.id}.js`}
                value={draft.code}
                intelligence={props.intelligence}
                diagnostics={editorDiagnostics}
                {...(revealRequest ? { revealRequest } : {})}
                moduleSpecifiers={props.dependencies.map((dependency) => dependency.specifier)}
                {...(insertRequest ? { insertRequest } : {})}
                onChange={(code) => {
                  setActionFeedback("");
                  setDraft({ ...draft, code });
                  setAiDraftUndo(undefined);
                  setAiDraftInserted(false);
                }}
                onSave={() => {
                  applyChanges();
                }}
                onRun={() => void applyAndRun()}
                onOpenDocs={() => props.onOpenDocs("behavior-script")}
              />
              <footer>
                <span>JavaScript · Scene SDK 1.0</span>
                <span>
                  {draft.code.split("\n").length} {tr(props.locale, "行", "lines")}
                </span>
                <em className={dirty ? "pending" : runtime?.diagnostics.status === "error" ? "error" : "ready"} role="status" aria-live="polite">
                  {!draft.name.trim() ? tr(props.locale, "请先填写脚本名称", "Enter a script name first") : actionFeedback || (dirty
                    ? aiDraftInserted
                      ? tr(props.locale, "AI 草稿待应用", "AI draft awaiting apply")
                      : tr(props.locale, "有未应用的修改", "Unapplied changes")
                    : runtime?.diagnostics.status === "error"
                      ? tr(props.locale, "运行失败，请查看问题", "Run failed; review problems")
                      : tr(props.locale, "编辑器与应用状态一致", "Editor is in sync"))}
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
      <BehaviorConsole locale={props.locale} logs={props.logs} entries={props.runtimeEntries} scripts={props.scripts} selectedId={selected?.id} open={logsOpen}
        onToggle={() => setLogsOpen((open) => !open)} onClear={props.onClearLogs}
        onReveal={(id, location) => { if (selectScript(id)) setRevealRequest({ id: Date.now(), ...location }); }} />
    </section>
  );
}
