import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import ts from "typescript";

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|css|scss)$/;
const STYLE_EXTENSION = /\.(?:css|scss)$/;
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "test-output"]);
const CATEGORY_ORDER = ["reactLogic", "domCssBrowser", "echarts", "monaco", "worker", "network", "threeRawEscape"];

const DOM_GLOBALS = new Set([
  "document", "window", "navigator", "localStorage", "sessionStorage", "HTMLElement", "HTMLCanvasElement",
  "HTMLInputElement", "HTMLTextAreaElement", "CanvasRenderingContext2D", "ResizeObserver", "IntersectionObserver",
  "MutationObserver", "FileReader", "Image", "ImageData", "OffscreenCanvas", "createImageBitmap", "requestAnimationFrame",
]);
const RAW_GRAPHICS_TYPES = /^(?:GPU[A-Z]\w*|WebGL2?RenderingContext|CanvasRenderingContext2D|OffscreenCanvas)$/;
const ECHARTS_OPTION_KEYS = new Set(["series", "xAxis", "yAxis", "visualMap", "tooltip", "legend", "dataset", "dataZoom"]);
const NETWORK_CONSTRUCTORS = new Set(["WebSocket", "EventSource", "XMLHttpRequest", "RTCPeerConnection"]);

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function moduleOf(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier.text;
  }
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
    const argument = node.arguments[0];
    if (argument && ts.isStringLiteral(argument)) return argument.text;
  }
  return undefined;
}

function createEvidenceStore() {
  const files = new Map();
  const add = (category, file, kind, line = 1) => {
    const fileEntry = files.get(file) ?? new Map();
    const categoryEntry = fileEntry.get(category) ?? { matches: 0, kinds: new Map(), firstLine: line };
    categoryEntry.matches += 1;
    categoryEntry.kinds.set(kind, (categoryEntry.kinds.get(kind) ?? 0) + 1);
    categoryEntry.firstLine = Math.min(categoryEntry.firstLine, line);
    fileEntry.set(category, categoryEntry);
    files.set(file, fileEntry);
  };
  return { add, files };
}

