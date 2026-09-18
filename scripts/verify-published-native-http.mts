/** Read-only verification/export of an existing publication. Never creates a candidate or publishes. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { parseDeepRuntimePackage } from "../packages/deep-engine/src/runtimePackage/index.ts";

const [base, projectId, sceneId, versionText, nativeExecutable] = process.argv.slice(2);
const version = Number(versionText);
if (!base || !projectId || !sceneId || !Number.isSafeInteger(version) || version < 1 || !nativeExecutable) throw new Error("Expected API URL projectId sceneId version Native-executable");
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "test-output/d10-browser-native-evidence", randomUUID()); await mkdir(directory, { recursive: true });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let token = "";
const fetchAvailable = async (url: string, options: RequestInit) => {
  for (let attempt = 0; ; attempt++) {
    try { return await fetch(url, options); }
    catch (error) {
      if (attempt >= 4 || options.signal?.aborted) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
};
const request = async (url: string, body?: unknown) => {
  const response = await fetchAvailable(`${base}${url}`, { ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!response.ok) throw new Error(`HTTP ${response.status} reading ${url}`); return response.json();
};
const health = await request("/health"), meta = await request("/api/meta");
token = (await request("/api/auth/login", { username: "admin", password: "admin" })).token;
const history = await request(`/api/projects/${projectId}/scenes/${sceneId}/publications`);
const matches = history.filter((item: any) => item.version === version && item.projectId === projectId && item.sceneId === sceneId);
if (matches.length !== 1) throw new Error("Publication version missing or ambiguous");
const publication = matches[0], dependencyUrl = `/api/projects/${projectId}/scenes/${sceneId}/publications/${version}/dependencies`;
const record = await request(dependencyUrl), compiled = record.nativeCompiled;
if (!compiled || compiled.compilationEvidence.recipe !== "deep-scene-static-compile-v5") throw new Error("Expected frozen v5 native compilation");
const readResource = async (url: string, expectedBytes: number, signal?: AbortSignal) => {
  const response = await fetchAvailable(`${base}${url}`, { signal, headers: { authorization: `Bearer ${token}` } });
  if (!response.ok || response.headers.get("cache-control") !== "private, no-store") throw new Error("Private byte authorization/cache policy mismatch");
  const bytes = await response.arrayBuffer(); if (bytes.byteLength !== expectedBytes) throw new Error("Private byte size mismatch"); return bytes;
};
const runtimeBytes = Buffer.from(await readResource(`${dependencyUrl}/resources/${compiled.runtimePackage.sha256}`, compiled.runtimePackage.bytes));
if (hash(runtimeBytes) !== compiled.runtimePackage.sha256) throw new Error("Frozen runtime hash mismatch");
const parsed = parseDeepRuntimePackage(runtimeBytes); if (!parsed.valid) throw new Error(JSON.stringify(parsed.issues));
const runtime: any = parsed.value, camera = runtime.payloads[runtime.entrypoints.camera];
if (camera.schemaVersion !== 2 || !camera.coordinateFrame) throw new Error("Expected Native camera schema 2");
const exeBytes = await readFile(nativeExecutable), executableSha256 = hash(exeBytes);
const frozenExecutable = path.join(directory, "native-client.exe"); await writeFile(frozenExecutable, exeBytes, { flag: "wx" });
await writeFile(path.join(directory, "publication.json"), JSON.stringify(publication, null, 2));
await writeFile(path.join(directory, "dependencies.json"), JSON.stringify(record, null, 2));
await writeFile(path.join(directory, "runtime-package.json"), runtimeBytes);
const require = createRequire(path.join(root, "apps/api/package.json")), { build } = require("esbuild");
const exporter = path.join(directory, "exporter.mjs");
await build({ absWorkingDir: root, entryPoints: ["apps/web/src/delivery/sceneClientPackage.ts"], outfile: exporter, bundle: true,
  platform: "node", format: "esm", conditions: ["development"], logLevel: "error", plugins: [{ name: "http-transport", setup(builder: any) {
    builder.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: "api", namespace: "http" }));
    builder.onResolve({ filter: /browserDownload$/ }, () => ({ path: "download", namespace: "http" }));
    builder.onResolve({ filter: /viewerAssetTransport$/ }, () => ({ path: "viewer", namespace: "http" }));
    builder.onLoad({ filter: /.*/, namespace: "http" }, ({ path: name }: { path: string }) => ({ contents: name === "api"
      ? "export const api = globalThis.nativeHttpTransport;"
      : name === "download" ? "export const downloadBlob = (blob, name) => { globalThis.nativeHttpDownload = { blob, name }; };"
        : "export const loadViewerAssetBuffer = () => { throw new Error('Unexpected live resource read'); };", loader: "js" }));
  } }] });
