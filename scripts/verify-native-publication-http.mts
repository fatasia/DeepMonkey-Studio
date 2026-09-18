/** Real isolated HTTP → Native window → frozen publication → Web ZIP → CLI verification.
 * Run: pnpm --filter @bim-studio/api exec tsx ../../scripts/verify-native-publication-http.mts <native.exe>
 * Writes only a unique test-output run directory; never loads an existing user's database.
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { JsonStore } from "../apps/api/src/jsonStore.js";
import { LocalObjectStore } from "../apps/api/src/objects.js";
import { createApiServer } from "../apps/api/src/serverOptions.js";
import { registerSystemRoutes } from "../apps/api/src/system.js";
import { registerSceneRoutes } from "../apps/api/src/sceneRoutes.js";
import { createNativeSceneCandidateService } from "../apps/api/src/nativeSceneCandidateService.js";
import { createNativeSceneCandidateCompiler, createVerifiedNativeSceneCandidateAssessor } from "../apps/api/src/nativeSceneCandidateCompiler.js";
import { prepareNativeSceneCandidate } from "../apps/api/src/prepareNativeSceneCandidate.js";
import { createNativeSceneWindowVerifier } from "../apps/api/src/nativeSceneWindowVerifier.js";

const root = fileURLToPath(new URL("../", import.meta.url)), executable = process.argv[2];
if (!executable || !path.isAbsolute(executable) || process.argv.length !== 3) throw new Error("Expected one absolute Native executable path");
const directory = path.join(root, "test-output/native-publication-http", randomUUID());
await mkdir(directory, { recursive: true });
// 并行 Cargo 构建可能覆盖入口 EXE；两次窗口固定使用本次独立副本。
const frozenExecutable = path.join(directory, "deep-engine-native.exe");
await copyFile(executable, frozenExecutable, constants.COPYFILE_EXCL);
const executableSha256 = createHash("sha256").update(await readFile(frozenExecutable)).digest("hex");
const run = promisify(execFile), bundlePath = path.join(directory, "compiler"), bundleDirectory = pathToFileURL(`${bundlePath}${path.sep}`);
await run(process.execPath, [path.join(root, "scripts/build-native-scene-compiler.mjs"), "--output", bundlePath], { cwd: root });
const dataDir = path.join(directory, "data"), store = new JsonStore(dataDir); await store.init();
const objects = new LocalObjectStore(dataDir), offset = 1e9, at = new Date().toISOString();
const scene = { schemaVersion: 1 as const, id: "native-http", projectId: "default", name: "Native HTTP large origin",
  models: [], primitives: [{ modelId: "box", name: "Box", kind: "box" as const, visible: true, opacity: 1, color: "#60a5fa",
    transform: { position: { x: offset, y: offset, z: offset }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }], measurements: [],
  camera: { mode: "orbit" as const, position: { x: offset + 3, y: offset + 2, z: offset + 5 }, target: { x: offset, y: offset, z: offset } },
  createdAt: at, updatedAt: at };
await store.saveScene(scene);
const compile = createNativeSceneCandidateCompiler(bundleDirectory), rawVerify = createNativeSceneWindowVerifier({ nativeExecutable: frozenExecutable, frames: 12, bundleDirectory });
const service = createNativeSceneCandidateService({ store, objects, dataDir,
  prepare: options => prepareNativeSceneCandidate(options, compile), assess: createVerifiedNativeSceneCandidateAssessor(bundleDirectory),
  verifyWindow: async (file, signal) => { const result = await rawVerify(file, signal); await writeFile(path.join(directory, "window-evidence.json"), JSON.stringify(result, null, 2)); return result; } });
const app = createApiServer();
try {
  await registerSystemRoutes(app, store, dataDir); await registerSceneRoutes(app, { store, deliveryStorage: { objects, dataDir }, nativeCandidates: service });
  const base = await app.listen({ port: 0, host: "127.0.0.1" }); let token = "";
  const request = async (url: string, payload?: unknown) => {
    const response = await fetch(`${base}${url}`, { ...(payload === undefined ? {} : { method: "POST", body: JSON.stringify(payload) }),
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    const result = await response.json(); if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(result)}`); return result;
  };
  token = (await request("/api/auth/login", { username: "admin", password: "admin" })).token;
  console.log("Preparing actual Native window candidate");
  const candidate = await request("/api/projects/default/scenes/native-http/native-candidates", { expectedSnapshot: scene });
  await writeFile(path.join(directory, "candidate.json"), JSON.stringify(candidate, null, 2));
  if (candidate.status !== "ready" || !candidate.candidateId) throw new Error("Actual Native candidate blocked; see candidate.json");
  const publication = await request("/api/projects/default/scenes/native-http/publish", { expectedSnapshot: scene, clientTarget: "deep-native", nativeCandidateId: candidate.candidateId });
  await writeFile(path.join(directory, "publication.json"), JSON.stringify(publication, null, 2));
  const require = createRequire(path.join(root, "apps/api/package.json")), { build } = require("esbuild");
  const exporter = path.join(directory, "exporter.mjs");
  await build({ absWorkingDir: root, entryPoints: ["apps/web/src/delivery/sceneClientPackage.ts"], outfile: exporter, bundle: true,
    platform: "node", format: "esm", conditions: ["development"], logLevel: "error", plugins: [{ name: "http-transport", setup(build: any) {
      build.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: "api", namespace: "http" }));
      build.onResolve({ filter: /browserDownload$/ }, () => ({ path: "download", namespace: "http" }));
      build.onResolve({ filter: /viewerAssetTransport$/ }, () => ({ path: "viewer", namespace: "http" }));
      build.onLoad({ filter: /.*/, namespace: "http" }, ({ path: name }: { path: string }) => ({ contents: name === "api"
        ? "export const api = globalThis.nativeHttpTransport;"
        : name === "download" ? "export const downloadBlob = (blob, name) => { globalThis.nativeHttpDownload = { blob, name }; };"
          : "export const loadViewerAssetBuffer = () => { throw new Error('Unexpected live resource read'); };", loader: "js" }));
    } }] });
  const global = globalThis as any;
  global.nativeHttpTransport = {
    getScenePublicationDependencies: (project: string, id: string, version: number) => request(`/api/projects/${project}/scenes/${id}/publications/${version}/dependencies`),
    loadScenePublicationResource: async (url: string, bytes: number, signal: AbortSignal) => {
      const response = await fetch(`${base}${url}`, { signal, headers: { authorization: `Bearer ${token}` } });
      if (!response.ok || response.headers.get("cache-control") !== "private, no-store") throw new Error("Private runtime read failed");
      const content = await response.arrayBuffer(); if (content.byteLength !== bytes) throw new Error("Runtime size mismatch"); return content;
    },
  };
  const { exportSceneClientPackage } = await import(pathToFileURL(exporter).href);
  await exportSceneClientPackage({ projectId: "default", scene: publication.snapshot, publication, target: "deep-native", renderer: "webgl", toolbarVisible: true });
  const download = global.nativeHttpDownload; if (!download?.blob) throw new Error("Web exporter produced no download");
  const zipPath = path.join(directory, download.name), zip = Buffer.from(await download.blob.arrayBuffer()); await writeFile(zipPath, zip);
  const verified = await run(process.execPath, [path.join(root, "scripts/verify-scene-client-package.mjs"), zipPath, "--target", "deep-native"], { cwd: root });
  const record = await request(`/api/projects/default/scenes/native-http/publications/${publication.version}/dependencies`);
  await writeFile(path.join(directory, "dependencies.json"), JSON.stringify(record, null, 2));
  await app.close();
  const offline = await run(process.execPath, [path.join(root, "scripts/run-scene-client-native.mjs"), zipPath,
    "--native-executable", frozenExecutable, "--verify-window"], { cwd: root });
  await writeFile(path.join(directory, "offline-window.log"), offline.stdout + offline.stderr);
  // Native startup telemetry precedes the CLI's JSON report on stdout.
  const reportStart = offline.stdout.search(/^\{/m);
  if (reportStart < 0) throw new Error("Offline window report missing");
  const offlineWindow = JSON.parse(offline.stdout.slice(reportStart));
  await writeFile(path.join(directory, "offline-window-evidence.json"), JSON.stringify(offlineWindow, null, 2));
  if (offlineWindow.sourceSha256 !== record.nativeCompiled.runtimePackage.sha256) throw new Error("Offline runtime differs from published runtime");
  if (offlineWindow.executableSha256 !== executableSha256) throw new Error("Offline executable identity changed");
  const report = { status: "verified", scope: "isolated-real-http-native-window-publication-web-zip", directory, zipPath,
    executableSha256, offlineApiStopped: true,
    zipSha256: createHash("sha256").update(zip).digest("hex"), nativeRuntimeSha256: record.nativeCompiled.runtimePackage.sha256,
    compiler: JSON.parse(await readFile(path.join(bundlePath, "manifest.json"), "utf8")), cli: JSON.parse(verified.stdout), offlineWindow };
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, directory, zipPath, zipSha256: report.zipSha256, cli: report.cli }, null, 2));
} finally { await app.close(); }
