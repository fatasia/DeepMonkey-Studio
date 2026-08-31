import type * as monaco from "monaco-editor";
import type { SceneScriptIntelligenceContext, SceneScriptReference, SceneScriptTarget } from "../studio/sceneScriptContext";

export function snippet(
  api: typeof monaco,
  label: string,
  detail: string,
  insertText: string,
  range: monaco.IRange,
  documentation?: monaco.IMarkdownString,
): monaco.languages.CompletionItem {
  return {
    label,
    detail,
    insertText,
    range,
    ...(documentation ? { documentation } : {}),
    kind: api.languages.CompletionItemKind.Snippet,
    insertTextRules: api.languages.CompletionItemInsertTextRule.InsertAsSnippet,
  };
}

export function contextualSuggestions(
  api: typeof monaco,
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  context: SceneScriptIntelligenceContext | undefined,
  workerBehavior: boolean,
): monaco.languages.CompletionItem[] {
  if (!context) return [];
  const prefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
  const quoteMatch = prefix.match(/(["'])([^"']*)$/);
  if (!quoteMatch) return [];
  const typed = quoteMatch[2] ?? "";
  const range = new api.Range(position.lineNumber, position.column - typed.length, position.lineNumber, position.column);
  const callPrefix = prefix.slice(0, prefix.length - quoteMatch[0]!.length);
  if (/(?:ctx|studio)\.object\(\s*$/.test(callPrefix)) return context.targets.filter((item) => item.kind === "object").map((item) => targetSuggestion(api, item, range));
  if (/studio\.component\(\s*$/.test(callPrefix)) return context.targets.filter((item) => item.kind === "component").map((item) => targetSuggestion(api, item, range));
  if (/(?:ctx|studio)\.(?:getData|setData)\(\s*$/.test(callPrefix))
    return context.dataKeys.map((key) => valueSuggestion(api, key, "数据键", "Data key", range, "/docs/studio-api"));
  if (/(?:ctx\.|studio\.)?emit\(\s*$/.test(callPrefix))
    return context.eventNames.map((name) => valueSuggestion(api, name, "场景事件", "Scene event", range, "/docs/behavior-script", api.languages.CompletionItemKind.Event));
  if (/ctx\.event\?*\.name\s*={2,3}\s*$/.test(callPrefix))
    return context.eventNames.map((name) => valueSuggestion(api, name, "可监听事件", "Observable event", range, "/docs/behavior-script", api.languages.CompletionItemKind.Event));
  if (workerBehavior) return [];
  if (/studio\.scene\.open\(\s*$/.test(callPrefix)) return context.references.filter((item) => item.kind === "scene").map((item) => referenceSuggestion(api, item, range));
  if (/studio\.page\.open\(\s*$/.test(callPrefix)) return context.references.filter((item) => item.kind === "page").map((item) => referenceSuggestion(api, item, range));
  if (/studio\.camera\.applyView\(\s*$/.test(callPrefix))
    return context.references.filter((item) => item.kind === "cameraView").map((item) => referenceSuggestion(api, item, range));
  if (/studio\.camera\.setMode\(\s*$/.test(callPrefix))
    return ["orbit", "firstPerson", "thirdPerson"].map((value) => valueSuggestion(api, value, "导航模式", "Navigation mode", range, "/docs/studio-api"));
  if (/studio\.camera\.setStandardView\(\s*$/.test(callPrefix))
    return ["top", "bottom", "left", "right", "front", "back"].map((value) => valueSuggestion(api, value, "标准视角", "Standard view", range, "/docs/studio-api"));
  if (/studio\.scene\.setWeather\(\s*$/.test(callPrefix))
    return ["sunny", "cloudy", "rain", "snow", "fog", "storm"].map((value) => valueSuggestion(api, value, "天气模式", "Weather mode", range, "/docs/studio-api"));
  return [];
}

export function isWorkerBehaviorModel(model: monaco.editor.ITextModel): boolean {
  return model.uri.toString().startsWith("bim-studio://behavior/");
}

export function apiDocumentationAt(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): { range: monaco.IRange; title: string; description: string; href: string } | undefined {
  const line = model.getLineContent(position.lineNumber);
  for (const item of API_DOCUMENTATION) {
    for (const match of line.matchAll(new RegExp(`\\b${item.expression.replaceAll(".", "\\.")}\\b`, "g"))) {
      const start = (match.index ?? 0) + 1;
      const end = start + item.expression.length;
      if (position.column < start || position.column > end) continue;
      return {
        range: { startLineNumber: position.lineNumber, startColumn: start, endLineNumber: position.lineNumber, endColumn: end },
        title: item.title,
        description: item.description,
        href: item.href,
      };
    }
  }
  return undefined;
}

export function docsMarkdown(zh: string, en: string, href: string): monaco.IMarkdownString {
  return { value: `${zh} · ${en}\n\n[打开关联文档](${href})`, isTrusted: true };
}

export function stringLiteralAt(model: monaco.editor.ITextModel, position: monaco.Position): { value: string; range: monaco.IRange } | undefined {
  const line = model.getLineContent(position.lineNumber);
  for (const match of line.matchAll(/(["'])([^"']+)\1/g)) {
    const start = (match.index ?? 0) + 2;
    const end = start + (match[2]?.length ?? 0);
    if (position.column < start || position.column > end) continue;
    return { value: match[2]!, range: { startLineNumber: position.lineNumber, startColumn: start, endLineNumber: position.lineNumber, endColumn: end } };
  }
  return undefined;
}

function targetSuggestion(api: typeof monaco, target: SceneScriptTarget, range: monaco.IRange): monaco.languages.CompletionItem {
  const kind = target.kind === "object" ? api.languages.CompletionItemKind.Class : api.languages.CompletionItemKind.Interface;
  return {
    label: target.id,
    filterText: `${target.id} ${target.name} ${target.context}`,
    insertText: target.id,
    range,
    kind,
    detail: `${target.name} · ${target.context}`,
    documentation: docsMarkdown(target.kind === "object" ? "场景对象" : "页面组件", target.kind === "object" ? "Scene object" : "Page component", "/docs/behavior-script"),
  };
}

function valueSuggestion(
  api: typeof monaco,
  value: string,
  zh: string,
  en: string,
  range: monaco.IRange,
  href: string,
  kind = api.languages.CompletionItemKind.Value,
): monaco.languages.CompletionItem {
  return { label: value, insertText: value, range, kind, detail: `${zh} · ${en}`, documentation: docsMarkdown(zh, en, href) };
}

function referenceSuggestion(api: typeof monaco, reference: SceneScriptReference, range: monaco.IRange): monaco.languages.CompletionItem {
  return {
    label: reference.id,
    filterText: `${reference.id} ${reference.name} ${reference.context}`,
    insertText: reference.id,
    range,
    kind: reference.kind === "cameraView" ? api.languages.CompletionItemKind.Reference : api.languages.CompletionItemKind.Module,
    detail: `${referenceLabel(reference.kind)} · ${reference.name} · ${reference.context}`,
    documentation: docsMarkdown(referenceLabel(reference.kind), reference.kind, "/docs/studio-api"),
  };
}

export function referenceLabel(kind: SceneScriptReference["kind"]): string {
  return kind === "scene" ? "场景" : kind === "page" ? "页面" : "相机视角";
}

const API_DOCUMENTATION = [
  { expression: "studio.object", title: "studio.object(idOrName)", description: "按稳定 ID 或完整名称获取 3D 对象句柄；不存在时返回 undefined。", href: "/docs/studio-api" },
  { expression: "studio.component", title: "studio.component(idOrName)", description: "获取 2D 页面组件句柄，可更新属性、显示或隐藏。", href: "/docs/studio-api" },
  {
    expression: "studio.unity",
    title: "studio.unity(idOrName)",
    description: "控制 Unity 组件的清单属性、动作和场景；模型、相机、灯光与 uGUI 使用相同入口。",
    href: "/docs/behavior-script",
  },
  { expression: "studio.getData", title: "studio.getData(key)", description: "读取应用变量或数据绑定值。", href: "/docs/studio-api" },
  { expression: "studio.setData", title: "studio.setData(key, value)", description: "写入应用变量并触发数据联动。", href: "/docs/studio-api" },
  {
    expression: "studio.net.fetch",
    title: "studio.net.fetch(endpoint, options)",
    description: "通过服务端网关访问 HTTP 数据源，凭据不会暴露给脚本。",
    href: "/docs/behavior-script",
  },
  { expression: "studio.camera", title: "studio.camera", description: "控制镜头姿态、导航模式、裁剪面、防穿模和已保存视角。", href: "/docs/studio-api" },
  { expression: "studio.scene", title: "studio.scene", description: "切换场景并控制天气、环境、后处理和物理状态。", href: "/docs/studio-api" },
  { expression: "studio.animation", title: "studio.animation", description: "播放、暂停或定位应用时间线。", href: "/docs/studio-api" },
  { expression: "ctx.command", title: "ctx.command(command)", description: "从 Worker 安全发送场景命令，不阻塞渲染线程。", href: "/docs/behavior-script" },
  { expression: "ctx.emit", title: "ctx.emit(name, payload)", description: "发出可供页面联动和其他行为监听的业务事件。", href: "/docs/behavior-script" },
] as const;
