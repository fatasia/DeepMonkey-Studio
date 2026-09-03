import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const LOOSE_FORMATS = new Set([".gltf", ".usd", ".usda"]);
const API_TIMEOUT_MS = 30_000;
const RESOURCE_TIMEOUT_MS = 15 * 60_000;
const PACKAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EDITOR_MODULE_MARKERS = [
  "App.tsx",
  "editorStyles.ts",
  "SceneManager",
  "OperationsCenter",
  "ParametricModelWorkbench",
  "TopologyEditor",
];

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

/**
 * 只读包的临时 Web 产物必须与普通 Web dist 隔离；同时先约束 packageId，
 * 避免后续递归清理把路径带出 `.scene-viewer-build`。
 */
export function resolveSceneViewerBuildPaths(desktopDirectory, packageId, requestedWebDist, workingDirectory = process.cwd()) {
  if (!PACKAGE_ID_PATTERN.test(packageId)) {
    throw new Error("--package-id 只能包含字母、数字、点、下划线或短横线，且不能超过 64 个字符");
  }
  const buildRoot = path.join(path.resolve(desktopDirectory), ".scene-viewer-build", packageId);
  const generatedWebDist = path.join(buildRoot, "web-dist");
  const webDist = requestedWebDist ? path.resolve(workingDirectory, requestedWebDist) : generatedWebDist;
  if (requestedWebDist && (webDist === buildRoot || webDist.startsWith(`${buildRoot}${path.sep}`))) {
    throw new Error("--web-dist 不能位于当前只读包的清理目录中");
  }
  return {
    buildRoot,
    frontendDirectory: path.join(buildRoot, "frontend"),
    generatedWebDist,
    webDist,
  };
}

export function sceneViewerWebBuildEnvironment(outputDirectory) {
  return {
    VITE_SCENE_VIEWER_BUILD: "true",
    VITE_SCENE_VIEWER_OUT_DIR: path.resolve(outputDirectory),
  };
}

/** 阻止调用方把普通编辑器 dist 当作只读客户端打包。 */
export function assertSceneViewerViteManifest(viteManifest) {
  const sourceEntries = Object.keys(viteManifest);
  const editorEntry = sourceEntries.find((entry) => EDITOR_MODULE_MARKERS.some((name) => entry.includes(name)));
  if (editorEntry) throw new Error(`只读包意外包含编辑器入口：${editorEntry}`);
  if (!sourceEntries.some((entry) => entry.includes("SceneViewerRoot"))) {
    throw new Error("只读包缺少专用 SceneViewerRoot 入口");
  }
}

/**
 * A read-only package knows its complete scene up front. Remove optional
 * runtimes that cannot be reached by that frozen publication instead of
 * shipping the editor's entire import surface with every client.
 */
export async function pruneSceneViewerFrontend(frontendDirectory, deliveryManifest, viteManifest) {
  const root = path.resolve(frontendDirectory);
  const snapshot = deliveryManifest.publication.snapshot;
  const viewerKinds = new Set(deliveryManifest.project.models.map((model) => model.manifest?.viewerKind).filter(Boolean));
  const needsFragments = viewerKinds.has("ifc") || viewerKinds.has("fragments");
  const needsPhysics = Boolean(snapshot.physics?.enabled)
    || [...(snapshot.models ?? []), ...(snapshot.primitives ?? [])].some((item) => item.physics?.enabled);
  const removedRuntimeEntries = [];
  const optionalRuntime = [
    { needed: needsFragments, matches: (key) => key.includes("@thatopen/fragments") },
    { needed: needsPhysics, matches: (key) => key.includes("@dimforge+rapier3d-compat") },
  ];
  for (const [key, entry] of Object.entries(viteManifest)) {
    if (!optionalRuntime.some((group) => !group.needed && group.matches(key))) continue;
    if (entry?.file) await rm(safeFrontendPath(root, entry.file), { force: true });
    delete viteManifest[key];
    removedRuntimeEntries.push(key);
  }
  for (const entry of Object.values(viteManifest)) {
    if (!Array.isArray(entry?.dynamicImports)) continue;
    entry.dynamicImports = entry.dynamicImports.filter((key) => !removedRuntimeEntries.includes(key));
  }

  const removedPublicRoots = [];
  if (!needsFragments) await removePublicRoot(root, "wasm", removedPublicRoots);
  if (!viewerKinds.has("gltf")) await removePublicRoot(root, "draco", removedPublicRoots);
  for (const name of ["downloads", "showcase"]) {
    if (!containsUrlPrefix(deliveryManifest, `/${name}/`)) await removePublicRoot(root, name, removedPublicRoots);
  }
  const keptBrandFiles = await pruneBrandDirectory(root, deliveryManifest.branding);
  return { removedRuntimeEntries, removedPublicRoots, keptBrandFiles };
}

