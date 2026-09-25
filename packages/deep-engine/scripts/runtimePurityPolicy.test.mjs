import assert from "node:assert/strict";
import { test } from "node:test";
import { RUNTIME_PURITY_ALLOWLIST, scanCargoManifest, scanNativeDependencyTree, scanNativeRuntime, scanPackageManifest, scanTypeScriptRuntime, stripRustTrivia, stripWasm32OnlyItems } from "./runtimePurityPolicy.mjs";

test("rejects static, aliased, dynamic, CommonJS, re-export, WebGL and DOM baggage", () => {
  const issues = scanTypeScriptRuntime([{ file: "src/core.ts", code: `
    import R from "react";
    import Fiber from "@react-three/fiber";
    import { Engine } from "@babylonjs/core";
    import { Engine3D } from "@orillusion/core";
    export * from "echarts/core";
    require("three/addons/x.js");
    import("react-dom/client");
    const a = document.body;
    const b = globalThis["WebGL2RenderingContext"];
    canvas.getContext("webgl2");
  ` }]);
  assert.deepEqual(issues.map(({ code }) => code), [
    "denied-module", "denied-module", "denied-module", "denied-module", "denied-module", "denied-module", "denied-module",
    "dom-api", "webgl-api", "webgl-context",
  ]);
});

test("does not mistake comments, strings or locally shadowed names for globals", () => {
  const issues = scanTypeScriptRuntime([{ file: "src/gltf.ts", code: `
    // window.document and WebGL2RenderingContext are documentation only.
    const note = "React ECharts WebView Chromium";
    const document = { asset: 1 };
    const metadata = { window: 1, document: 2 };
    type Payload = { document: string };
    function read(window: { value: number }) { return document.asset + window.value; }
  ` }]);
  assert.deepEqual(issues, []);
});

test("keeps Three inside its explicit bridge and blocks it from core", () => {
  assert.deepEqual(scanTypeScriptRuntime([{ file: "src/threeBridge/adapter.ts", code: `import type { Mesh } from "three";` }]), []);
  const core = scanTypeScriptRuntime([{ file: "src/core.ts", code: `export * from "./threeBridge/index.js";` }]);
  assert.deepEqual(core.map(({ code }) => code), ["bridge-boundary-crossed"]);
  assert.equal(RUNTIME_PURITY_ALLOWLIST.threeCompatibilityBoundary, "src/threeBridge/");
});

test("type-only bridge imports erase at compile time and stay pure", () => {
  const typeOnly = scanTypeScriptRuntime([{ file: "src/webgpu/host.ts",
    code: "import type { BackendCanvasDeck } from \"../threeBridge/BackendCanvasDeck.js\";\nlet deck: BackendCanvasDeck | undefined;" }]);
  assert.deepEqual(typeOnly, []);
  const value = scanTypeScriptRuntime([{ file: "src/webgpu/host.ts",
    code: "import { BackendCanvasDeck } from \"../threeBridge/BackendCanvasDeck.js\";" }]);
  assert.deepEqual(value.map(({ code }) => code), ["bridge-boundary-crossed"]);
});

test("surface allowlist is exact and cannot spread DOM APIs into another file", () => {
  assert.deepEqual(scanTypeScriptRuntime([{ file: "src/webgpu/deviceSession.ts", code: `let canvas: HTMLCanvasElement; new DOMException();` }]), []);
  assert.deepEqual(scanTypeScriptRuntime([{ file: "src/app/pbrRendererPlugin.ts", code: `let canvas: HTMLCanvasElement;` }]), []);
  const issues = scanTypeScriptRuntime([{ file: "src/webgpu/other.ts", code: `let canvas: HTMLCanvasElement; new DOMException();` }]);
  assert.deepEqual(issues.map(({ detail }) => detail), ["HTMLCanvasElement", "DOMException"]);
});

test("rejects computed module names because they evade static dependency review", () => {
  const issues = scanTypeScriptRuntime([{ file: "src/core.ts", code: `const name = "three"; import(name); require(name);` }]);
  assert.deepEqual(issues.map(({ code }) => code), ["dynamic-module-specifier", "dynamic-module-specifier"]);
});

test("rejects production manifest dependencies but permits explicit dev tooling", () => {
  const issues = scanPackageManifest({
    dependencies: { react: "1", "@babylonjs/core": "1", "@orillusion/core": "1" },
    optionalDependencies: { echarts: "1" },
    devDependencies: { three: "1" },
    exports: { ".": "./dist/index.js", "./three-bridge": "./dist/threeBridge/index.js" },
  });
  assert.deepEqual(issues.map(({ detail }) => detail), ["dependencies:react", "dependencies:@babylonjs/core", "dependencies:@orillusion/core", "optionalDependencies:echarts"]);
});

