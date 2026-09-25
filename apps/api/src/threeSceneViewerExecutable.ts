import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { DEFAULT_PRODUCT_BRANDING } from "@bim-studio/contracts";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { readDashboardWindowsExecutable } from "./dashboardWindowsExecutable.js";
import { applyNativeExecutableBranding } from "./nativeExecutableBranding.js";
import { parseClientPackageBranding } from "./clientPackageBranding.js";
import { threeSceneViewerCache, threeSceneViewerCacheDirectory } from "./threeSceneViewerCache.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cacheDirectory = threeSceneViewerCacheDirectory;
const footerMagic = Buffer.from("DMTHREE1", "ascii");
const footerBytes = 48;

interface ThreeArchiveManifest {
  kind: "bim-studio-scene-client-package";
  schemaVersion: 1;
  purpose: "delivery";
  target: "three-webview";
  renderer: "webgl" | "webgpu-preferred";
  toolbarVisible: boolean;
  projectId: string;
  sceneId: string;
  sceneName: string;
  publishedAt: string;
  generatedAt: string;
  files: Array<{ path: string; bytes: number; sha256: string; sourceUrl: string }>;
  contentHash: { algorithm: "sha256"; value: string };
  branding?: { applicationName?: string; iconPath?: string };
}

export interface ThreeSceneViewerExecutableDependencies {
  launcherExecutable?: string;
  builderScript?: string;
}

export async function inspectThreeSceneArchive(bytes: Uint8Array): Promise<{ projectId: string; sceneId: string; publishedAt: string }> {
  const { manifest } = await readThreeSceneArchive(bytes);
  return { projectId: manifest.projectId, sceneId: manifest.sceneId, publishedAt: manifest.publishedAt };
}

/** Prefer the fixed installed launcher; the source builder remains a development fallback. */
export async function buildThreeSceneViewerExecutable(dependencies: ThreeSceneViewerExecutableDependencies,
archive: Uint8Array, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  if (dependencies.launcherExecutable) {
    const [launcher, delivery] = await Promise.all([
      readDashboardWindowsExecutable(dependencies.launcherExecutable, signal),
      createThreeSceneViewerPayload(archive, signal),
    ]);
    if (launcher.length >= footerBytes && launcher.subarray(-footerBytes, -footerBytes + footerMagic.length).equals(footerMagic)) {
      throw new Error("Three WebView launcher already contains a delivery payload");
    }
    const branding = await delivery.executableBranding;
    signal.throwIfAborted();
    const branded = Object.keys(branding).length ? await applyNativeExecutableBranding(launcher, branding, signal) : launcher;
    const footer = Buffer.alloc(footerBytes);
    footerMagic.copy(footer, 0);
    footer.writeBigUInt64LE(BigInt(delivery.payload.length), 8);
    createHash("sha256").update(delivery.payload).digest().copy(footer, 16);
    return Buffer.concat([branded, delivery.payload, footer]);
  }
  if (!dependencies.builderScript) throw new Error("Three WebView installed launcher is unavailable");
  return buildWorkspaceSceneViewerExecutable(dependencies.builderScript, archive, signal);
}

