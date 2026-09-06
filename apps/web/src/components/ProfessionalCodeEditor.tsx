import Editor, { type OnMount } from "@monaco-editor/react";
import type * as monaco from "monaco-editor";
import { BookOpen, Braces, CheckCircle2, Command, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { SceneScriptIssue } from "../studio/sceneScriptAnalysis";
import { buildSceneScriptTypeDeclarations, type SceneScriptIntelligenceContext } from "../studio/sceneScriptContext";
import { configureProfessionalCodeServices, loadMonacoEditor, registerProfessionalCodeContext } from "./professionalCodeServices";
import { CodeEditorBoundary } from "./CodeEditorBoundary";

export interface CodeInsertRequest {
  id: number;
  text: string;
}

// Monaco 0.56 的括号连线在位置暂不可见时解引用 null.left（indentGuides.prepareRender）。
// 仅关闭该装饰路径，保留缩进指示与括号字符配色；不屏蔽渲染异常或更改编辑行为。
export const PROFESSIONAL_CODE_STRUCTURE_OPTIONS = {
  bracketPairColorization: { enabled: true },
  guides: { bracketPairs: false, indentation: true },
} satisfies Pick<monaco.editor.IStandaloneEditorConstructionOptions, "bracketPairColorization" | "guides">;

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
  revealRequest,
  intelligence,
  moduleSpecifiers = [],
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
  revealRequest?: { id: number; line: number; column: number };
  intelligence?: SceneScriptIntelligenceContext;
  moduleSpecifiers?: readonly string[];
  diagnostics?: readonly SceneScriptIssue[];
  onChange: (value: string) => void;
  onSave?: () => void;
  onRun?: () => void;
  onOpenDocs?: () => void;
}) {
  const [languageDiagnostics, setLanguageDiagnostics] = useState<Array<Omit<SceneScriptIssue, "code"> & { code: string }>>([]);
  const actionsRef = useRef({ onSave, onRun, onOpenDocs });
  actionsRef.current = { onSave, onRun, onOpenDocs };
  const [theme, setTheme] = useState("vs-dark");
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [monacoApi, setMonacoApi] = useState<typeof import("monaco-editor")>();
  const [loadError, setLoadError] = useState<Error | undefined>(undefined);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const monacoApiRef = useRef<typeof import("monaco-editor") | undefined>(undefined);
  const lastInsertRequestRef = useRef(0);
  const intelligenceTypesRef = useRef<monaco.IDisposable | undefined>(undefined);
  const dependencyTypesRef = useRef<monaco.IDisposable | undefined>(undefined);
  const sortedDiagnostics = useMemo(() => [...diagnostics, ...languageDiagnostics].sort((left, right) => left.line - right.line || left.column - right.column), [diagnostics, languageDiagnostics]);
  const problems = sortedDiagnostics.length;
  useEffect(() => setLanguageDiagnostics([]), [path]);
  useEffect(() => {
    if (!revealRequest || !monacoApi) return;
    const frame = requestAnimationFrame(() => revealDiagnostic(revealRequest));
    return () => cancelAnimationFrame(frame);
  }, [revealRequest?.id, monacoApi, path]);
  useEffect(() => {
    const root = editorRef.current?.getDomNode()?.ownerDocument.documentElement ?? document.documentElement;
    const update = () => setTheme(root.dataset.theme === "light" ? "vs" : "vs-dark");
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [monacoApi]);

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
    return registerProfessionalCodeContext(path, intelligence);
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
    dependencyTypesRef.current?.dispose();
    dependencyTypesRef.current = undefined;
    if (!monacoApi || moduleSpecifiers.length === 0) return;
    const declarations = [...new Set(moduleSpecifiers)].map((specifier) => `declare module ${JSON.stringify(specifier)};`).join("\n");
    const javascriptDefaults = (monacoApi.languages.typescript as unknown as { javascriptDefaults: { addExtraLib(content: string, filePath?: string): monaco.IDisposable } }).javascriptDefaults;
    dependencyTypesRef.current = javascriptDefaults.addExtraLib(declarations, `bim-studio://types/project-dependencies-${encodeURIComponent(path)}.d.ts`);
    return () => {
      dependencyTypesRef.current?.dispose();
      dependencyTypesRef.current = undefined;
    };
  }, [moduleSpecifiers.join("\u0000"), monacoApi, path]);

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
        source: "Deep Monkey Studio",
      })),
    );
    return () => api.editor.setModelMarkers(model, "bim-studio-scene-analysis", []);
  }, [diagnostics, monacoApi, path]);

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

  const onMount: OnMount = (editor, api) => {
    editorRef.current = editor;
    monacoApiRef.current = api;
    editor.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.KeyS, () => actionsRef.current.onSave?.());
    editor.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.Enter, () => actionsRef.current.onRun?.());
    if (onOpenDocs)
      editor.addAction({
        id: "bim-studio.open-script-docs",
        label: tr(locale, "Deep Monkey Studio：打开场景 API 文档", "Deep Monkey Studio: Open scene API docs"),
        keybindings: [api.KeyMod.CtrlCmd | api.KeyCode.F1],
        run: () => actionsRef.current.onOpenDocs?.(),
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
        source: "Deep Monkey Studio",
      })),
    );
    editor.focus();
  };

  function revealDiagnostic(issue: Pick<SceneScriptIssue, "line" | "column">) {
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
          beforeMount={configureProfessionalCodeServices}
          onMount={onMount}
          height={height}
          language="javascript"
          path={path}
          theme={theme}
          value={value}
          onChange={(next) => onChange(next ?? "")}
          onValidate={(markers) => setLanguageDiagnostics(markers.filter((marker) => marker.severity >= monacoApi.MarkerSeverity.Warning && marker.source !== "Deep Monkey Studio").map((marker) => ({ code: `language-${marker.code}`, severity: marker.severity >= monacoApi.MarkerSeverity.Error ? "error" : "warning", message: marker.message, line: marker.startLineNumber, column: marker.startColumn, endColumn: marker.endColumn })))}
          loading={<div className="professional-code-loading">{tr(locale, "正在加载代码智能服务…", "Loading code intelligence…")}</div>}
          options={{
            automaticLayout: true,
            ...PROFESSIONAL_CODE_STRUCTURE_OPTIONS,
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
