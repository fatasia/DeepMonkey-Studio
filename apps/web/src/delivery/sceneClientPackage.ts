import { type PublishedSceneRecord, type SceneClientDependencyInputs, type SceneClientDependencyExpectation, type SceneSnapshot } from "@bim-studio/contracts";
import { api } from "../api";
import { downloadBlob } from "../browserDownload";
import { loadViewerAssetBuffer } from "../viewer/viewerAssetTransport";
import { sanitizeTransferContent, sanitizeTransferUrl } from "./projectTransferModel";
import { assertScenePublicationDeliverable } from "./scenePublicationCompatibilityGate";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { sceneCompilationSource } from "./sceneCompilationSource";
import { indexSceneClientArchiveFiles, validateSceneClientArchivePaths, type SceneClientArchiveFile } from "./sceneClientPackageIndex";
import { selectSceneClientDependencyInputs } from "@bim-studio/studio-core";
import { verifySceneClientResource } from "./sceneClientResources";
import { loadFrozenSceneClientDependencies, frozenSceneResourceUrl } from "./sceneClientFrozenDependencies";

declare const preparedPackageIdentity: unique symbol;
/** 仅当前页面内有效的一次性交付句柄，不进入历史记录或持久化。 */
export interface PreparedSceneClientPackage { readonly [preparedPackageIdentity]: true }

const preparedPackages = new WeakMap<PreparedSceneClientPackage, {
  identity: string;
  expectation: SceneClientDependencyExpectation;
  deliver(options: SceneClientPackageOptions): Promise<SceneClientPackageResult>;
}>();

export type SceneClientPackageTarget = "none" | "three-webview" | "deep-native";

export interface SceneClientPackageOptions {
  projectId: string;
  scene: SceneSnapshot;
  target: Exclude<SceneClientPackageTarget, "none">;
  renderer: "webgl" | "webgpu-preferred";
  toolbarVisible: boolean;
  signal?: AbortSignal;
  progress?: (message: string) => void;
  prepared?: PreparedSceneClientPackage;
  publication?: PublishedSceneRecord;
  branding?: import("../components/clientPackageBranding").ClientPackageBranding;
  /** 桌面构建器消费同一份已校验 ZIP；缺省仍按历史行为直接下载。 */
  archiveConsumer?: (archive: Blob, fileName: string, counts: Omit<SceneClientPackageResult, "fileName" | "target">) => Promise<SceneClientPackageResult>;
}

export interface SceneClientPackageResult {
  fileName: string;
  target: Exclude<SceneClientPackageTarget, "none">;
  assetCount: number;
  applicationCount: number;
  connectionCount: number;
}

/**
 * 生成可审计的场景交付包。包内同时保留场景、二维应用、资源和脱敏后的数据运行时，
 * 可由 WebView 客户端或 Deep Native 入口继续构建；凭据永不进入包。
 */
export async function exportSceneClientPackage(options: SceneClientPackageOptions): Promise<SceneClientPackageResult> {
  const frozen = freezePackageOptions(options);
  const prepared = frozen.prepared ?? await prepareSceneClientPackage(frozen);
  const entry = preparedPackages.get(prepared);
  if (!entry) throw new Error("预检结果不存在或已使用，请重新检查后打包。");
  preparedPackages.delete(prepared);
  if (entry.identity !== packageIdentity(frozen)) throw new Error("场景或交付选项已变化，请重新检查后打包。");
  if (frozen.publication) {
    if (transportHash(frozen.publication.snapshot) !== transportHash(frozen.scene)) throw new Error("交付场景与发布版本不一致");
    const record = await loadFrozenSceneClientDependencies(frozen.publication, frozen.signal ?? new AbortController().signal);
    const expected = { inputs: record.inputs, resources: record.resources.map(({ sourceUrl, bytes, sha256 }) => ({ sourceUrl, bytes, sha256 })) };
    if (transportHash(entry.expectation) !== transportHash(expected)) throw new Error("预检依赖与发布冻结版本不一致，请重试原版本打包");
  }
  return entry.deliver(frozen);
}

export function getPreparedSceneClientDependencies(handle: PreparedSceneClientPackage): SceneClientDependencyExpectation {
  const entry = preparedPackages.get(handle);
  if (!entry) throw new Error("预检结果已失效，请重新检查");
  return structuredClone(entry.expectation);
}

