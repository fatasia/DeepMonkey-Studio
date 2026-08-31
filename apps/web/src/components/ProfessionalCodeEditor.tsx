import Editor, { loader, type BeforeMount, type OnMount } from "@monaco-editor/react";
import type * as monaco from "monaco-editor";
import { BookOpen, Braces, CheckCircle2, Command, TriangleAlert } from "lucide-react";
import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { STUDIO_API_DECLARATIONS } from "../studio/studioApi";
import type { SceneScriptIssue } from "../studio/sceneScriptAnalysis";
import { buildSceneScriptTypeDeclarations, type SceneScriptIntelligenceContext } from "../studio/sceneScriptContext";
import { apiDocumentationAt, contextualSuggestions, docsMarkdown, isWorkerBehaviorModel, referenceLabel, snippet, stringLiteralAt } from "./professionalCodeIntelligence";

const monacoEnvironmentTarget = globalThis as typeof globalThis & { MonacoEnvironment?: { getWorker(moduleId: string, label: string): Worker } };
monacoEnvironmentTarget.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    return label === "javascript" || label === "typescript"
      ? new Worker(new URL("../workers/monacoTypescript.worker.ts", import.meta.url), { type: "module", name: "studio-typescript" })
      : new Worker(new URL("../workers/monacoEditor.worker.ts", import.meta.url), { type: "module", name: "studio-editor" });
  },
};

let monacoLoadPromise: Promise<typeof import("monaco-editor")> | undefined;

function loadMonacoEditor(): Promise<typeof import("monaco-editor")> {
  monacoLoadPromise ??= import("monaco-editor")
    .then(async (api) => {
      const typescript = await import("monaco-editor/language/typescript/monaco.contribution.js");
      // Monaco 0.56 的语言贡献模块改为显式导出，不再自动写回 languages 命名空间。
      const configuredApi = { ...api, languages: { ...api.languages, typescript } } as typeof import("monaco-editor");
      loader.config({ monaco: configuredApi });
      return configuredApi;
    })
    .catch((error: unknown) => {
      monacoLoadPromise = undefined;
      throw error;
    });
  return monacoLoadPromise;
}

