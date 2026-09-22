import path from "node:path";
import ts from "typescript";

const deniedModuleRoots = new Set([
  "three", "three-stdlib", "babylonjs", "orillusion", "react", "react-dom", "react-native", "echarts",
  "echarts-for-react", "zrender", "jsdom", "happy-dom",
  "electron", "tauri", "wry", "webview", "webview2", "chromium", "cef",
]);
const deniedModulePrefixes = ["@babylonjs/", "@orillusion/", "@react-three/", "@tauri-apps/"];
const domGlobals = new Set([
  "document", "window", "navigator", "HTMLElement", "HTMLDivElement", "HTMLImageElement",
  "OffscreenCanvas", "WebView", "React", "echarts",
]);
function isTypeOnlyImport(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return true;
    if (clause.isTypeOnly) return true;
    const bindings = clause.namedBindings;
    const allNamedTypeOnly = !bindings || (ts.isNamedImports(bindings) && bindings.elements.every(element => element.isTypeOnly));
    return allNamedTypeOnly && !clause.defaultBinding && !clause.name;
  }
  return Boolean(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every(element => element.isTypeOnly));
}

const browserSurfaceAllowlist = new Map([
  ["src/app/pbrRendererPlugin.ts", new Set(["HTMLCanvasElement"])],
  ["src/webgpu/dashboardCompositionHost.ts", new Set(["HTMLCanvasElement"])],
  ["src/webgpu/deep2d/gpu.ts", new Set(["DOMException"])],
  ["src/webgpu/deviceSession.ts", new Set(["DOMException", "Event", "HTMLCanvasElement"])],
  ["src/webgpu/pbrRenderer.ts", new Set(["DOMException", "HTMLCanvasElement", "performance"])],
  ["src/webgpu/packetBuffers.ts", new Set(["DOMException"])],
  ["src/webgpu/textureResources.ts", new Set(["DOMException"])],
]);
const surfaceGlobals = new Set([...browserSurfaceAllowlist.values()].flatMap((values) => [...values]));
const nativeDeniedIdentifiers = new Set([
  "tauri", "wry", "webview", "webview2", "chromium", "electron", "cef", "orillusion", "webgl",
  "webgl2", "react", "echarts", "zrender", "htmlcanvaselement", "offscreencanvas",
  "web_sys", "wasm_bindgen", "js_sys", "napi", "neon", "v8", "deno_core",
  "javascriptcore", "webkit", "webkit2gtk", "boa_engine", "quick_js", "rquickjs",
]);
const nativeDeniedDependencyOnly = new Set([
  "angle", "glow", "glutin", "glutin_winit", "khronos_egl",
]);
const nativeDeniedDependencies = new Set([...nativeDeniedIdentifiers, ...nativeDeniedDependencyOnly]);