/** 保存后调用；只读取和编译，兼容检查通过后才返回句柄，不生成 ZIP 或下载。 */
export async function prepareSceneClientPackage(options: SceneClientPackageOptions): Promise<PreparedSceneClientPackage> {
  if (options.prepared) throw new Error("不能用已有预检结果创建新的预检任务。");
  const frozen = freezePackageOptions(options);
  const identity = packageIdentity(frozen);
  const { deliver, expectation } = await preparePackageDelivery(frozen, "delivery");
  const handle = Object.freeze({}) as PreparedSceneClientPackage;
  preparedPackages.set(handle, { identity, deliver, expectation });
  return handle;
}

/** 研发诊断入口；不能作为正式打包执行器的成功结果。 */
export async function exportSceneClientDiagnosticPackage(options: SceneClientPackageOptions & { target: "deep-native" }) {
  if (options.target !== "deep-native") throw new Error("诊断包仅用于 Deep Native 编译检查。");
  if (options.prepared) throw new Error("诊断包不能消费正式预检结果。");
  const frozen = freezePackageOptions(options);
  const { deliver } = await preparePackageDelivery(frozen, "diagnostic");
  const result = await deliver(frozen);
  const { fileName, ...counts } = result;
  return { ...counts, diagnosticFileName: fileName, kind: "scene-client-diagnostic" as const };
}

function freezePackageOptions(options: SceneClientPackageOptions): SceneClientPackageOptions {
  return { ...options, scene: structuredClone(options.scene),
    ...(options.publication ? { publication: structuredClone(options.publication) } : {}) };
}