async function createThreeSceneViewerPayload(archive: Uint8Array, signal: AbortSignal) {
  const source = await readThreeSceneArchive(archive, signal);
  const { manifest, files } = source;
  const readJson = (name: string) => JSON.parse(files.get(name)!.toString("utf8")) as Record<string, unknown>;
  const scene = readJson("scene.json"), project = readJson("project.json");
  if (scene.id !== manifest.sceneId || scene.projectId !== manifest.projectId || scene.publishedAt !== manifest.publishedAt
    || project.id !== manifest.projectId) throw new Error("Three WebView package payload identity mismatch");
  const localPaths = new Set(manifest.files.filter(file => file.path.startsWith("assets/") || file.path === manifest.branding?.iconPath)
    .map(file => file.path));
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") return localPaths.has(value) ? `/delivery/${value}` : value;
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)]));
  };
  const publication = rewrite({ sceneId: manifest.sceneId, projectId: manifest.projectId, name: manifest.sceneName,
    publishedAt: manifest.publishedAt, snapshot: scene }) as Record<string, unknown>;
  const rewrittenProject = rewrite(project);
  const productName = manifest.branding?.applicationName ?? DEFAULT_PRODUCT_BRANDING.systemName;
  const iconPath = manifest.branding?.iconPath;
  const branding = { ...DEFAULT_PRODUCT_BRANDING, systemName: productName, browserTitle: productName,
    ...(iconPath ? { logoUrl: `/delivery/${iconPath}`, iconUrl: `/delivery/${iconPath}` } : {}) };
  const indexedAssets = manifest.files.filter(file => file.path.startsWith("assets/") || file.path === iconPath).map(file => ({
    originalUrl: file.sourceUrl, localUrl: `/delivery/${file.path}`, sha256: file.sha256.toUpperCase(), bytes: file.bytes,
  }));
  const deliveryManifest = {
    kind: "industrial-studio-scene-viewer", schemaVersion: 1, deliveryTarget: "windows-scene-viewer",
    packageId: manifest.contentHash.value.slice(0, 16), createdAt: manifest.generatedAt, publishedAt: manifest.publishedAt,
    rendererMode: manifest.renderer, toolbarVisible: manifest.toolbarVisible,
    sourcePublicationSha256: shaUpper(JSON.stringify(publication)), publicationSha256: shaUpper(JSON.stringify(publication)),
    projectSha256: shaUpper(JSON.stringify(rewrittenProject)), publication, project: rewrittenProject, branding, assets: indexedAssets,
  };
  const dynamicFiles: Array<{ path: string; bytes: Buffer<ArrayBufferLike>; contentType: string }> = [
    { path: "delivery/scene-viewer.json", bytes: Buffer.from(`${JSON.stringify(deliveryManifest, null, 2)}\n`),
      contentType: "application/json; charset=utf-8" },
  ];
  for (const entry of manifest.files.filter(file => file.path.startsWith("assets/") || file.path === iconPath)) {
    dynamicFiles.push({ path: `delivery/${entry.path}`, bytes: files.get(entry.path)!, contentType: contentType(entry.path) });
  }
  const records: Array<{ path: string; offset: number; bytes: number; sha256: string; contentType: string }> = [];
  let offset = 0;
  for (const file of dynamicFiles) {
    records.push({ path: file.path, offset, bytes: file.bytes.length,
      sha256: createHash("sha256").update(file.bytes).digest("hex"), contentType: file.contentType });
    offset += file.bytes.length;
  }
  const header = Buffer.from(JSON.stringify({ schema: "deep-monkey.three-scene-viewer-payload", schemaVersion: 1,
    packageId: deliveryManifest.packageId, productName, sourceContentHash: manifest.contentHash.value, files: records }), "utf8");
  if (header.length > 1024 * 1024) throw new Error("Three WebView payload header exceeds 1 MiB");
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(header.length);
  const icon = iconPath ? files.get(iconPath) : undefined;
  const iconDataUrl = icon ? `data:image/${iconPath!.endsWith(".png") ? "png" : "x-icon"};base64,${icon.toString("base64")}` : undefined;
  return { payload: Buffer.concat([prefix, header, ...dynamicFiles.map(file => file.bytes)]),
    executableBranding: parseClientPackageBranding({ applicationName: manifest.branding?.applicationName,
      ...(iconDataUrl ? { iconDataUrl } : {}) }) };
}

async function readThreeSceneArchive(input: Uint8Array, signal?: AbortSignal): Promise<{ manifest: ThreeArchiveManifest; files: Map<string, Buffer> }> {
  signal?.throwIfAborted();
  if (!input.byteLength || input.byteLength > 256 * 1024 ** 2) throw new Error("Three WebView package exceeds 256 MiB");
  // Parse the central directory first. CRC validation would inflate every entry before
  // the declared size budget can be enforced; the per-file SHA below is stronger.
  const zip = await JSZip.loadAsync(Buffer.from(input), { checkCRC32: false });
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) throw new Error("Three WebView package is missing manifest.json");
  if (zipEntryBytes(manifestEntry) > 1024 * 1024) throw new Error("Three WebView package manifest exceeds 1 MiB");
  const manifest = JSON.parse(await manifestEntry.async("string")) as ThreeArchiveManifest;
  if (manifest.kind !== "bim-studio-scene-client-package" || manifest.schemaVersion !== 1
    || manifest.purpose !== "delivery" || manifest.target !== "three-webview"
    || ![manifest.projectId, manifest.sceneId, manifest.sceneName, manifest.publishedAt, manifest.generatedAt].every(nonblank)
    || !Number.isFinite(Date.parse(manifest.publishedAt)) || !Number.isFinite(Date.parse(manifest.generatedAt))
    || !["webgl", "webgpu-preferred"].includes(manifest.renderer) || typeof manifest.toolbarVisible !== "boolean"
    || !Array.isArray(manifest.files) || manifest.contentHash?.algorithm !== "sha256" || !hash(manifest.contentHash.value)) {
    throw new Error("Three WebView package identity is invalid");
  }
  validateBranding(manifest.branding);
  const declared = new Map<string, ThreeArchiveManifest["files"][number]>();
  let total = 0;
  for (const file of manifest.files) {
    if (!file || !safeArchivePath(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 256 * 1024 ** 2
      || !hash(file.sha256) || typeof file.sourceUrl !== "string" || declared.has(file.path.toLowerCase())) {
      throw new Error("Three WebView package file index is invalid");
    }
    total += file.bytes;
    if (total > 1024 ** 3) throw new Error("Three WebView package expands beyond 1 GiB");
    declared.set(file.path.toLowerCase(), file);
  }
  for (const required of ["scene.json", "project.json", "applications.json", "runtime.json", "README.txt"]) {
    if (!declared.has(required.toLowerCase())) throw new Error(`Three WebView package is missing ${required}`);
  }
  const actual = Object.values(zip.files).filter(entry => !entry.dir && entry.name !== "manifest.json");
  if (actual.length !== manifest.files.length || actual.some(entry => !declared.has(entry.name.toLowerCase()))) {
    throw new Error("Three WebView package files do not match its manifest");
  }
  if (actual.some(entry => zipEntryBytes(entry) !== declared.get(entry.name.toLowerCase())!.bytes)) {
    throw new Error("Three WebView package expanded sizes do not match its manifest");
  }
  const files = new Map<string, Buffer>();
  for (const descriptor of manifest.files) {
    signal?.throwIfAborted();
    const bytes = Buffer.from(await zip.file(descriptor.path)!.async("nodebuffer"));
    if (bytes.length !== descriptor.bytes || createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) {
      throw new Error(`Three WebView package file hash mismatch: ${descriptor.path}`);
    }
    files.set(descriptor.path, bytes);
  }
  const { files: _files, contentHash: _contentHash, generatedAt: _generatedAt, ...metadata } = manifest;
  const expected = runtimeContentSha256({ metadata,
    files: manifest.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) });
  if (expected !== manifest.contentHash.value) throw new Error("Three WebView package content identity mismatch");
  return { manifest, files };
}