function normalized(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

function location(source, node) {
  const point = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { file: normalized(source.fileName), line: point.line + 1, column: point.character + 1 };
}

function moduleRoot(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function deniedModule(specifier) {
  const lower = specifier.toLowerCase();
  return deniedModuleRoots.has(moduleRoot(lower)) || deniedModulePrefixes.some((prefix) => lower.startsWith(prefix));
}

function isBridgeFile(file) {
  return normalized(file).startsWith("src/threeBridge/");
}

function pushModuleIssue(issues, source, node, specifier) {
  if (!deniedModule(specifier)) return;
  if (isBridgeFile(source.fileName) && (specifier === "three" || specifier.startsWith("three/"))) return;
  issues.push({ code: "denied-module", detail: specifier, ...location(source, node) });
}

function isPropertyName(node) {
  const parent = node.parent;
  return (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || ((ts.isPropertyAssignment(parent)
      || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent)
      || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)) && parent.name === node);
}

/** Scan executable Deep Engine TypeScript. Tests and lab files are excluded by the caller. */
export function scanTypeScriptRuntime(sources) {
  const options = { noResolve: true, noLib: true, allowJs: true, target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve };
  const sourceFiles = new Map(sources.map(({ file, code }) => [normalized(file), ts.createSourceFile(normalized(file), code, ts.ScriptTarget.Latest, true)]));
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (file) => sourceFiles.get(normalized(file));
  const program = ts.createProgram([...sourceFiles.keys()], options, host);
  const checker = program.getTypeChecker();
  const issues = [];

  for (const source of sourceFiles.values()) {
    if (/\.(?:html|css)$/i.test(source.fileName)) {
      issues.push({ code: "ui-source-in-runtime", detail: path.extname(source.fileName), file: normalized(source.fileName), line: 1, column: 1 });
      continue;
    }
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        // 类型-only 导入编译期擦除,不构成运行时耦合,不参与纯净性判定。
        if (!isTypeOnlyImport(node)) {
          pushModuleIssue(issues, source, node.moduleSpecifier, node.moduleSpecifier.text);
          if (!isBridgeFile(source.fileName) && /(?:^|\/)threeBridge(?:\/|$)/i.test(node.moduleSpecifier.text)) {
            issues.push({ code: "bridge-boundary-crossed", detail: node.moduleSpecifier.text, ...location(source, node.moduleSpecifier) });
          }
        }
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) pushModuleIssue(issues, source, argument, argument.text);
        else issues.push({ code: "dynamic-module-specifier", detail: "Runtime module name must be statically auditable.", ...location(source, node) });
      }
      if (ts.isStringLiteralLike(node) && /^webgl2?$/i.test(node.text)) {
        issues.push({ code: "webgl-context", detail: node.text, ...location(source, node) });
      }
      if (ts.isIdentifier(node)) {
        const name = node.text;
        const isWebGl = /^WebGL[A-Za-z0-9_]*$/.test(name);
        const isRestrictedGlobal = domGlobals.has(name) || surfaceGlobals.has(name);
        const symbol = checker.getSymbolAtLocation(node);
        const isLocal = symbol?.declarations?.some((declaration) => declaration.getSourceFile() === source) ?? false;
        const globalProperty = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
          && ts.isIdentifier(node.parent.expression) && node.parent.expression.text === "globalThis";
        if ((isWebGl || isRestrictedGlobal) && !isLocal && (!isPropertyName(node) || globalProperty)) {
          const allowed = browserSurfaceAllowlist.get(normalized(source.fileName))?.has(name) ?? false;
          if (!allowed) issues.push({ code: isWebGl ? "webgl-api" : "dom-api", detail: name, ...location(source, node) });
        }
      }
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
        && (/^WebGL/i.test(node.argumentExpression.text) || domGlobals.has(node.argumentExpression.text))) {
        issues.push({ code: /^WebGL/i.test(node.argumentExpression.text) ? "webgl-api" : "dom-api", detail: node.argumentExpression.text, ...location(source, node.argumentExpression) });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const diagnostic of source.parseDiagnostics) {
      const point = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      issues.push({ code: "parse-error", detail: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "), file: normalized(source.fileName), line: point.line + 1, column: point.character + 1 });
    }
  }
  return issues;
}

/** Remove comments and literals before identifier scanning, while retaining line positions. */
export function stripRustTrivia(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, (value) => value.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\r\n]*/g, (value) => " ".repeat(value.length))
    .replace(/r(#+)?"[\s\S]*?"\1/g, (value) => value.replace(/[^\n]/g, " "))
    .replace(/b?"(?:\\.|[^"\\])*"/g, (value) => value.replace(/[^\n]/g, " "))
    .replace(/b?'(?:\\.|[^'\\])'/g, (value) => " ".repeat(value.length));
}

export function scanNativeRuntime(sources) {
  const issues = [];
  for (const { file, code } of sources) {
    const stripped = stripRustTrivia(code);
    for (const match of stripped.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
      const value = match[0].toLowerCase();
      if (!nativeDeniedIdentifiers.has(value) && !value.startsWith("webgl")) continue;
      const before = stripped.slice(0, match.index);
      issues.push({ code: "native-runtime-api", detail: match[0], file: normalized(file), line: before.split("\n").length, column: (match.index ?? 0) - before.lastIndexOf("\n") });
    }
  }
  return issues;
}

