// 分级类型检查合同的真实语言服务验证：
// 全局 checkJs:false 保持默认脚本零噪声；显式携带 // @ts-check 的脚本由 TypeScript
// 在程序级单独开启检查（未检查 JS 进入独立 unchecked 程序，全局名不与 checked 文件
// 合并，因此两种脚本共存互不扩散诊断）。夹具为真实默认脚本与 SDK 样例，编译选项与
// extra lib 均取自生产配置，防止测试手写选项与 Monaco 实际下发值漂移。
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { SDK_EXAMPLES } from "../docs/sdkExamples";
import { buildSceneScriptTypeDeclarations, type SceneScriptIntelligenceContext } from "../studio/sceneScriptContext";
import { defaultBehaviorCode } from "./sceneBehaviorPanelModel";
import { configureProfessionalCodeServices } from "./professionalCodeServices";
import { PLATFORM_TYPES } from "./professionalCodePlatformTypes";

// configureProfessionalCodeServices 是一次性初始化，用桩捕获真实下发的编译选项与类型库。
const captured: { compilerOptions?: unknown } = {};
const injectedLibraries: string[] = [];
{
  const disposable = { dispose() {} };
  const typescriptStub = {
    javascriptDefaults: {
      setEagerModelSync: () => undefined,
      setCompilerOptions: (options: unknown) => {
        captured.compilerOptions = options;
      },
      addExtraLib: (content: string) => {
        injectedLibraries.push(content);
        return disposable;
      },
    },
    ModuleKind: { ESNext: 99 },
    ModuleResolutionKind: { NodeJs: 2 },
    ScriptTarget: { ES2022: 7 },
    registerCompletionItemProvider: () => disposable,
    registerHoverProvider: () => disposable,
  };
  configureProfessionalCodeServices({
    languages: {
      typescript: typescriptStub,
      registerCompletionItemProvider: () => disposable,
      registerHoverProvider: () => disposable,
    },
    // 桩只覆盖本合同触达的成员，其余命名空间成员与本测试无关。
  } as unknown as typeof import("monaco-editor"));
  if (!captured.compilerOptions) throw new Error("configureProfessionalCodeServices 未下发编译选项");
}

const compilerOptions = captured.compilerOptions as ts.CompilerOptions;

const require = createRequire(import.meta.url);
const libDirectory = dirname(require.resolve("typescript/lib/typescript.js"));

// 生产 Worker 附带 Monaco 内置默认库；node 测试环境改从本地 typescript 包读取同名库文件。
function isLibFileName(name: string): string | undefined {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.startsWith("lib.") ? base : undefined;
}

function createSceneScriptService(files: Record<string, string>): ts.LanguageService {
  // getDefaultLibLocation 不在 LanguageServiceHost 类型上，但运行时 LS 靠它解析 lib 内部引用。
  const host: ts.LanguageServiceHost & { getDefaultLibLocation(): string } = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => Object.keys(files),
    getScriptVersion: () => "1",
    getScriptSnapshot(name) {
      const inline = files[name];
      if (inline !== undefined) return ts.ScriptSnapshot.fromString(inline);
      const base = isLibFileName(name);
      if (base) {
        const path = join(libDirectory, base);
        if (existsSync(path)) return ts.ScriptSnapshot.fromString(readFileSync(path, "utf8"));
      }
      return undefined;
    },
    getCurrentDirectory: () => "/",
    getDefaultLibFileName: () => "lib.es2022.full.d.ts",
    getDefaultLibLocation: () => libDirectory,
    fileExists(name) {
      if (name in files) return true;
      const base = isLibFileName(name);
      return base !== undefined && existsSync(join(libDirectory, base));
    },
    readFile(name) {
      if (name in files) return files[name];
      const base = isLibFileName(name);
      return base !== undefined ? readFileSync(join(libDirectory, base), "utf8") : undefined;
    },
    readDirectory: () => [],
    getDirectories: () => [],
    directoryExists: () => true,
    useCaseSensitiveFileNames: () => false,
    getNewLine: () => "\n",
  };
  return ts.createLanguageService(host, ts.createDocumentRegistry(false, "/"));
}

interface RecordedDiagnostic {
  code: number;
  line: number;
  message: string;
}

function collectDiagnostics(service: ts.LanguageService, fileName: string): RecordedDiagnostic[] {
  const sourceFile = service.getProgram()?.getSourceFile(fileName);
  if (!sourceFile) throw new Error(`语言服务中没有 ${fileName}`);
  return [...service.getSyntacticDiagnostics(fileName), ...service.getSemanticDiagnostics(fileName)].map((diagnostic) => {
    const start = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return {
      code: diagnostic.code,
      line: start.line + 1,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    };
  });
}

const projectContext: SceneScriptIntelligenceContext = {
  targets: [
    { id: "pump-01", name: "Pump", kind: "object", context: "Factory" },
    { id: "unity-01", name: "Virtual line", kind: "component", context: "Overview", runtime: "unity" },
  ],
  references: [{ id: "scene-1", name: "Factory", kind: "scene", context: "Factory" }],
  // 含 SDK 样例使用的演示键与事件名：模拟样例插入后项目 context 已覆盖这些字面量。
  dataKeys: ["pump.temperature", "device.temperature"],
  eventNames: ["alarm", "click"],
};