function validateBranding(value: ThreeArchiveManifest["branding"]): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Object.keys(value).some(key => !["applicationName", "iconPath"].includes(key))
    || (value.applicationName !== undefined && (!nonblank(value.applicationName) || value.applicationName !== value.applicationName.trim()
      || value.applicationName.length > 80 || /[\x00-\x1f\x7f]/.test(value.applicationName)))
    || (value.iconPath !== undefined && !["branding/icon.png", "branding/icon.ico"].includes(value.iconPath))) {
    throw new Error("Three WebView package branding is invalid");
  }
}
function zipEntryBytes(entry: JSZip.JSZipObject): number {
  const value = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  return Number.isSafeInteger(value) && value! >= 0 ? value! : Number.POSITIVE_INFINITY;
}
function safeArchivePath(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every(part => part && part !== "." && part !== "..") && !/^[A-Za-z]:/.test(value);
}
function nonblank(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function shaUpper(value: string): string { return createHash("sha256").update(value).digest("hex").toUpperCase(); }
function contentType(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return ({ ".json": "application/json; charset=utf-8", ".gltf": "model/gltf+json", ".glb": "model/gltf-binary",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm", ".wasm": "application/wasm" } as Record<string, string>)[extension]
    ?? "application/octet-stream";
}

/** Legacy source-checkout path retained for release-server compatibility. */
async function buildWorkspaceSceneViewerExecutable(builderScript: string, archive: Uint8Array, signal: AbortSignal): Promise<Buffer> {
  const cacheKey = createHash("sha256").update(archive).digest("hex");
  const cachedExecutable = path.join(cacheDirectory, `${cacheKey}.exe`);
  const run = async () => {
    try { return Buffer.from(await readDashboardWindowsExecutable(cachedExecutable, signal)); }
    catch { /* Cache miss. */ }
    const directory = await mkdtemp(path.join(tmpdir(), "three-scene-viewer-"));
    try {
      const input = path.join(directory, "scene.bimscene.zip");
      await writeFile(input, archive, { flag: "wx" });
      const packageId = `webview-${Date.now().toString(36)}-${process.pid.toString(36)}`;
      await execute(process.execPath, [builderScript, "--client-package", input, "--package-id", packageId], signal);
      const executable = path.join(repositoryRoot, "apps", "desktop", "src-tauri", "target", "release", "bim-studio-desktop.exe");
      const bytes = Buffer.from(await readDashboardWindowsExecutable(executable, signal));
      await mkdir(cacheDirectory, { recursive: true });
      const temporary = path.join(cacheDirectory, `${cacheKey}.${process.pid}.${Date.now()}.tmp`);
      await writeFile(temporary, bytes, { flag: "wx" }); await rm(cachedExecutable, { force: true }); await rename(temporary, cachedExecutable);
      return bytes;
    } finally { await rm(directory, { recursive: true, force: true }); }
  };
  return threeSceneViewerCache.exclusive(run);
}

function execute(command: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], signal });
    const errors: Buffer[] = []; let size = 0;
    child.stderr.on("data", (chunk: Buffer) => { if (size < 64 * 1024) { errors.push(chunk); size += chunk.length; } });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Three WebView build failed (${code}): ${Buffer.concat(errors).toString("utf8").slice(-2000)}`)));
  });
}
