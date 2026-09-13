import { loader, type BeforeMount } from "@monaco-editor/react";
import type * as monaco from "monaco-editor";
import type { SceneScriptIntelligenceContext } from "../studio/sceneScriptContext";
import { apiDocumentationAt, contextualSuggestions, docsMarkdown, isWorkerBehaviorModel, referenceLabel, snippet, stringLiteralAt } from "./professionalCodeIntelligence";
import { PLATFORM_TYPES } from "./professionalCodePlatformTypes";

const monacoEnvironmentTarget = globalThis as typeof globalThis & { MonacoEnvironment?: { getWorker(moduleId: string, label: string): Worker } };
monacoEnvironmentTarget.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    return label === "javascript" || label === "typescript"
      ? new Worker(new URL("../workers/monacoTypescript.worker.ts", import.meta.url), { type: "module", name: "studio-typescript" })
      : new Worker(new URL("../workers/monacoEditor.worker.ts", import.meta.url), { type: "module", name: "studio-editor" });
  },
};

let monacoLoadPromise: Promise<typeof import("monaco-editor")> | undefined;

export function loadMonacoEditor(): Promise<typeof import("monaco-editor")> {
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
let configured = false;
const intelligenceContexts = new Map<string, SceneScriptIntelligenceContext>();

export function registerProfessionalCodeContext(path: string, context: SceneScriptIntelligenceContext) {
  intelligenceContexts.set(path, context);
  return () => {
    if (intelligenceContexts.get(path) === context) intelligenceContexts.delete(path);
  };
}
export const configureProfessionalCodeServices: BeforeMount = (api) => {
  if (configured) return;
  const typescript = api.languages.typescript;
  if (!typescript?.javascriptDefaults) throw new Error("Monaco JavaScript language service is unavailable");
  typescript.javascriptDefaults.setEagerModelSync(true);
  typescript.javascriptDefaults.setCompilerOptions({
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: false,
    module: api.languages.typescript.ModuleKind.ESNext,
    moduleResolution: api.languages.typescript.ModuleResolutionKind.NodeJs,
    target: api.languages.typescript.ScriptTarget.ES2022,
  });
  typescript.javascriptDefaults.addExtraLib(PLATFORM_TYPES, "bim-studio://types/scene-sdk.d.ts");
  api.languages.registerCompletionItemProvider("javascript", createCompletionProvider(api));
  api.languages.registerHoverProvider("javascript", createHoverProvider());
  configured = true;
};

function createCompletionProvider(api: typeof monaco): monaco.languages.CompletionItemProvider {
  return {
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
  };
}

function createHoverProvider(): monaco.languages.HoverProvider {
  return {
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
  };
}