test("detects a Three bridge leak through the root export", () => {
  const issues = scanPackageManifest({ exports: { ".": "./dist/threeBridge/index.js" } });
  assert.deepEqual(issues.map(({ code }) => code), ["bridge-export-leak"]);
});

test("native scanner ignores comments and literals but rejects executable identifiers", () => {
  const source = `
    // tauri::Builder and WebGL are examples only.
    const NOTE: &str = "React ECharts Chromium WebView";
    fn boot() { tauri::Builder::default(); web_sys::window(); orillusion::boot(); }
  `;
  assert.ok(!stripRustTrivia(source).includes("examples only"));
  assert.deepEqual(scanNativeRuntime([{ file: "src/main.rs", code: source }]).map(({ detail }) => detail), ["tauri", "web_sys", "orillusion"]);
});

test("native scanner excludes only exact wasm32 cfg items", () => {
  const source = `
    #[cfg(target_arch = "wasm32")]
    thread_local! { static CANVAS: web_sys::HtmlCanvasElement = browser_canvas(); }
    #[cfg(target_arch = "wasm32")]
    pub fn canvas() -> web_sys::HtmlCanvasElement { web_sys::window().unwrap() }
    #[cfg(target_os = "linux")]
    pub fn shell() { web_sys::window(); }
    pub fn native() { wasm_bindgen::throw_str("blocked"); }
  `;
  assert.equal(stripWasm32OnlyItems(source).split("\n").length, source.split("\n").length);
  assert.deepEqual(scanNativeRuntime([{ file: "src/main.rs", code: source }]).map(({ detail }) => detail), ["web_sys", "wasm_bindgen"]);
});

test("resolved Windows dependency tree blocks browser and GL fallback bindings", () => {
  const issues = scanNativeDependencyTree(["wgpu v30.0.1", "web-sys v0.3", "wasm_bindgen-futures v0.4", "webkit2gtk-sys v2", "glutin v0.32", "winit v0.30"]);
  assert.deepEqual(issues.map(({ detail }) => detail), ["web-sys", "wasm_bindgen-futures", "webkit2gtk-sys", "glutin"]);
});

test("Cargo manifest blocks target-specific and aliased browser shells while allowing dev fixtures", () => {
  const issues = scanCargoManifest(`
    [dependencies]
    renderer = { package = "wgpu", version = "30", default-features = false, features = ["dx12", "metal", "vulkan", "wgsl"] }
    shell = { package = "tauri", version = "2" }
    [target.'cfg(target_os = "linux")'.dependencies]
    webkit2gtk = "2"
    [dev-dependencies]
    wasm-bindgen = "1"
  `);
  assert.deepEqual(issues.map(({ detail }) => detail), ["tauri", "webkit2gtk"]);
});

test("Cargo manifest excludes exact wasm32 target dependencies from the native gate", () => {
  const issues = scanCargoManifest(`
    [target.'cfg(target_arch = "wasm32")'.dependencies]
    wasm-bindgen-futures = "0.4"
    web-sys = "0.3"
    [target.'cfg(target_os = "linux")'.dependencies]
    webkit2gtk = "2"
  `);
  assert.deepEqual(issues.map(({ detail }) => detail), ["webkit2gtk"]);
});

test("Cargo manifest rejects wgpu defaults and WebGL or browser backend features", () => {
  const issues = scanCargoManifest(`
    [dependencies]
    implicit = { package = "wgpu", version = "30" }
    explicit = { package = "wgpu", version = "30", default-features = false, features = ["vulkan", "gles", "webgpu"] }
  `);
  assert.deepEqual(issues.map(({ code, detail }) => ({ code, detail })), [
    { code: "wgpu-default-features", detail: "wgpu must disable defaults because they include GLES and browser backends" },
    { code: "denied-wgpu-feature", detail: "gles" },
    { code: "denied-wgpu-feature", detail: "webgpu" },
  ]);
});

test("syntax errors fail closed", () => {
  const issues = scanTypeScriptRuntime([{ file: "src/bad.ts", code: "const value = ;" }]);
  assert.ok(issues.some(({ code }) => code === "parse-error"));
});

test("HTML and CSS cannot enter the runtime source tree", () => {
  const issues = scanTypeScriptRuntime([
    { file: "src/shell.html", code: "<main></main>" },
    { file: "src/shell.css", code: "main { display: block }" },
  ]);
  assert.deepEqual(issues.map(({ code }) => code), ["ui-source-in-runtime", "ui-source-in-runtime"]);
});
