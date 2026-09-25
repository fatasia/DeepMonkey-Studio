import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const bundle = fileURLToPath(new URL("../local-api-bundle/", import.meta.url));
const desktopExecutable = fileURLToPath(new URL("../src-tauri/target/release/bim-studio-desktop.exe", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(bundle, "publication-runtime.json"), "utf8"));
const workspace = await mkdtemp(path.join(tmpdir(), "deep-monkey-local-publication-"));
const token = "local-publication-smoke-token-00000000000000000000000000000000";
const retainedOutput = process.env.LOCAL_PUBLICATION_SMOKE_OUTPUT
  ? path.resolve(process.env.LOCAL_PUBLICATION_SMOKE_OUTPUT) : undefined;
let child;
try {
  const resources = Object.fromEntries(Object.entries(manifest.resources)
    .map(([name, resource]) => [name, resolveBundlePath(resource.path)]));
  const materialize = value => {
    if (Array.isArray(value)) return value.map(materialize);
    if (value && typeof value === "object") {
      if (Object.keys(value).length === 1 && typeof value.resource === "string") return resources[value.resource];
      if (Object.keys(value).length === 1 && typeof value.relativePath === "string") return resolveBundlePath(value.relativePath);
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, materialize(entry)]));
    }
    return value;
  };
  const dashboardFile = path.join(workspace, "config/dashboard-native.json");
  await mkdir(path.dirname(dashboardFile), { recursive: true });
  await writeFile(dashboardFile, JSON.stringify(materialize(manifest.dashboardDeploymentTemplate), null, 2));
  const port = await freePort();
  const node = path.join(bundle, process.platform === "win32" ? "node.exe" : "node");
  child = spawn(node, [path.join(bundle, "dist/index.js")], {
    cwd: bundle, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "desktop-local", BIM_STUDIO_DEPLOYMENT_MODE: "desktop-local",
      BIM_STUDIO_DESKTOP_LOCAL_TOKEN: token, BIM_STUDIO_SESSION_SECRET: `${token}-session`,
      BIM_STUDIO_ADMIN_PASSWORD: `${token}-password`, API_HOST: "127.0.0.1", API_PORT: String(port),
      WEB_ORIGIN: "http://tauri.localhost", METADATA_STORE: "sqlite",
      SQLITE_DATABASE: path.join(workspace, "metadata.sqlite"), OBJECT_STORE: "local",
      DATA_DIR: path.join(workspace, "data"), NATIVE_SCENE_VERIFIER_EXECUTABLE: resources.nativeExecutable,
      JAVA_HOME: resolveBundlePath(manifest.environment.JAVA_HOME), DASHBOARD_NATIVE_DEPLOYMENT_FILE: dashboardFile,
      THREE_SCENE_VIEWER_LAUNCHER_EXECUTABLE: desktopExecutable },
  });
  const errors = []; child.stderr.on("data", chunk => { if (errors.length < 100) errors.push(chunk); });
  await waitForHealth(port, child, errors);
  const headers = { authorization: `Bearer ${token}` };
  const checks = [
    ["auth", await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers }), 200],
    ["native-route", await fetch(`http://127.0.0.1:${port}/api/projects/p/scenes/s/native-candidates`,
      { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" }), 400],
    ["dashboard-route", await fetch(`http://127.0.0.1:${port}/api/projects/p/applications/a/dashboard-candidates`,
      { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" }), 400],
    ["three-route", await fetch(`http://127.0.0.1:${port}/api/projects/p/scenes/s/publications/1/three-webview-executable`,
      { method: "POST", headers }), 404],
  ];
  for (const [name, response, expected] of checks) {
    if (response.status !== expected) throw new Error(`${name}: expected ${expected}, got ${response.status}: ${await response.text()}`);
  }
  const publication = await createPublishedFixture(port, headers);
  const archive = await createSceneArchive(publication);
  const form = new FormData(); form.set("archive", new Blob([archive]), "factory.three-webview.bimscene.zip");
  const download = await fetch(`http://127.0.0.1:${port}/api/projects/${publication.projectId}/scenes/${publication.sceneId}`
    + `/publications/${publication.version}/three-webview-executable`, { method: "POST", headers, body: form });
  if (download.status !== 200) throw new Error(`three-download: expected 200, got ${download.status}: ${await download.text()}`);
  const executable = path.join(workspace, "Factory Viewer.exe");
  await writeFile(executable, Buffer.from(await download.arrayBuffer()));
  const inspection = JSON.parse(await execute(executable, ["--inspect-scene-viewer-payload"]));
  if (!inspection.ok || !inspection.readOnly || inspection.sourceContentHash !== archive.contentHash
    || inspection.packageId !== archive.contentHash.slice(0, 16)) throw new Error(`Three launcher identity mismatch: ${JSON.stringify(inspection)}`);
  if (retainedOutput) {
    await mkdir(retainedOutput, { recursive: true });
    await copyFile(executable, path.join(retainedOutput, "Factory Viewer.exe"));
    await writeFile(path.join(retainedOutput, "inspection.json"), `${JSON.stringify(inspection, null, 2)}\n`);
  }
  console.log(`Local publication sidecar smoke passed: auth=200 native=400 dashboard=400 three=200 `
    + `package=${inspection.packageId} payload=${inspection.payloadSha256}`
    + (retainedOutput ? ` output=${retainedOutput}` : ""));
} finally {
  if (child && child.exitCode === null) await new Promise(resolve => {
    const timer = setTimeout(resolve, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
  await rm(workspace, { recursive: true, force: true });
}

async function createPublishedFixture(port, headers) {
  const base = `http://127.0.0.1:${port}`;
  const projectResponse = await fetch(`${base}/api/projects`, { method: "POST",
    headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "Three Launcher Smoke" }) });
  if (projectResponse.status !== 201) throw new Error(`project fixture failed: ${projectResponse.status} ${await projectResponse.text()}`);
  const project = await projectResponse.json();
  const scene = { schemaVersion: 1, id: "three-launcher-smoke", projectId: project.id, name: "Factory Viewer",
    models: [], primitives: [], measurements: [], camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 },
      target: { x: 0, y: 0, z: 0 } }, createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z" };
  const savedResponse = await fetch(`${base}/api/projects/${project.id}/scenes/${scene.id}`, { method: "PUT",
    headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(scene) });
  if (!savedResponse.ok) throw new Error(`scene fixture failed: ${savedResponse.status} ${await savedResponse.text()}`);
  const saved = await savedResponse.json();
  const publicationResponse = await fetch(`${base}/api/projects/${project.id}/scenes/${scene.id}/publish`, { method: "POST", headers });
  if (publicationResponse.status !== 201) throw new Error(`publication fixture failed: ${publicationResponse.status} ${await publicationResponse.text()}`);
  const publication = await publicationResponse.json();
  if (!Number.isSafeInteger(publication.version)) throw new Error("publication fixture has no version");
  return { ...publication, project };
}

async function createSceneArchive(publication) {
  const requireFromBundle = createRequire(path.join(bundle, "package.json"));
  const runtimeModule = await import(pathToFileURL(requireFromBundle.resolve("@bim-studio/deep-engine/runtime-package")).href);
  const JSZip = requireFromBundle("jszip");
  const files = new Map([
    ["scene.json", Buffer.from(JSON.stringify(publication.snapshot))],
    ["project.json", Buffer.from(JSON.stringify(publication.project))],
    ["applications.json", Buffer.from("[]")],
    ["runtime.json", Buffer.from(JSON.stringify({ connections: [], datasets: [], pipelines: [], policy: "credentials-external",
      reconfigureConnectionIds: [] }))],
    ["README.txt", Buffer.from("readonly Three launcher smoke")],
  ]);
  const descriptors = [...files].map(([filePath, bytes]) => ({ path: filePath, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), sourceUrl: filePath }));
  const metadata = { kind: "bim-studio-scene-client-package", schemaVersion: 1, purpose: "delivery", target: "three-webview",
    renderer: "webgl", toolbarVisible: true, projectId: publication.projectId, sceneId: publication.sceneId,
    sceneName: publication.name, publishedAt: publication.publishedAt };
  const contentHash = runtimeModule.runtimeContentSha256({ metadata,
    files: descriptors.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) });
  const packageManifest = { ...metadata, generatedAt: publication.publishedAt, files: descriptors,
    contentHash: { algorithm: "sha256", value: contentHash } };
  const zip = new JSZip();
  for (const [filePath, bytes] of files) zip.file(filePath, bytes);
  zip.file("manifest.json", JSON.stringify(packageManifest));
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
  return Object.assign(bytes, { contentHash });
}

function execute(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const output = [], errors = [];
    child.stdout.on("data", bytes => output.push(bytes)); child.stderr.on("data", bytes => errors.push(bytes));
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(Buffer.concat(output).toString("utf8").trim())
      : reject(new Error(`${path.basename(command)} exited ${code}: ${Buffer.concat(errors).toString("utf8")}`)));
  });
}

function resolveBundlePath(relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === "..")) {
    throw new Error(`Unsafe bundle path: ${relative}`);
  }
  return path.join(bundle, relative);
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject); server.listen(0, "127.0.0.1", () => {
      const address = server.address(); server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}
async function waitForHealth(port, process, errors) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Sidecar exited ${process.exitCode}: ${Buffer.concat(errors).toString("utf8")}`);
    try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Sidecar startup timeout: ${Buffer.concat(errors).toString("utf8")}`);
}