export function validateSource(publication, project, expected) {
  if (!publication?.snapshot || !publication.sceneId || !publication.publishedAt) throw new Error("发布版本文件结构无效");
  if (!project?.id || !Array.isArray(project.models)) throw new Error("项目资源文件结构无效");
  if (publication.projectId !== project.id || publication.snapshot.projectId !== project.id) throw new Error("发布版本与项目不匹配");
  if (publication.snapshot.id !== publication.sceneId) throw new Error("发布版本的场景 ID 不匹配");
  if (expected.sceneId && publication.sceneId !== expected.sceneId) throw new Error(`未找到指定场景版本：${expected.sceneId}`);
  if (expected.projectId && publication.projectId !== expected.projectId) throw new Error(`未找到指定项目版本：${expected.projectId}`);
  if (expected.publishedAt && publication.publishedAt !== expected.publishedAt) throw new Error(`未找到指定发布时间：${expected.publishedAt}`);
}

export async function fetchPublishedSource(options) {
  if (options.publicationFile && options.projectFile) {
    const [publication, project] = await Promise.all([
      readJson(options.publicationFile),
      readJson(options.projectFile),
    ]);
    validateSource(publication, project, options);
    return { publication, project, branding: options.brandingFile ? await readJson(options.brandingFile) : undefined };
  }
  if (!options.apiOrigin || !options.projectId || !options.sceneId || !options.publishedAt) {
    throw new Error("API 模式必须提供 --api-origin、--project-id、--scene-id 和 --published-at");
  }
  const headers = options.token ? { authorization: `Bearer ${options.token}` } : {};
  const base = new URL(options.apiOrigin);
  const publicationUrl = new URL(`/api/projects/${encodeURIComponent(options.projectId)}/scenes/${encodeURIComponent(options.sceneId)}/publications`, base);
  const publications = await getJson(publicationUrl, headers);
  const publication = publications.find((item) => item.publishedAt === options.publishedAt);
  if (!publication) throw new Error(`指定发布版本不存在：${options.publishedAt}`);
  const project = await getJson(new URL(`/api/projects/${encodeURIComponent(options.projectId)}`, base), headers);
  const branding = await getJson(new URL("/api/public/branding", base), {}).catch(() => undefined);
  validateSource(publication, project, options);
  return { publication, project, branding };
}

export async function createSceneViewerPayload(source, options) {
  const publicationHash = sha256(JSON.stringify(source.publication));
  const publication = structuredClone(source.publication);
  const project = publicProjectSubset(source.project, publication);
  const branding = structuredClone(source.branding ?? defaultBranding());
  const resourceUrls = collectResourceUrls(publication, project, branding, Boolean(source.branding));
  const downloaded = await downloadResources(resourceUrls, options);
  const replacements = new Map(downloaded.map((item) => [item.originalUrl, item.localUrl]));
  const rewrittenPublication = rewriteUrls(publication, replacements);
  const rewrittenProject = rewriteUrls(project, replacements);
  const rewrittenBranding = rewriteUrls(branding, replacements);
  for (const model of rewrittenProject.models) {
    if (model.manifest?.geometryUrl) model.sourceUrl = model.manifest.geometryUrl;
    delete model.manifestUrl;
  }
  const rendererMode = resolveRendererMode(options.renderer, publication.snapshot.publicationMode);
  const toolbarVisible = resolveToolbar(options.toolbar, publication.snapshot.publicationToolbarVisible);
  const manifest = {
    kind: "industrial-studio-scene-viewer",
    schemaVersion: 1,
    deliveryTarget: "windows-scene-viewer",
    packageId: options.packageId,
    createdAt: new Date().toISOString(),
    publishedAt: publication.publishedAt,
    rendererMode,
    toolbarVisible,
    sourcePublicationSha256: publicationHash,
    publicationSha256: sha256(JSON.stringify(rewrittenPublication)),
    projectSha256: sha256(JSON.stringify(rewrittenProject)),
    publication: rewrittenPublication,
    project: rewrittenProject,
    branding: rewrittenBranding,
    assets: downloaded.map(({ content: _content, ...entry }) => entry),
  };
  return { manifest, downloaded };
}

