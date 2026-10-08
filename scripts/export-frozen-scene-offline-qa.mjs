import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { verifySceneClientArchive } from "./lib/sceneClientArchive.mjs";
const { build } = createRequire(new URL("../packages/deep-engine/package.json", import.meta.url))("esbuild");

// CPU delivery probe: the real publisher, frozen-resource reader and exporter.
// Never starts Cargo or launches a browser. Only named QA scene copies are accepted.
const [projectId, sceneName, outputArg] = process.argv.slice(2);
if (!projectId || !sceneName?.startsWith("QA ") || !outputArg) {
  throw new Error("Usage: node scripts/export-frozen-scene-offline-qa.mjs <projectId> <QA scene name> <output>");
}
const output = path.resolve(outputArg), origin = process.env.BIM_QA_API_ORIGIN ?? "http://127.0.0.1:4100";
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error("QA probe requires a loopback API");
await mkdir(output, { recursive: true });
const login = await fetch(new URL("/api/auth/login", origin), { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: process.env.BIM_QA_USER ?? "admin", password: process.env.BIM_QA_PASSWORD ?? "admin" }) });
if (!login.ok) throw new Error(`QA login: HTTP ${login.status}`);
const { token } = await login.json();
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
async function request(endpoint, init) {
  const response = await fetch(new URL(endpoint, origin), { ...init, headers, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}
const root = `/api/projects/${encodeURIComponent(projectId)}`;
const scenes = await request(`${root}/scenes`);
const matches = scenes.filter(scene => scene.name === sceneName);
if (matches.length !== 1) throw new Error("QA scene must resolve uniquely");
const scene = matches[0];
const publication = await request(`${root}/scenes/${encodeURIComponent(scene.id)}/publish`, { method: "POST",
  body: JSON.stringify({ expectedSnapshot: scene, clientTarget: "three-webview" }) });
const dependencies = await request(`${root}/scenes/${encodeURIComponent(scene.id)}/publications/${publication.version}/dependencies`);
await writeFile(path.join(output, "publication.json"), JSON.stringify(publication, null, 2));
await writeFile(path.join(output, "dependencies.json"), JSON.stringify(dependencies, null, 2));

// The browser host supplies origin/auth only; all assets come from the API's frozen version.
const storage = { getItem: key => key === "bim-studio-auth-token" ? token : null, setItem() {}, removeItem() {} };
globalThis.window = { location: { origin, href: `${origin}/` }, localStorage: storage, sessionStorage: storage,
  dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
await build({ absWorkingDir: path.resolve("apps/web"), entryPoints: ["src/delivery/sceneClientPackage.ts"], bundle: true,
  platform: "node", format: "esm", target: "es2022", outfile: path.join(output, "exporter.mjs"),
  define: { "import.meta.env": "{}" }, logLevel: "silent" });
const exporter = await import(pathToFileURL(path.join(output, "exporter.mjs")));
const zipPath = path.join(output, "scene.three-webview.bimscene.zip");
await exporter.exportSceneClientPackage({ projectId, scene: publication.snapshot, publication, target: "three-webview",
  renderer: "webgl", toolbarVisible: true, archiveConsumer: async (blob, _name, counts) => {
    await writeFile(zipPath, new Uint8Array(await blob.arrayBuffer()));
    return { fileName: zipPath, target: "three-webview", ...counts };
  } });
const zip = await readFile(zipPath), checked = await verifySceneClientArchive(zip, { expectedTarget: "three-webview" });
const report = { sceneId: scene.id, projectId, version: publication.version, publishedAt: publication.publishedAt,
  purpose: "CPU harness through production publisher/exporter", target: checked.manifest.target,
  zipPath, zipBytes: zip.length, zipSha256: createHash("sha256").update(zip).digest("hex"),
  contentHash: checked.manifest.contentHash.value, fileCount: checked.fileCount, uncompressedBytes: checked.totalBytes,
  frozenResourceCount: dependencies.resources.length,
  frozenResourceBytes: dependencies.resources.reduce((total, item) => total + item.bytes, 0),
  resources: dependencies.resources.map(({ sourceUrl, bytes, sha256 }) => ({ sourceUrl, bytes, sha256 })) };
await writeFile(path.join(output, "archive-evidence.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