/** Static candidate scan. Counts locate coupling; they deliberately do not estimate native-port effort. */
export function scanNativeUiSources(sources) {
  const store = createEvidenceStore();
  const parseDiagnostics = [];
  const orderedSources = [...sources].sort((a, b) => a.file.localeCompare(b.file, "en"));
  const sourceFiles = new Map(orderedSources.filter(({ file }) => !STYLE_EXTENSION.test(file)).map(({ file, code }) => {
    const scriptKind = file.endsWith("x") ? ts.ScriptKind.TSX : file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")
      ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    return [file, ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, scriptKind)];
  }));
  const options = { noResolve: true, noLib: true, allowJs: true, target: ts.ScriptTarget.Latest, jsx: ts.JsxEmit.Preserve };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (file) => sourceFiles.get(file);
  const checker = ts.createProgram([...sourceFiles.keys()], options, host).getTypeChecker();
  const isUnbound = (identifier) => !checker.getSymbolAtLocation(identifier);

  for (const { file } of orderedSources) {
    if (STYLE_EXTENSION.test(file)) {
      store.add("domCssBrowser", file, "stylesheet");
      continue;
    }
    const source = sourceFiles.get(file);
    for (const diagnostic of source.parseDiagnostics) {
      parseDiagnostics.push({ file, line: source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1, code: diagnostic.code });
    }

    const visit = (node) => {
      const line = lineOf(source, node);
      const module = moduleOf(node);
      if (module) {
        if (module === "react" || module.startsWith("react/") || module === "react-dom" || module.startsWith("react-dom/")) {
          store.add("reactLogic", file, `module:${module}`, line);
          if (module.startsWith("react-dom")) store.add("domCssBrowser", file, `module:${module}`, line);
        }
        if (module === "echarts" || module.startsWith("echarts/") || module.startsWith("echarts-")) {
          store.add("echarts", file, `module:${module}`, line);
        }
        if (module === "monaco-editor" || module.startsWith("monaco-editor/") || module === "@monaco-editor/react") {
          store.add("monaco", file, `module:${module}`, line);
        }
        if (module === "three" || module.startsWith("three/") || module === "three-mesh-bvh") {
          store.add("threeRawEscape", file, `module:${module}`, line);
        }
      }

      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
        store.add("reactLogic", file, "jsx", line);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        if (/^use[A-Z]/.test(name)) store.add("reactLogic", file, `hook:${name}`, line);
        if (name === "fetch" && isUnbound(node.expression)) store.add("network", file, "api:fetch", line);
        if (name === "createImageBitmap" && isUnbound(node.expression)) store.add("domCssBrowser", file, "api:createImageBitmap", line);
        if ((name === "postMessage" || name === "importScripts") && isUnbound(node.expression)) store.add("worker", file, `api:${name}`, line);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const name = node.expression.name.text;
        if (name === "setOption" || name === "getOption") store.add("echarts", file, `api:${name}`, line);
        if (name === "sendBeacon") store.add("network", file, "api:sendBeacon", line);
        if (name === "postMessage") store.add("worker", file, "api:postMessage", line);
        if (name === "getContext" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          const context = node.arguments[0].text;
          if (/^(?:2d|webgl2?|webgpu)$/.test(context)) store.add("threeRawEscape", file, `raw-context:${context}`, line);
        }
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        if ((name === "Worker" || name === "SharedWorker") && isUnbound(node.expression)) store.add("worker", file, `constructor:${name}`, line);
        if (NETWORK_CONSTRUCTORS.has(name) && isUnbound(node.expression)) store.add("network", file, `constructor:${name}`, line);
      }
      if (ts.isIdentifier(node)) {
        const name = node.text;
        if (DOM_GLOBALS.has(name) && isUnbound(node)) store.add("domCssBrowser", file, `identifier:${name}`, line);
        if (/^(?:ECharts|EChartsType|EChartsCoreOption|ECElementEvent)$/.test(name)) store.add("echarts", file, `identifier:${name}`, line);
        if (/^(?:Monaco|MonacoEditor|IStandaloneCodeEditor)$/.test(name) || name === "monaco") store.add("monaco", file, `identifier:${name}`, line);
        if (RAW_GRAPHICS_TYPES.test(name) && isUnbound(node)) store.add("threeRawEscape", file, `raw-type:${name}`, line);
      }
      if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ts.isIdentifier(node.name)
        && ECHARTS_OPTION_KEYS.has(node.name.text)) {
        store.add("echarts", file, `option-key:${node.name.text}`, line);
      }
      if ((ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) && ts.isIdentifier(node.expression)
        && node.expression.text === "navigator" && node.name.text === "gpu" && isUnbound(node.expression)) {
        store.add("threeRawEscape", file, "raw-api:navigator.gpu", line);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (/\.worker\.[cm]?[jt]sx?$/.test(file)) store.add("worker", file, "worker-entry-file");
  }

  const fileEvidence = [];
  const categories = Object.fromEntries(CATEGORY_ORDER.map((category) => [category, { fileCount: 0, matchCount: 0, kindCounts: {}, representativeFiles: [] }]));
  for (const [file, fileEntry] of [...store.files].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const entry = { file, categories: {} };
    for (const [category, evidence] of fileEntry) {
      const kinds = Object.fromEntries([...evidence.kinds].sort(([a], [b]) => a.localeCompare(b, "en")));
      entry.categories[category] = { matches: evidence.matches, firstLine: evidence.firstLine, kinds };
      const aggregate = categories[category];
      aggregate.fileCount += 1;
      aggregate.matchCount += evidence.matches;
      for (const [kind, count] of Object.entries(kinds)) aggregate.kindCounts[kind] = (aggregate.kindCounts[kind] ?? 0) + count;
    }
    fileEvidence.push(entry);
  }
  for (const [category, aggregate] of Object.entries(categories)) {
    aggregate.kindCounts = Object.fromEntries(Object.entries(aggregate.kindCounts).sort(([a], [b]) => a.localeCompare(b, "en")));
    aggregate.representativeFiles = fileEvidence
      .filter((entry) => entry.categories[category])
      .map((entry) => ({ file: entry.file, ...entry.categories[category] }))
      .sort((a, b) => b.matches - a.matches || a.file.localeCompare(b.file, "en"))
      .slice(0, 8);
  }
  return { categories, fileEvidence, parseDiagnostics: parseDiagnostics.sort((a, b) => a.file.localeCompare(b.file, "en") || a.line - b.line) };
}