const sceneLibraries = {
  "bim-studio://types/scene-sdk.d.ts": PLATFORM_TYPES,
  "bim-studio://types/project-context.d.ts": buildSceneScriptTypeDeclarations(projectContext),
};

// 与生产编辑器完全一致的脚本清单：全部默认目标脚本 + 全部可插入 SDK 样例。
const realScripts: ReadonlyArray<[name: string, code: string]> = [
  ["default-scene", defaultBehaviorCode(undefined)],
  ["default-scene-target", defaultBehaviorCode({ kind: "scene" })],
  ["default-object", defaultBehaviorCode({ kind: "object", id: "pump-01" })],
  ["default-component", defaultBehaviorCode({ kind: "component", id: "unity-01" })],
  ...SDK_EXAMPLES.map((example): [string, string] => [`sdk-${example.id}`, example.code]),
];
const scriptPath = (name: string) => `bim-studio://behavior/${name}.js`;

describe("分级类型检查（checkJs:false + // @ts-check）", () => {
  it("生产编译选项保持 checkJs:false，SDK 类型库照常注入", () => {
    expect(compilerOptions.checkJs).toBe(false);
    expect(compilerOptions.allowJs).toBe(true);
    expect(compilerOptions.allowNonTsExtensions).toBe(true);
    expect(injectedLibraries).toContain(PLATFORM_TYPES);
  });

  it("默认脚本与全部 SDK 样例（无指令）零诊断", () => {
    const service = createSceneScriptService({
      ...sceneLibraries,
      ...Object.fromEntries(realScripts.map(([name, code]) => [scriptPath(name), code])),
    });
    for (const [name] of realScripts) expect(collectDiagnostics(service, scriptPath(name))).toEqual([]);
  });

  it("显式 // @ts-check 为该脚本单独开启类型诊断", () => {
    const service = createSceneScriptService({
      ...sceneLibraries,
      [scriptPath("checked")]: `// @ts-check\nfunction onStart() {\n  studio.object("pump-01")?.setColor(123);\n}\n`,
    });
    const diagnostics = collectDiagnostics(service, scriptPath("checked"));
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 2345, line: 3, message: expect.stringContaining("string") }));
  });

  it("@ts-check 配合 JSDoc 参数标注后 ctx 调用纳入检查", () => {
    const service = createSceneScriptService({
      ...sceneLibraries,
      [scriptPath("checked-ctx")]: `// @ts-check\n/** @param {BehaviorContext} ctx */\nfunction onStart(ctx) {\n  ctx.log(123);\n}\n`,
    });
    expect(collectDiagnostics(service, scriptPath("checked-ctx"))).toContainEqual(
      expect.objectContaining({ code: 2345, line: 4 }),
    );
  });

  it("未标注 JSDoc 的 ctx 参数保持隐式 any，@ts-check 不产生新噪声", () => {
    const service = createSceneScriptService({
      ...sceneLibraries,
      [scriptPath("loose-ctx")]: `// @ts-check\nfunction onStart(ctx) {\n  ctx.log(123);\n}\n`,
    });
    expect(collectDiagnostics(service, scriptPath("loose-ctx"))).toEqual([]);
  });

  it("全部真实夹具加 @ts-check 后零误报", () => {
    const service = createSceneScriptService({
      ...sceneLibraries,
      ...Object.fromEntries(realScripts.map(([name, code]) => [scriptPath(`${name}-checked`), `// @ts-check\n${code}`])),
    });
    for (const [name] of realScripts) expect(collectDiagnostics(service, scriptPath(`${name}-checked`))).toEqual([]);
  });

  it("@ts-check 抓住拼错的项目数据键（该功能的核心价值）", () => {
    const service = createSceneScriptService({
      ...sceneLibraries,
      // 全局 studio 始终类型化；ctx 需 JSDoc 标注后才有同等检查（见上文隐式 any 用例）。
      [scriptPath("typo-key")]: `// @ts-check\nfunction onStart() {\n  ctx.log(studio.getData("pump.temperture"));\n}\n`,
    });
    expect(collectDiagnostics(service, scriptPath("typo-key"))).toContainEqual(
      expect.objectContaining({ code: 2345, line: 3, message: expect.stringContaining("pump.temperature") }),
    );
  });

  it("带错误的 @ts-check 脚本与默认脚本共存：错误不扩散、默认脚本不被污染", () => {
    const files: Record<string, string> = {
      ...sceneLibraries,
      [scriptPath("checked-bad")]: `// @ts-check\nfunction onStart() {\n  studio.object("pump-01")?.setColor(123);\n}\n`,
      ...Object.fromEntries(realScripts.map(([name, code]) => [scriptPath(name), code])),
    };
    const service = createSceneScriptService(files);
    // checked 脚本只报真实类型错误，不被其它脚本的全局同名声明干扰（unchecked 程序隔离）。
    expect(collectDiagnostics(service, scriptPath("checked-bad")).map((item) => item.code)).toEqual([2345]);
    for (const [name] of realScripts) expect(collectDiagnostics(service, scriptPath(name))).toEqual([]);
  });

  it("// @ts-nocheck 可对单个脚本关闭检查（作者逃生门）", () => {
    const service = createSceneScriptService({
      ...sceneLibraries,
      [scriptPath("nocheck")]: `// @ts-nocheck\nfunction onStart() {\n  studio.object("pump-01")?.setColor(123);\n}\n`,
    });
    expect(collectDiagnostics(service, scriptPath("nocheck"))).toEqual([]);
  });
});