const PLATFORM_TYPES = `
type Vec3 = [number, number, number];
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
interface StudioProjectIdentifiers {}
type ProjectIdentifier<K extends string> = K extends keyof StudioProjectIdentifiers ? StudioProjectIdentifiers[K] : string;
type ProjectObjectId = ProjectIdentifier<"object">;
type ProjectComponentId = ProjectIdentifier<"component">;
type ProjectUnityComponentId = ProjectIdentifier<"unityComponent">;
type ProjectDataKey = ProjectIdentifier<"dataKey">;
type ProjectSceneId = ProjectIdentifier<"scene">;
type ProjectPageId = ProjectIdentifier<"page">;
type ProjectCameraViewId = ProjectIdentifier<"cameraView">;
interface SceneObjectHandle {
  readonly id: string;
  show(): void;
  hide(): void;
  select(): void;
  focus(): void;
  setPosition(x: number, y: number, z: number): void;
  setRotation(x: number, y: number, z: number): void;
  setScale(x: number, y?: number, z?: number): void;
  playAnimation(name?: string): void;
  pauseAnimation(name?: string): void;
  stopAnimation(name?: string): void;
  seekAnimation(seconds: number, name?: string): void;
  setColor(color: string): void;
  setOpacity(opacity: number): void;
}
interface SceneComponentHandle {
  readonly id: string;
  update(patch: Record<string, JsonValue>): void;
  show(): void;
  hide(): void;
  rename(name: string): void;
}
interface SceneUnityHandle {
  readonly id: string;
  setProperty(key: string, value: JsonValue): void;
  setProperties(values: Record<string, JsonValue>): void;
  invoke(action: string, objectId?: string, value?: JsonValue): void;
  switchScene(scene: string): void;
}
interface StudioComponentHandle {
  readonly id: string;
  readonly name?: string;
  readonly pageId: string;
  readonly kind: "data-widget" | "scene-viewport";
  update(patch: Record<string, unknown>): void;
  show(): void;
  hide(): void;
}
${STUDIO_API_DECLARATIONS}
interface SceneCommand { id?: string; type: string; [key: string]: JsonValue | undefined; }
interface StudioProjectEventNames {}
type ProjectEventName = keyof StudioProjectEventNames extends never ? string : keyof StudioProjectEventNames;
interface BehaviorSceneEvent {
  readonly type: "scene.ready" | "scene.disposed" | "selection.changed" | "object.event" | "business.event" | "data.received" | string;
  readonly name?: ProjectEventName;
  readonly sceneId?: string;
  readonly sourceModuleId?: string;
  readonly target?: unknown;
  readonly data?: JsonValue;
  readonly timestamp?: string;
}
interface BehaviorContext {
  readonly sceneId: string;
  readonly target: { readonly kind: "scene" } | { readonly kind: "object" | "component"; readonly id: string };
  readonly self?: SceneObjectHandle | SceneComponentHandle;
  readonly deltaMs: number;
  readonly elapsedMs: number;
  readonly deltaTime: number;
  readonly elapsedTime: number;
  readonly state: Record<string, unknown>;
  readonly data?: JsonValue;
  readonly event?: BehaviorSceneEvent;
  object(id: ProjectObjectId): SceneObjectHandle | undefined;
  objects(query?: string): readonly SceneObjectHandle[];
  command(command: SceneCommand): void;
  getData(key: ProjectDataKey): JsonValue | undefined;
  setData(key: ProjectDataKey, value: JsonValue): void;
  emit(name: ProjectEventName, payload?: JsonValue): void;
  readonly THREE: typeof import("three");
  readonly studio: StudioAPI;
  readonly net: StudioNetworkAPI;
  log(message: string, detail?: unknown): void;
}
interface StudioNetworkResult<T = JsonValue> { readonly ok: true; readonly status: number; readonly data: T; readonly value: JsonValue; }
interface StudioNetworkFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params?: Record<string, string | number | boolean | null>;
  body?: JsonValue;
  credentialRef?: string;
  variables?: Record<string, JsonValue>;
  select?: { jsonPath?: string; field?: string };
}
interface StudioNetworkAPI {
  fetch<T = JsonValue>(endpoint: string, options?: StudioNetworkFetchOptions): Promise<StudioNetworkResult<T>>;
  request<T = JsonValue>(binding: Record<string, unknown>, variables?: Record<string, JsonValue>): Promise<StudioNetworkResult<T>>;
}
interface InteractionContext {
  readonly engine: unknown;
  readonly THREE: typeof import("three");
  readonly target: { kind: "object" | "widget"; modelId?: string; layerId?: string; widgetId?: string };
  readonly event: { type: string; payload?: JsonValue };
  action(type: string, options?: Record<string, JsonValue>): Promise<void>;
  getData(key: string): JsonValue | undefined;
  setData(key: string, value: JsonValue): void;
  log(message: string, detail?: unknown): void;
}
declare const ctx: BehaviorContext & InteractionContext;
declare const studio: StudioAPI;
declare const app: unknown;
declare const engine: unknown;
declare const THREE: typeof import("three");
declare const net: StudioNetworkAPI;
declare function fetch<T = JsonValue>(endpoint: string, options?: StudioNetworkFetchOptions): Promise<StudioNetworkResult<T>>;
declare function onStart(ctx: BehaviorContext): void | Promise<void>;
declare function onUpdate(ctx: BehaviorContext): void | Promise<void>;
declare function onFixedUpdate(ctx: BehaviorContext): void | Promise<void>;
declare function onData(ctx: BehaviorContext): void | Promise<void>;
declare function onEvent(ctx: BehaviorContext): void | Promise<void>;
declare function onStop(ctx: BehaviorContext): void | Promise<void>;
declare function onDispose(ctx: BehaviorContext): void | Promise<void>;
`;

let configured = false;
const intelligenceContexts = new Map<string, SceneScriptIntelligenceContext>();

interface CodeEditorBoundaryProps {
  locale: AppLocale;
  value: string;
  children: ReactNode;
  onChange: (value: string) => void;
  onSave?: () => void;
  onRun?: () => void;
}