async function collectTree(root, workspace, files) {
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) await collectTree(path, workspace, files);
    else if (entry.isFile() && SOURCE_EXTENSION.test(entry.name)) files.push({ path, file: relative(workspace, path).replaceAll("\\", "/") });
  }
}

async function discoverScope(workspace) {
  const webPackage = JSON.parse(await readFile(join(workspace, "apps/web/package.json"), "utf8"));
  const wanted = new Set(Object.entries(webPackage.dependencies ?? {})
    .filter(([name, version]) => name.startsWith("@bim-studio/") && String(version).startsWith("workspace:"))
    .map(([name]) => name));
  const sharedPackages = [];
  for (const entry of (await readdir(join(workspace, "packages"), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (!entry.isDirectory()) continue;
    const root = join(workspace, "packages", entry.name);
    try {
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      if (wanted.has(manifest.name)) sharedPackages.push({ name: manifest.name, root: `packages/${entry.name}/src` });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { webPackage, sharedPackages };
}

export async function collectNativeUiInventory(workspace) {
  const { webPackage, sharedPackages } = await discoverScope(workspace);
  const roots = ["apps/web/src", ...sharedPackages.map((item) => item.root)];
  const files = [];
  for (const root of roots) await collectTree(join(workspace, root), workspace, files);
  const sources = [];
  const manifest = [];
  for (const item of files.sort((a, b) => a.file.localeCompare(b.file, "en"))) {
    const buffer = await readFile(item.path);
    const code = buffer.toString("utf8");
    sources.push({ file: item.file, code });
    manifest.push({ file: item.file, bytes: buffer.byteLength, sha256: createHash("sha256").update(buffer).digest("hex") });
  }
  const scan = scanNativeUiSources(sources);
  return {
    schemaVersion: 1,
    inventoryDate: "2026-09-12",
    status: "static-source-candidate-inventory-only",
    scope: { roots, sharedPackages, includesTestsAndDeclarations: true, excludesGeneratedAndDependencyTrees: true },
    frameworkVersions: {
      react: webPackage.dependencies?.react ?? null,
      echarts: webPackage.dependencies?.echarts ?? null,
      monacoEditor: webPackage.dependencies?.["monaco-editor"] ?? null,
      three: webPackage.dependencies?.three ?? null,
    },
    source: {
      fileCount: manifest.length,
      byteCount: manifest.reduce((sum, item) => sum + item.bytes, 0),
      corpusSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
      manifest,
    },
    categoryDefinitions: {
      reactLogic: "React/ReactDOM imports, JSX nodes, and useX hook call candidates.",
      domCssBrowser: "Stylesheets plus direct DOM, browser-global, canvas, observer, storage, animation, and ReactDOM candidates.",
      echarts: "ECharts imports/types/runtime calls and common option-key candidates.",
      monaco: "Monaco package imports and editor namespace/type candidates.",
      worker: "Worker entry files, constructors, postMessage, and importScripts candidates.",
      network: "Direct fetch, WebSocket, EventSource, XMLHttpRequest, WebRTC, and sendBeacon candidates.",
      threeRawEscape: "Three imports plus direct Canvas/WebGL/WebGPU context or type candidates.",
    },
    limitations: [
      "Static source candidates are not a runtime dependency graph, parity proof, or native-port estimate.",
      "Match counts measure lexical/AST evidence occurrences; they must not be converted into engineering hours or completion percentages.",
      "Tests, declaration files, and stylesheets are included and should be filtered by file path for production-only estimates.",
      "Common ECharts option keys and browser identifiers can include false positives or shadowed local symbols.",
      "Persisted project scripts, published applications, remote plugins, generated bundles, assets, and node_modules are not scanned.",
      "Shared package scope is limited to direct @bim-studio workspace dependencies declared by apps/web.",
      "The scan does not measure visual fidelity, Chinese IME, accessibility, text shaping, chart semantics, GPU cost, or network behavior.",
    ],
    ...scan,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const target = resolve(workspace, process.argv[2] ?? "test-output/diagnostics/native-ui-source-inventory.json");
  const report = await collectNativeUiInventory(workspace);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output: target, files: report.source.fileCount, corpusSha256: report.source.corpusSha256,
    categories: Object.fromEntries(Object.entries(report.categories).map(([name, value]) => [name, { files: value.fileCount, matches: value.matchCount }])) }));
}