const global = globalThis as any;
global.nativeHttpTransport = {
  getScenePublicationDependencies: (project: string, scene: string, value: number) => request(`/api/projects/${project}/scenes/${scene}/publications/${value}/dependencies`),
  loadScenePublicationResource: readResource,
};
const { exportSceneClientPackage } = await import(pathToFileURL(exporter).href);
await exportSceneClientPackage({ projectId, scene: publication.snapshot, publication, target: "deep-native", renderer: "webgl", toolbarVisible: true });
const download = global.nativeHttpDownload; if (!download?.blob) throw new Error("Web exporter produced no ZIP");
const zipPath = path.join(directory, download.name), zip = Buffer.from(await download.blob.arrayBuffer()); await writeFile(zipPath, zip);
const run = promisify(execFile);
const cli = await run(process.execPath, [path.join(root, "scripts/verify-scene-client-package.mjs"), zipPath, "--target", "deep-native"], { cwd: root });
const offline = await run(process.execPath, [path.join(root, "scripts/run-scene-client-native.mjs"), zipPath, "--native-executable", frozenExecutable, "--verify-window"], { cwd: root });
await writeFile(path.join(directory, "offline-window.log"), offline.stdout + offline.stderr);
const reportStart = offline.stdout.search(/^\{/m); if (reportStart < 0) throw new Error("Offline window report missing");
const window = JSON.parse(offline.stdout.slice(reportStart));
if (window.sourceSha256 !== compiled.runtimePackage.sha256 || window.executableSha256 !== executableSha256) throw new Error("Offline identity mismatch");
await writeFile(path.join(directory, "offline-window-evidence.json"), JSON.stringify(window, null, 2));
const manager = JSON.parse(await readFile(path.join(root, "data/runtime/studio-manager.json"), "utf8"));
if (manager.configuration.apiPort !== Number(new URL(base).port)) throw new Error("Manager/API port mismatch");
const compilerManifest = JSON.parse(await readFile(path.join(root, "apps/api/dist/native-scene-compiler/manifest.json"), "utf8"));
const currentCompilerSha256 = hash(await readFile(path.join(root, "apps/api/dist/native-scene-compiler/compiler.mjs")));
if (currentCompilerSha256 !== compilerManifest.compilerSha256) throw new Error("Current deployed compiler bundle/manifest mismatch");
const report = { status: "verified", scope: "existing-browser-publication-api-read-web-function-export", browserDiskDownloadCaptured: false,
  projectId, sceneId, version, publicationName: publication.name, directory, zipPath, zipSha256: hash(zip), health, serverInstanceId: meta.serverInstanceId,
  managedService: { metadata: manager.configuration.metadataStore, objects: manager.configuration.objectStore,
    status: manager.status, pid: manager.pid, readyAt: manager.readyAt, apiPort: manager.configuration.apiPort,
    source: "data/runtime/studio-manager.json + API health/meta" },
  sourceSemanticHash: compiled.compilationEvidence.sourceSemanticHash, coordinateFrame: camera.coordinateFrame,
  sourceCamera: publication.snapshot.camera,
  runtimeSha256: compiled.runtimePackage.sha256, compilerSha256: compiled.compilerSha256, executableSha256,
  currentCompilerSha256, sameCompilerAsPublication: currentCompilerSha256 === compiled.compilerSha256,
  publicationExecutableSha256: compiled.executableSha256, sameExecutableAsPublication: executableSha256 === compiled.executableSha256,
  cli: JSON.parse(cli.stdout), offlineWindow: window, apiStoppedForOfflineCheck: false };
await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, directory, projectId, sceneId, version, cli: report.cli, runtimeSha256: report.runtimeSha256 }, null, 2));