async function preparePackageDelivery(options: SceneClientPackageOptions, purpose: "delivery" | "diagnostic") {
  options = freezePackageOptions(options);
  if (options.target === "three-webview" && options.scene.postProcessing?.enabled
    && options.scene.postProcessing.screenSpaceReflection) {
    throw new Error("Three WebView 尚未实现 SSR 深度/法线/HDR 合成消费；请关闭 SSR 或使用 Studio Deep WebGPU。");
  }
  if (options.target === "three-webview" && options.scene.lighting?.lights?.some(light => light.enabled
    && light.type === "spot" && light.castShadow && (light.shadowSoftness ?? 0) > 0)) {
    throw new Error("Three WebView 尚未实现作者 PCSS 阴影柔化；请将阴影柔化设为 0 或使用 Studio Deep WebGPU。");
  }
  const signal = options.signal ?? new AbortController().signal;
  const progress = options.progress ?? (() => undefined);
  signal.throwIfAborted();
  progress("正在读取发布资源");
  signal.throwIfAborted();
  if (options.publication && transportHash(options.publication.snapshot) !== transportHash(options.scene)) throw new Error("交付场景与发布版本不一致");
  const frozen = options.publication ? await loadFrozenSceneClientDependencies(options.publication, signal) : undefined;
  let inputs: SceneClientDependencyInputs;
  if (frozen) inputs = frozen.inputs;
  else {
    const [project, applications] = await Promise.all([
      api.getProject(options.projectId).then(value => structuredClone(value)),
      api.listApplications(options.projectId).then(value => structuredClone(value)),
    ]);
    inputs = selectSceneClientDependencyInputs(project, options.scene, applications, { diagnostic: purpose === "diagnostic" });
  }
  signal.throwIfAborted();
  const { project, applications, runtime: runtimeDependencies, resources } = inputs;
  const { models, assets } = project;
  if (project.id !== options.projectId || options.scene.projectId !== options.projectId) throw new Error("项目与待打包场景不一致，请重新打开后检查。");
  const expectation: SceneClientDependencyExpectation = { inputs: structuredClone(inputs), resources: [] };
  validateSceneClientArchivePaths(resources.map(resource => `assets/${resource.id}-${safeName(resource.name)}`));
  const replacements = new Map<string, string>();
  const sourceBuffers = new Map<string, ArrayBuffer>();
  const files: Array<{ path: string; content: ArrayBuffer; bytes: number; sourceUrl: string }> = [];
  for (const resource of resources) {
    signal.throwIfAborted();
    progress(`正在打包 ${resource.name}`);
    signal.throwIfAborted();
    const captured = frozen?.resources.find(item => item.sourceUrl === resource.url);
    if (frozen && !captured) throw new Error(`冻结资源 ${resource.name} 缺失，不能使用当前资源替代`);
    const content = captured && frozen
      ? await api.loadScenePublicationResource(frozenSceneResourceUrl(frozen, captured.sha256), captured.bytes, signal)
      : (await loadViewerAssetBuffer(resource.url, resource.name, { signal, timeoutMs: 120_000 })).slice(0);
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", content))].map(value => value.toString(16).padStart(2, "0")).join("");
    if (captured && (captured.bytes !== content.byteLength || captured.sha256 !== sha256)) throw new Error(`冻结资源 ${resource.name} 校验失败`);
    expectation.resources.push({ sourceUrl: resource.url, bytes: content.byteLength, sha256 });
    await verifySceneClientResource(resource, content, signal);
    signal.throwIfAborted();
    const safe = safeName(resource.name);
    sourceBuffers.set(resource.url, content);
    const path = `assets/${resource.id}-${safe}`;
    replacements.set(resource.url, path);
    files.push({ path, content, bytes: content.byteLength, sourceUrl: sanitizeTransferUrl(resource.url) });
  }
  const rewrite = <T,>(value: T): T => {
    const visit = (item: unknown, original: unknown): unknown => {
      if (typeof item === "string") return typeof original === "string" ? replacements.get(original) ?? item : item;
      if (Array.isArray(item)) return item.map((child, index) => visit(child, Array.isArray(original) ? original[index] : undefined));
      if (!item || typeof item !== "object") return item;
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, child]) =>
        [key, visit(child, original && typeof original === "object" ? (original as Record<string, unknown>)[key] : undefined)]));
    };
    return visit(sanitizeTransferContent(value), value) as T;
  };
  const runtime = {
    connections: runtimeDependencies.connections.map(connection => rewrite(connection)),
    datasets: rewrite(runtimeDependencies.datasets),
    pipelines: rewrite(runtimeDependencies.pipelines),
    policy: "credentials-external",
    reconfigureConnectionIds: runtimeDependencies.connections.filter(connection => connection.type !== "simulation").map(connection => connection.id),
  };
  signal.throwIfAborted();
  const native = options.target === "deep-native"
    ? frozen?.nativeCompiled
      ? await (await import("./sceneNativeFrozenPayload")).prepareFrozenNativeScenePayload(options.scene, frozen, signal)
      : await (await import("./nativeSceneClientPayload")).prepareNativeSceneClientPayload(options.scene, async (assetId, loadSignal) => {
      loadSignal.throwIfAborted();
      const model = project.models.find(item => item.id === assetId);
      const bytes = model?.manifest?.geometryUrl ? sourceBuffers.get(model.manifest.geometryUrl) : undefined;
      if (!bytes) throw new Error(`Native 编译缺少模型资源：${assetId}`);
      return new Uint8Array(bytes);
    }, signal) : undefined;
  signal.throwIfAborted();
  if (native && purpose === "delivery") assertScenePublicationDeliverable(native.report, { allowNativeDegraded: true });
  validateSceneClientArchivePaths([...files.map(file => file.path), ...(native?.files.map(file => file.path) ?? []),
    "scene.json", "applications.json", "project.json", "runtime.json", "README.txt"]);
  const preparationSignal = signal;
  const deliver = async (delivery: SceneClientPackageOptions): Promise<SceneClientPackageResult> => {
    const signal = delivery.signal ? AbortSignal.any([preparationSignal, delivery.signal]) : preparationSignal;
    const progress = delivery.progress ?? options.progress ?? (() => undefined);
    signal.throwIfAborted();
    if (native && purpose === "delivery") assertScenePublicationDeliverable(native.report, { allowNativeDegraded: true });
    const payloads: SceneClientArchiveFile[] = [
      ...files, ...(native?.files ?? []),
      { path: "scene.json", content: JSON.stringify(rewrite(delivery.scene), null, 2) },
      { path: "applications.json", content: JSON.stringify(rewrite(applications), null, 2) },
      { path: "project.json", content: JSON.stringify(rewrite({ id: project.id, name: project.name, description: project.description, models, assets }), null, 2) },
      { path: "runtime.json", content: JSON.stringify(runtime, null, 2) },
      { path: "README.txt", content: readme(options.target, options.renderer, runtime.reconfigureConnectionIds.length)
        + (purpose === "diagnostic" ? "\n用途：编译诊断，不是已通过发布检查的客户端交付物。" : "")
        + (native ? `\nNative 发布状态：${native.manifest.status}。运行包已生成；未验证或未编译能力见 ${native.manifest.reportPath}。` : "") },
    ];
    const fileEntries = await indexSceneClientArchiveFiles(payloads, signal);
    const metadata = {
      kind: "bim-studio-scene-client-package",
      schemaVersion: 1,
      purpose,
      target: options.target,
      renderer: options.renderer,
      toolbarVisible: options.toolbarVisible,
      projectId: options.projectId,
      sceneId: options.scene.id,
      sceneName: options.scene.name,
      publishedAt: delivery.scene.publishedAt ?? null,
      nativeRuntime: native?.manifest,
      capabilities: native ? { status: native.manifest.status, reportPath: native.manifest.reportPath }
        : { twoD: true, threeD: true, dataBindings: true, liveConnections: runtime.reconfigureConnectionIds.length === 0 },
    };
    // ZIP 时间与构建时间不参与内容身份；每个实际负载文件均按 UTF-8/原始字节校验。
    const contentHash = runtimeContentSha256({ metadata: JSON.parse(JSON.stringify(metadata)),
      files: fileEntries.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) });
    const generatedAt = stableArchiveTimestamp(delivery);
    const manifest = { ...metadata, generatedAt: generatedAt.toISOString(), files: fileEntries,
      contentHash: { algorithm: "sha256", value: contentHash } };
    const { default: JSZip } = await import("jszip");
    signal.throwIfAborted();
    const zip = new JSZip();
    for (const file of payloads) zip.file(file.path, file.content, { date: generatedAt, createFolders: false });
    zip.file("manifest.json", JSON.stringify(manifest, null, 2), { date: generatedAt, createFolders: false });
    progress("正在生成客户端包");
    signal.throwIfAborted();
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    signal.throwIfAborted();
    const fileName = `${safeName(options.scene.name)}.${options.target}${purpose === "diagnostic" ? ".diagnostic" : ""}.bimscene.zip`;
    const counts = { assetCount: files.length, applicationCount: applications.length, connectionCount: runtime.connections.length };
    if (delivery.archiveConsumer) return delivery.archiveConsumer(blob, fileName, counts);
    downloadBlob(blob, fileName);
    progress(`${purpose === "diagnostic" ? "诊断包" : "客户端包"}已下载：${fileName}`);
    return { fileName, target: options.target, ...counts };
  };
  return { deliver, expectation };
}