class CodeEditorBoundary extends Component<CodeEditorBoundaryProps, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Professional code editor failed; using the safe editor fallback", error, info);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="professional-code-fallback" role="alert">
        <div>
          <TriangleAlert size={14} />
          <span>
            <strong>{tr(this.props.locale, "代码智能服务加载失败", "Code intelligence failed to load")}</strong>
            <small>{tr(this.props.locale, "已切换到安全编辑模式，代码仍可编辑和保存。", "Safe editing mode is active; code can still be edited and saved.")}</small>
          </span>
        </div>
        <textarea value={this.props.value} onChange={(event) => this.props.onChange(event.target.value)} spellCheck={false} />
        <footer>
          {this.props.onRun && <button onClick={this.props.onRun}>{tr(this.props.locale, "运行", "Run")}</button>}
          {this.props.onSave && (
            <button className="primary" onClick={this.props.onSave}>
              {tr(this.props.locale, "保存", "Save")}
            </button>
          )}
          <button onClick={() => this.setState({ error: null })}>{tr(this.props.locale, "重试智能编辑器", "Retry smart editor")}</button>
        </footer>
      </div>
    );
  }
}

export interface CodeInsertRequest {
  id: number;
  text: string;
}

/** 为浏览器恢复测试提供不暴露源码内容的轻量指纹。 */
export function codeContentFingerprint(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${value.length}-${(hash >>> 0).toString(36)}`;
}

export function ProfessionalCodeEditor({
  locale,
  value,
  path,
  height = "100%",
  compact = false,
  insertRequest,
  intelligence,
  diagnostics = [],
  onChange,
  onSave,
  onRun,
  onOpenDocs,
}: {
  locale: AppLocale;
  value: string;
  path: string;
  height?: string | number;
  compact?: boolean;
  insertRequest?: CodeInsertRequest;
  intelligence?: SceneScriptIntelligenceContext;
  diagnostics?: readonly SceneScriptIssue[];
  onChange: (value: string) => void;
  onSave?: () => void;
  onRun?: () => void;
  onOpenDocs?: () => void;
}) {
  const [languageProblems, setLanguageProblems] = useState(0);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [monacoApi, setMonacoApi] = useState<typeof import("monaco-editor")>();
  const [loadError, setLoadError] = useState<Error | undefined>(undefined);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const monacoApiRef = useRef<typeof import("monaco-editor") | undefined>(undefined);
  const lastInsertRequestRef = useRef(0);
  const intelligenceTypesRef = useRef<monaco.IDisposable | undefined>(undefined);
  const problems = languageProblems + diagnostics.length;
  const sortedDiagnostics = useMemo(() => [...diagnostics].sort((left, right) => left.line - right.line || left.column - right.column), [diagnostics]);

  useEffect(() => {
    let active = true;
    setLoadError(undefined);
    void loadMonacoEditor()
      .then((api) => {
        if (!active) return;
        monacoApiRef.current = api;
        setMonacoApi(api);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error : new Error(String(error)));
      });
    return () => {
      active = false;
    };
  }, [loadAttempt]);

  useEffect(() => {
    if (!intelligence) return;
    intelligenceContexts.set(path, intelligence);
    return () => {
      if (intelligenceContexts.get(path) === intelligence) intelligenceContexts.delete(path);
    };
  }, [intelligence, path]);

  useEffect(() => {
    intelligenceTypesRef.current?.dispose();
    intelligenceTypesRef.current = undefined;
    if (!monacoApi || !intelligence) return;
    const javascriptDefaults = (monacoApi.languages.typescript as unknown as { javascriptDefaults: { addExtraLib(content: string, filePath?: string): monaco.IDisposable } })
      .javascriptDefaults;
    intelligenceTypesRef.current = javascriptDefaults.addExtraLib(
      buildSceneScriptTypeDeclarations(intelligence),
      `bim-studio://types/project-context-${encodeURIComponent(path)}.d.ts`,
    );
    return () => {
      intelligenceTypesRef.current?.dispose();
      intelligenceTypesRef.current = undefined;
    };
  }, [intelligence, monacoApi, path]);

  useEffect(() => {
    const api = monacoApiRef.current ?? monacoApi;
    const model = editorRef.current?.getModel();
    if (!api || !model) return;
    api.editor.setModelMarkers(
      model,
      "bim-studio-scene-analysis",
      diagnostics.map((issue) => ({
        severity: issue.severity === "error" ? api.MarkerSeverity.Error : api.MarkerSeverity.Warning,
        message: issue.message,
        startLineNumber: issue.line,
        startColumn: issue.column,
        endLineNumber: issue.line,
        endColumn: Math.max(issue.column + 1, issue.endColumn),
        source: "BIM Studio",
      })),
    );
    return () => api.editor.setModelMarkers(model, "bim-studio-scene-analysis", []);
  }, [diagnostics, monacoApi]);

  useEffect(() => {
    if (!insertRequest || insertRequest.id <= lastInsertRequestRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;
    lastInsertRequestRef.current = insertRequest.id;
    const selection = editor.getSelection();
    const RangeConstructor = monacoApiRef.current?.Range ?? monacoApi?.Range;
    if (!selection && !RangeConstructor) return;
    const range = selection ?? new RangeConstructor!(1, 1, 1, 1);
    const prefix = range.startColumn > 1 && !insertRequest.text.startsWith("\n") ? "\n" : "";
    editor.executeEdits("studio-library-insert", [{ range, text: `${prefix}${insertRequest.text}`, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    editor.focus();
  }, [insertRequest, monacoApi]);

  const beforeMount: BeforeMount = (api) => {
    if (configured) return;
    const typescript = api.languages.typescript;
    if (!typescript?.javascriptDefaults) throw new Error("Monaco JavaScript language service is unavailable");
    typescript.javascriptDefaults.setEagerModelSync(true);
    typescript.javascriptDefaults.setCompilerOptions({
      allowNonTsExtensions: true,
      allowJs: true,
      checkJs: true,
      module: api.languages.typescript.ModuleKind.ESNext,
      moduleResolution: api.languages.typescript.ModuleResolutionKind.NodeJs,
      target: api.languages.typescript.ScriptTarget.ES2022,
    });
    typescript.javascriptDefaults.addExtraLib(PLATFORM_TYPES, "bim-studio://types/scene-sdk.d.ts");
    api.languages.registerCompletionItemProvider("javascript", {
      triggerCharacters: ['"', "'"],
      provideCompletionItems(model: monaco.editor.ITextModel, position: monaco.Position) {
        const range = new api.Range(position.lineNumber, position.column, position.lineNumber, position.column);
        const workerBehavior = isWorkerBehaviorModel(model);
        const contextual = contextualSuggestions(api, model, position, intelligenceContexts.get(model.uri.toString()), workerBehavior);
        if (contextual.length) return { suggestions: contextual };
        const docs = docsMarkdown("场景脚本 API", "Scene script API", "/docs/behavior-script");
        const common = [
          snippet(api, "onStart", "生命周期：场景启动", 'function onStart(ctx) {\n\tctx.log("Scene started", { sceneId: ctx.sceneId });\n}', range, docs),
          snippet(api, "onUpdate", "生命周期：逐帧更新", 'function onUpdate(ctx) {\n\tctx.object("object-id")?.setRotation(0, ctx.elapsedTime, 0);\n}', range, docs),
          snippet(
            api,
            "data binding",
            "读取实时数据并驱动对象",
            'const value = ctx.getData("device.temperature");\nif (typeof value === "number") {\n\tctx.object("device-id")?.setColor(value > 80 ? "#ef4444" : "#22c55e");\n}',
            range,
            docs,
          ),
          snippet(api, "studio object", "统一 API：操作场景对象", 'const agv = studio.object("AGV-01");\nagv?.setPosition(12, 0, 6);\nagv?.focus();', range, docs),
          snippet(
            api,
            "gateway fetch",
            "通过服务器代理访问 HTTP 接口",
            'const response = await studio.net.fetch("https://api.example.com/telemetry", {\n\tmethod: "GET",\n\tcredentialRef: "factory-api"\n});\nstudio.log("telemetry", response.value);',
            range,
            docs,
          ),
          snippet(
            api,
            "Three.js math",
            "使用完整 Three.js 命名空间进行计算",
            "const direction = new THREE.Vector3(1, 0, 1).normalize();\nconst next = direction.multiplyScalar(ctx.deltaTime * 2);",
            range,
            docs,
          ),
        ];
        return {
          suggestions: workerBehavior
            ? common
            : [
                ...common,
                snippet(
                  api,
                  "studio camera",
                  "统一 API：相机与漫游",
                  'studio.camera.setPose([12, 6, 12], [0, 1, 0], { near: 0.05, far: 100000 });\nstudio.camera.setMode("firstPerson");\nstudio.camera.setCollision(true, 0.32);',
                  range,
                  docs,
                ),
                snippet(api, "studio scene", "统一 API：场景环境和播放", 'studio.scene.setWeather("sunny");\nstudio.animation.play();', range, docs),
              ],
        };
      },
    });
    api.languages.registerHoverProvider("javascript", {
      provideHover(model: monaco.editor.ITextModel, position: monaco.Position) {
        const context = intelligenceContexts.get(model.uri.toString());
        const literal = stringLiteralAt(model, position);
        if (context && literal) {
          const target = context.targets.find((item) => item.id === literal.value);
          if (target)
            return {
              range: literal.range,
              contents: [
                {
                  value: `**${target.name}** · ${target.kind === "object" ? "场景对象" : "页面组件"}\n\n${target.context} · \`${target.id}\`\n\n[打开场景脚本文档](/docs/behavior-script)`,
                },
              ],
            };
          if (context.dataKeys.includes(literal.value))
            return {
              range: literal.range,
              contents: [{ value: `**数据键** · \`${literal.value}\`\n\n可用于 \`getData\` / \`setData\` / \`onData\`。\n\n[打开数据与脚本文档](/docs/studio-api)` }],
            };
          if (context.eventNames.includes(literal.value))
            return {
              range: literal.range,
              contents: [{ value: `**场景事件** · \`${literal.value}\`\n\n可用于 \`emit\` 与 \`onEvent\`。\n\n[打开事件文档](/docs/behavior-script)` }],
            };
          const reference = context.references.find((item) => item.id === literal.value);
          if (reference)
            return {
              range: literal.range,
              contents: [
                { value: `**${referenceLabel(reference.kind)}** · ${reference.name}\n\n${reference.context} · \`${reference.id}\`\n\n[打开场景脚本文档](/docs/studio-api)` },
              ],
            };
        }
        const apiDocumentation = apiDocumentationAt(model, position);
        if (apiDocumentation)
          return {
            range: apiDocumentation.range,
            contents: [{ value: `**${apiDocumentation.title}**\n\n${apiDocumentation.description}\n\n[打开关联文档](${apiDocumentation.href})` }],
          };
      },
    });
    configured = true;
  };

  const onMount: OnMount = (editor, api) => {
    editorRef.current = editor;
    monacoApiRef.current = api;
    if (onSave) editor.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.KeyS, onSave);
    if (onRun) editor.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.Enter, onRun);
    if (onOpenDocs)
      editor.addAction({
        id: "bim-studio.open-script-docs",
        label: tr(locale, "BIM Studio：打开场景 API 文档", "BIM Studio: Open scene API docs"),
        keybindings: [api.KeyMod.CtrlCmd | api.KeyCode.F1],
        run: () => onOpenDocs(),
      });
    api.editor.setModelMarkers(
      editor.getModel()!,
      "bim-studio-scene-analysis",
      diagnostics.map((issue) => ({
        severity: issue.severity === "error" ? api.MarkerSeverity.Error : api.MarkerSeverity.Warning,
        message: issue.message,
        startLineNumber: issue.line,
        startColumn: issue.column,
        endLineNumber: issue.line,
        endColumn: Math.max(issue.column + 1, issue.endColumn),
        source: "BIM Studio",
      })),
    );
    editor.focus();
  };

  function revealDiagnostic(issue: SceneScriptIssue) {
    const editor = editorRef.current;
    if (!editor) return;
    editor.setPosition({ lineNumber: issue.line, column: issue.column });
    editor.revealLineInCenter(issue.line);
    // 点击诊断按钮后再恢复编辑器焦点，避免浏览器在 click 结束时把焦点抢回按钮。
    window.requestAnimationFrame(() => editor.focus());
    setProblemsOpen(false);
  }

  if (!monacoApi) {
    if (loadError)
      return (
        <div className="professional-code-fallback" role="alert">
          <div>
            <TriangleAlert size={14} />
            <span>
              <strong>{tr(locale, "代码智能服务加载失败", "Code intelligence failed to load")}</strong>
              <small>{loadError.message}</small>
            </span>
          </div>
          <textarea value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} />
          <footer>
            {onRun && <button onClick={onRun}>{tr(locale, "运行", "Run")}</button>}
            {onSave && (
              <button className="primary" onClick={onSave}>
                {tr(locale, "保存", "Save")}
              </button>
            )}
            <button
              onClick={() => {
                setLoadError(undefined);
                setLoadAttempt((value) => value + 1);
              }}
            >
              {tr(locale, "重试智能编辑器", "Retry smart editor")}
            </button>
          </footer>
        </div>
      );
    return (
      <div className="professional-code-editor">
        <div className="professional-code-loading">{tr(locale, "正在按需加载代码智能服务…", "Loading code intelligence on demand…")}</div>
      </div>
    );
  }

  return (
    <div className={`professional-code-editor ${compact ? "compact" : ""}`} data-content-fingerprint={codeContentFingerprint(value)}>
      <div className="professional-code-toolbar">
        <span>
          <Braces size={12} />
          JavaScript
        </span>
        <span title={tr(locale, "F1 命令面板 · Ctrl+Space 智能提示 · Alt+Shift+F 格式化", "F1 commands · Ctrl+Space suggestions · Alt+Shift+F format")}>
          <Command size={11} />
          F1
        </span>
        {onOpenDocs && (
          <button type="button" title={tr(locale, "打开场景脚本文档", "Open scene script docs")} onClick={onOpenDocs}>
            <BookOpen size={11} />
            {tr(locale, "文档", "Docs")}
          </button>
        )}
        <button
          type="button"
          className={`professional-code-problems ${problems ? "has-problems" : "healthy"}`}
          disabled={!sortedDiagnostics.length}
          onClick={() => setProblemsOpen((open) => !open)}
        >
          {problems ? <TriangleAlert size={11} /> : <CheckCircle2 size={11} />}
          {problems ? tr(locale, `${problems} 个问题`, `${problems} problems`) : tr(locale, "检查通过", "No problems")}
        </button>
      </div>
      {problemsOpen && sortedDiagnostics.length > 0 && (
        <div className="professional-code-problem-list" role="list">
          <header>
            <strong>{tr(locale, "场景脚本诊断", "Scene script diagnostics")}</strong>
            <span>{sortedDiagnostics.length}</span>
          </header>
          {sortedDiagnostics.map((issue, index) => (
            <button type="button" key={`${issue.code}:${issue.line}:${issue.column}:${index}`} onClick={() => revealDiagnostic(issue)}>
              <TriangleAlert size={12} />
              <span>
                <strong>{issue.message}</strong>
                <small>
                  Ln {issue.line}, Col {issue.column}
                </small>
              </span>
            </button>
          ))}
        </div>
      )}
      <CodeEditorBoundary locale={locale} value={value} onChange={onChange} {...(onSave ? { onSave } : {})} {...(onRun ? { onRun } : {})}>
        <Editor
          beforeMount={beforeMount}
          onMount={onMount}
          height={height}
          language="javascript"
          path={path}
          theme="vs-dark"
          value={value}
          onChange={(next) => onChange(next ?? "")}
          onValidate={(markers) => setLanguageProblems(markers.filter((marker) => marker.severity >= monacoApi.MarkerSeverity.Warning && marker.source !== "BIM Studio").length)}
          loading={<div className="professional-code-loading">{tr(locale, "正在加载代码智能服务…", "Loading code intelligence…")}</div>}
          options={{
            automaticLayout: true,
            bracketPairColorization: { enabled: true },
            codeLens: !compact,
            contextmenu: true,
            cursorSmoothCaretAnimation: "on",
            find: { addExtraSpaceOnTop: false },
            folding: true,
            fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
            fontLigatures: true,
            fontSize: compact ? 11 : 12,
            formatOnPaste: true,
            glyphMargin: !compact,
            guides: { bracketPairs: true, indentation: true },
            hover: { enabled: "on", delay: 250 },
            inlayHints: { enabled: "on" },
            lineHeight: compact ? 17 : 20,
            minimap: { enabled: !compact },
            mouseWheelZoom: true,
            multiCursorModifier: "ctrlCmd",
            padding: { top: 10, bottom: 10 },
            quickSuggestions: { other: true, comments: false, strings: true },
            renderWhitespace: "selection",
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            stickyScroll: { enabled: !compact },
            suggest: { preview: true, showStatusBar: true },
            tabSize: 2,
            wordWrap: compact ? "on" : "off",
          }}
        />
      </CodeEditorBoundary>
    </div>
  );
}