export async function writeSceneViewerPayload(payload, frontendDirectory) {
  const deliveryDirectory = path.join(frontendDirectory, "delivery");
  const assetsDirectory = path.join(deliveryDirectory, "assets");
  await mkdir(assetsDirectory, { recursive: true });
  for (const asset of payload.downloaded) {
    await writeFile(path.join(frontendDirectory, asset.localUrl.replace(/^\//, "")), asset.content);
  }
  await writeFile(path.join(deliveryDirectory, "scene-viewer.json"), `${JSON.stringify(payload.manifest, null, 2)}\n`, "utf8");
}

export function injectDeliveryMarker(html) {
  const marker = '<meta name="scene-viewer-delivery" content="/delivery/scene-viewer.json">';
  if (!html.includes("</head>")) throw new Error("前端 index.html 缺少 </head>");
  return html.replace("</head>", `  ${marker}\n</head>`);
}

export function createTauriOverlay(options) {
  return {
    productName: options.productName,
    version: options.version,
    identifier: options.identifier,
    build: { beforeBuildCommand: "", frontendDist: options.frontendDist },
    app: {
      security: {
        csp: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ipc:; worker-src 'self' blob:",
        capabilities: ["scene-viewer"],
      },
      windows: [{ label: "main", title: options.productName, width: 1440, height: 900, minWidth: 900, minHeight: 600, center: true, resizable: true }],
    },
    bundle: { windows: { nsis: { installMode: "perMachine", displayLanguageSelector: true, startMenuFolder: options.productName }, wix: { language: "zh-CN" } } },
  };
}

function publicProjectSubset(project, publication) {
  const ids = new Set(publication.snapshot.models.map((model) => model.modelId));
  const serialized = JSON.stringify(publication.snapshot);
  const models = project.models.filter((model) => ids.has(model.id)).map((model) => structuredClone(model));
  const missing = [...ids].filter((id) => !models.some((model) => model.id === id));
  if (missing.length) throw new Error(`发布快照缺少模型资源：${missing.join("、")}`);
  for (const model of models) {
    if (model.status !== "ready" || !model.manifest?.geometryUrl || !model.manifest.viewerKind) throw new Error(`模型“${model.name}”没有可打包的浏览资源`);
    const extension = path.extname(new URL(model.manifest.geometryUrl, "https://asset.invalid").pathname).toLowerCase();
    if (LOOSE_FORMATS.has(extension)) throw new Error(`模型“${model.name}”使用 ${extension} 零散资源，请先转换为 GLB、USDZ 或自包含格式`);
  }
  const assets = project.assets?.filter((asset) => serialized.includes(asset.url)).map((asset) => structuredClone(asset));
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? "",
    models,
    ...(assets?.length ? { assets } : {}),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function collectResourceUrls(publication, project, branding, includeBranding) {
  const urls = new Set();
  const add = (value) => typeof value === "string" && !value.startsWith("data:") && !value.startsWith("blob:") && urls.add(value);
  for (const model of project.models) {
    add(model.manifest.geometryUrl);
    add(model.manifest.hierarchyUrl);
    add(model.manifest.propertiesUrl);
    add(model.manifest.pmiUrl);
    for (const lod of model.manifest.lods ?? []) add(lod.url);
  }
  for (const asset of project.assets ?? []) add(asset.url);
  for (const value of assetLikeStrings(publication.snapshot)) add(value);
  if (includeBranding) {
    add(branding.logoUrl);
    add(branding.iconUrl);
  }
  return [...urls];
}

function assetLikeStrings(value, key = "") {
  if (typeof value === "string") return /(?:url|src|image|audio|video|texture|environment)/i.test(key) && looksLikeResource(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => assetLikeStrings(item, key));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([childKey, child]) => assetLikeStrings(child, childKey));
}

function looksLikeResource(value) {
  return /^(?:https?:\/\/|\/)/i.test(value) && !value.startsWith("//");
}

async function downloadResources(urls, options) {
  const result = [];
  for (const originalUrl of urls) {
    const resolved = new URL(originalUrl, options.apiOrigin ?? "http://127.0.0.1");
    if (!['http:', 'https:'].includes(resolved.protocol)) throw new Error(`资源协议不受支持：${originalUrl}`);
    const sameOrigin = options.apiOrigin && resolved.origin === new URL(options.apiOrigin).origin;
    const response = await fetchWithDeadline(resolved, {
      headers: sameOrigin && options.token ? { authorization: `Bearer ${options.token}` } : {},
      redirect: "follow",
    }, options.resourceTimeoutMs ?? RESOURCE_TIMEOUT_MS, `下载资源超时：${originalUrl}`);
    if (!response.ok) throw new Error(`下载资源失败 ${response.status}：${originalUrl}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = sha256(bytes);
    const name = safeName(path.basename(resolved.pathname) || "asset.bin");
    const localUrl = `/delivery/assets/${digest.slice(0, 16).toLowerCase()}-${name}`;
    result.push({ originalUrl, localUrl, sha256: digest, bytes: bytes.length, content: bytes });
  }
  return deduplicateDownloads(result);
}

function deduplicateDownloads(items) {
  const seen = new Map();
  return items.filter((item) => {
    const key = `${item.originalUrl}:${item.sha256}`;
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });
}

function rewriteUrls(value, replacements) {
  if (typeof value === "string") return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => rewriteUrls(item, replacements));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewriteUrls(child, replacements)]));
}

function resolveRendererMode(requested, published) {
  if (requested === "webgl" || requested === "webgpu-preferred") return requested;
  return published === "webgpu-preferred" || published === "cloud" ? "webgpu-preferred" : "webgl";
}

function resolveToolbar(requested, published) {
  if (requested === "show") return true;
  if (requested === "hide") return false;
  return published !== false;
}

function safeName(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "asset.bin";
}

async function readJson(file) {
  return JSON.parse(await readFile(path.resolve(file), "utf8"));
}

async function getJson(url, headers) {
  const response = await fetchWithDeadline(url, { headers }, API_TIMEOUT_MS, `请求超时：${url}`);
  if (!response.ok) throw new Error(`请求失败 ${response.status}：${url}`);
  return response.json();
}

async function fetchWithDeadline(url, init, timeoutMs, timeoutMessage) {
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : API_TIMEOUT_MS;
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(duration) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(timeoutMessage, { cause: error });
    }
    throw error;
  }
}

function defaultBranding() {
  return { systemName: "Industrial Studio", browserTitle: "Industrial Studio", loginSubtitle: "数字孪生场景平台", copyright: "", logoUrl: "/brand/logo-industrial.svg", iconUrl: "/brand/app-icon-industrial.svg", primaryColor: "#d6aa4d", defaultLocale: "zh-CN", defaultEntry: "manager", defaultSceneBackground: "#202a31", defaultGridVisible: true, maintenanceEnabled: false, maintenanceMessage: "" };
}

async function removePublicRoot(root, name, removed) {
  await rm(safeFrontendPath(root, name), { recursive: true, force: true });
  removed.push(name);
}

async function pruneBrandDirectory(root, branding) {
  const paths = new Set(["/brand/app-icon-industrial.svg"]);
  for (const value of [branding?.logoUrl, branding?.iconUrl]) {
    if (typeof value === "string" && value.startsWith("/brand/")) paths.add(value);
  }
  const saved = [];
  for (const resourcePath of paths) {
    const relativePath = resourcePath.replace(/^\//, "");
    saved.push({ relativePath, content: await readFile(safeFrontendPath(root, relativePath)) });
  }
  await rm(safeFrontendPath(root, "brand"), { recursive: true, force: true });
  for (const item of saved) {
    const target = safeFrontendPath(root, item.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, item.content);
  }
  return saved.map((item) => `/${item.relativePath.replaceAll(path.sep, "/")}`);
}

function containsUrlPrefix(value, prefix) {
  if (typeof value === "string") return value.startsWith(prefix);
  if (Array.isArray(value)) return value.some((item) => containsUrlPrefix(item, prefix));
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((item) => containsUrlPrefix(item, prefix));
}

function safeFrontendPath(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`只读包路径越界：${relativePath}`);
  return resolved;
}
