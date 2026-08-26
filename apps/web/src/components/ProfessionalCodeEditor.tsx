import Editor, { loader, type BeforeMount, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { Braces, CheckCircle2, Command, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { STUDIO_API_DECLARATIONS } from "../studio/studioApi";

loader.config({ monaco });

self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    return label === "javascript" || label === "typescript"
      ? new Worker(new URL("../workers/monacoTypescript.worker.ts", import.meta.url), { type: "module", name: "studio-typescript" })
      : new Worker(new URL("../workers/monacoEditor.worker.ts", import.meta.url), { type: "module", name: "studio-editor" });
  }
};

const PLATFORM_TYPES = `
type Vec3 = [number, number, number];
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
interface SceneObjectHandle {
  readonly id: string;
  readonly name: string;
  visible: boolean;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  focus(): void;
  playAnimation(name?: string): Promise<void>;
  stopAnimation(name?: string): void;
  setColor(color: string): void;
  setOpacity(opacity: number): void;
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
interface BehaviorContext {
  readonly sceneId: string;
  readonly deltaMs: number;
  readonly elapsedMs: number;
  readonly deltaTime: number;
  readonly elapsedTime: number;
  object(id: string): SceneObjectHandle | undefined;
  objects(query?: string): readonly SceneObjectHandle[];
  command(command: SceneCommand): void;
  getData(key: string): JsonValue | undefined;
  setData(key: string, value: JsonValue): void;
  emit(name: string, payload?: JsonValue): void;
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

export interface CodeInsertRequest {
  id: number;
  text: string;
}

export function ProfessionalCodeEditor({ locale, value, path, height = "100%", compact = false, insertRequest, onChange, onSave, onRun }: {
  locale: AppLocale;
  value: string;
  path: string;
  height?: string | number;
  compact?: boolean;
  insertRequest?: CodeInsertRequest;
  onChange: (value: string) => void;
  onSave?: () => void;
  onRun?: () => void;
}) {
  const [problems, setProblems] = useState(0);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const lastInsertRequestRef = useRef(0);

  useEffect(() => {
    if (!insertRequest || insertRequest.id <= lastInsertRequestRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;
    lastInsertRequestRef.current = insertRequest.id;
    const selection = editor.getSelection();
    const range = selection ?? new monaco.Range(1, 1, 1, 1);
    const prefix = range.startColumn > 1 && !insertRequest.text.startsWith("\n") ? "\n" : "";
    editor.executeEdits("studio-library-insert", [{ range, text: `${prefix}${insertRequest.text}`, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    editor.focus();
  }, [insertRequest]);

  const beforeMount: BeforeMount = (api) => {
    if (configured) return;
    configured = true;
    api.languages.typescript.javascriptDefaults.setEagerModelSync(true);
    api.languages.typescript.javascriptDefaults.setCompilerOptions({
      allowNonTsExtensions: true,
      allowJs: true,
      checkJs: true,
      module: api.languages.typescript.ModuleKind.ESNext,
      moduleResolution: api.languages.typescript.ModuleResolutionKind.NodeJs,
      target: api.languages.typescript.ScriptTarget.ES2022
    });
    api.languages.typescript.javascriptDefaults.addExtraLib(PLATFORM_TYPES, "bim-studio://types/scene-sdk.d.ts");
    api.languages.registerCompletionItemProvider("javascript", {
      provideCompletionItems(_model: monaco.editor.ITextModel, position: monaco.Position) {
        const range = new api.Range(position.lineNumber, position.column, position.lineNumber, position.column);
        return { suggestions: [
          snippet(api, "onStart", "生命周期：场景启动", "function onStart(ctx) {\n\tctx.log(\"Scene started\", { sceneId: ctx.sceneId });\n}", range),
          snippet(api, "onUpdate", "生命周期：逐帧更新", "function onUpdate(ctx) {\n\tconst object = ctx.object(\"object-id\");\n\tif (object) object.rotation[1] += ctx.deltaTime;\n}", range),
          snippet(api, "data binding", "读取实时数据并驱动对象", "const value = ctx.getData(\"device.temperature\");\nif (typeof value === \"number\") {\n\tctx.object(\"device-id\")?.setColor(value > 80 ? \"#ef4444\" : \"#22c55e\");\n}", range),
          snippet(api, "studio object", "统一 API：操作二维或三维中的场景对象", "const agv = studio.object(\"AGV-01\");\nagv?.setPosition(12, 0, 6);\nagv?.setCollision(true);\nagv?.focus();", range),
          snippet(api, "studio camera", "统一 API：相机与漫游", "studio.camera.setPose([12, 6, 12], [0, 1, 0], { near: 0.05, far: 100000 });\nstudio.camera.setMode(\"firstPerson\");\nstudio.camera.setCollision(true, 0.32);", range),
          snippet(api, "studio scene", "统一 API：场景环境和播放", "studio.scene.setWeather(\"sunny\");\nstudio.animation.play();", range)
          ,snippet(api, "gateway fetch", "通过服务器代理访问 HTTP 接口", "const response = await studio.net.fetch(\"https://api.example.com/telemetry\", {\n\tmethod: \"GET\",\n\tcredentialRef: \"factory-api\"\n});\nstudio.log(\"telemetry\", response.value);", range)
          ,snippet(api, "Three.js math", "使用完整 Three.js 命名空间进行计算", "const direction = new THREE.Vector3(1, 0, 1).normalize();\nconst next = direction.multiplyScalar(ctx.deltaTime * 2);", range)
        ] };
      }
    });
  };

  const onMount: OnMount = (editor, api) => {
    editorRef.current = editor;
    if (onSave) editor.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.KeyS, onSave);
    if (onRun) editor.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.Enter, onRun);
    editor.focus();
  };

  return <div className={`professional-code-editor ${compact ? "compact" : ""}`}>
    <div className="professional-code-toolbar">
      <span><Braces size={12} />JavaScript</span>
      <span title={tr(locale, "F1 命令面板 · Ctrl+Space 智能提示 · Alt+Shift+F 格式化", "F1 commands · Ctrl+Space suggestions · Alt+Shift+F format")}><Command size={11} />F1</span>
      <span className={problems ? "has-problems" : "healthy"}>{problems ? <TriangleAlert size={11} /> : <CheckCircle2 size={11} />}{problems ? tr(locale, `${problems} 个问题`, `${problems} problems`) : tr(locale, "检查通过", "No problems")}</span>
    </div>
    <Editor
      beforeMount={beforeMount}
      onMount={onMount}
      height={height}
      language="javascript"
      path={path}
      theme="vs-dark"
      value={value}
      onChange={(next) => onChange(next ?? "")}
      onValidate={(markers) => setProblems(markers.filter((marker) => marker.severity >= monaco.MarkerSeverity.Warning).length)}
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
        wordWrap: compact ? "on" : "off"
      }}
    />
  </div>;
}

function snippet(api: typeof monaco, label: string, detail: string, insertText: string, range: monaco.IRange): monaco.languages.CompletionItem {
  return { label, detail, insertText, range, kind: api.languages.CompletionItemKind.Snippet, insertTextRules: api.languages.CompletionItemInsertTextRule.InsertAsSnippet };
}