function stableArchiveTimestamp(options: SceneClientPackageOptions): Date {
  const timestamp = [options.publication?.publishedAt, options.scene.publishedAt,
    options.scene.updatedAt, options.scene.createdAt].map(value => value ? Date.parse(value) : NaN)
    .find(Number.isFinite) ?? NaN;
  // ZIP DOS timestamps start at 1980 and have two-second precision. Normalizing here keeps
  // identical published inputs byte-identical so the desktop builder cache can be reused.
  const value = Number.isFinite(timestamp) ? Math.max(timestamp, Date.UTC(1980, 0, 1)) : Date.UTC(1980, 0, 1);
  return new Date(Math.floor(value / 2_000) * 2_000);
}

function packageIdentity(options: SceneClientPackageOptions): string {
  // Three 保留既有 JSON 序列化规则；Native 与编译器使用同一严格源投影。
  const source = options.target === "deep-native" ? sceneCompilationSource(options.scene) : JSON.parse(JSON.stringify(options.scene)) as Record<string, unknown>;
  delete source.updatedAt; delete source.publishedAt;
  return runtimeContentSha256({ projectId: options.projectId, target: options.target, renderer: options.renderer,
    toolbarVisible: options.toolbarVisible, source });
}

function transportHash(value: unknown): string { return runtimeContentSha256(JSON.parse(JSON.stringify(value))); }

function safeName(value: string): string { return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 96) || "scene"; }
function readme(target: Exclude<SceneClientPackageTarget, "none">, renderer: SceneClientPackageOptions["renderer"], reconfigureCount: number): string {
  const entry = target === "three-webview" ? "apps/desktop bundle:scene-viewer" : "packages/deep-engine-native 的原生 wgpu 启动器";
  return [`DeepMonkey Studio 场景客户端包`, `交付目标：${target}`, `渲染策略：${renderer}`, `入口：${entry}`,
    target === "deep-native"
      ? '解压后可在包目录校验运行包：deep-engine-native.exe --headless-package "native/runtime-package.json"。窗口加载使用 --package；实际支持范围见能力报告。'
      : "二维、三维和场景绑定已写入包内。",
    reconfigureCount ? `数据连接：${reconfigureCount} 个连接需在客户端运行环境重新配置凭据。` : "数据连接：无外部凭据依赖。",
    "manifest.json 是机器可读清单；资源文件按 SHA/大小由上层构建器校验。"].join("\n");
}