export function scanPackageManifest(manifest, file = "package.json") {
  const issues = [];
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const dependency of Object.keys(manifest[section] ?? {})) {
      if (deniedModule(dependency)) issues.push({ code: "denied-runtime-dependency", detail: `${section}:${dependency}`, file, line: 1, column: 1 });
    }
  }
  for (const [key, target] of Object.entries(manifest.exports ?? {})) {
    const serialized = JSON.stringify(target);
    if (/threeBridge|three-bridge/i.test(serialized) && key !== "./three-bridge") {
      issues.push({ code: "bridge-export-leak", detail: key, file, line: 1, column: 1 });
    }
  }
  return issues;
}

function deniedNativeDependency(name) {
  const canonical = name.toLowerCase().replaceAll("-", "_");
  return nativeDeniedDependencies.has(canonical)
    || [...nativeDeniedDependencies].some((entry) => canonical.startsWith(`${entry}_`));
}

const deniedWgpuFeatures = new Set(["gles", "webgl", "webgpu"]);

/** Check every production Cargo dependency table, including target-specific declarations and aliases. */
export function scanCargoManifest(code, file = "Cargo.toml") {
  const issues = [];
  let section = "";
  for (const [index, raw] of code.split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*$/, "").trim();
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) { section = header[1].toLowerCase(); continue; }
    if (!/(?:^|\.)dependencies$|(?:^|\.)build-dependencies$/.test(section) || /(?:^|\.)dev-dependencies$/.test(section)) continue;
    const assignment = line.match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=\s*(.+)$/);
    if (!assignment) continue;
    const declared = assignment[1] ?? assignment[2] ?? assignment[3];
    const aliased = assignment[4].match(/\bpackage\s*=\s*["']([^"']+)["']/)?.[1];
    const dependencyNames = new Set([declared, aliased].filter(Boolean));
    for (const name of dependencyNames) {
      if (deniedNativeDependency(name)) issues.push({ code: "denied-native-manifest-dependency", detail: name, file, line: index + 1, column: 1 });
    }
    if ([...dependencyNames].some((name) => name.toLowerCase() === "wgpu")) {
      const value = assignment[4];
      if (!/\bdefault-features\s*=\s*false\b/i.test(value)) {
        issues.push({ code: "wgpu-default-features", detail: "wgpu must disable defaults because they include GLES and browser backends", file, line: index + 1, column: 1 });
      }
      const featureList = value.match(/\bfeatures\s*=\s*\[([^\]]*)\]/i)?.[1] ?? "";
      for (const feature of featureList.matchAll(/["']([^"']+)["']/g)) {
        if (deniedWgpuFeatures.has(feature[1].toLowerCase())) {
          issues.push({ code: "denied-wgpu-feature", detail: feature[1], file, line: index + 1, column: 1 });
        }
      }
    }
  }
  return issues;
}

export function scanNativeDependencyTree(lines, file = "Cargo.toml") {
  const issues = [];
  for (const line of lines) {
    const name = line.trim().split(/\s+/)[0]?.toLowerCase();
    if (!name) continue;
    if (deniedNativeDependency(name)) {
      issues.push({ code: "denied-native-dependency", detail: name, file, line: 1, column: 1 });
    }
  }
  return issues;
}

export const RUNTIME_PURITY_ALLOWLIST = Object.freeze({
  excludedTrees: ["lab/", "dist/", "node_modules/", "target/"],
  excludedFileSuffixes: [".test.ts", ".test.tsx", ".test.js", ".test.mjs"],
  threeCompatibilityBoundary: "src/threeBridge/",
  browserSurfaceGlobals: Object.fromEntries([...browserSurfaceAllowlist].map(([file, values]) => [file, [...values].sort()])),
  developmentDependencySections: ["devDependencies"],
});
