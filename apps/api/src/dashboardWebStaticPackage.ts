import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import {
  assertDashboardWebSource,
  createDashboardDocument,
  dashboardFrozenFontStyle,
  DASHBOARD_WEB_FILE_LIMIT,
  DASHBOARD_WEB_TOTAL_LIMIT,
  validateDashboardWebPackageStructure,
  type DashboardWebPackage,
  type DashboardWebResource,
  type PublishedApplicationRecord,
} from "@bim-studio/contracts";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import {
  dashboardCanonicalJsonSha256,
  type DashboardPublicationFreezeManifest,
} from "./dashboardPublicationFreeze.js";

export interface DashboardWebStaticPackageLicensedFont {
  /** 部署配置的授权字体文件绝对路径；哈希必须与冻结字体字节一致。 */
  readonly path: string;
  /** 配套发行许可文本绝对路径；随包写入 licenses/ 后计入 runtimeFiles。 */
  readonly licensePath: string;
}

export interface DashboardWebStaticPackageOptions {
  /** 部署从应用存储读取的原始发布记录；本模块不自行发现发布。 */
  readonly publication: PublishedApplicationRecord;
  /** C3 冻结清单（来自候选记录，HTTP 不可触碰）。 */
  readonly freezeManifest: DashboardPublicationFreezeManifest;
  /** 部署注入的对象读取 port：objectKey → 字节；实现必须把读取限制在对象根内。 */
  readonly readResourceObject: (objectKey: string, signal?: AbortSignal) => Promise<Uint8Array>;
  readonly licensedFonts: readonly DashboardWebStaticPackageLicensedFont[];
  /** 预构建 dashboard-static 产物目录（index.html/assets/...）的绝对路径。 */
  readonly webStaticRoot: string;
  readonly signal?: AbortSignal;
}

type PackagedFile = { readonly path: string; readonly bytes: Uint8Array; readonly sha256: string };
type ManifestFile = { readonly path: string; readonly bytes: number; readonly sha256: string };

const FONT_LICENSE_BYTES_LIMIT = 1024 * 1024;
const WEB_STATIC_SCHEMA = "deep-monkey.dashboard-web" as const;
/** 随包分发的仓库级许可文本（开源治理义务）；webStaticRoot 已提供时以产物为准。 */
const DISTRIBUTION_NOTICES = ["LICENSE", "THIRD_PARTY_NOTICES.md"] as const;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * 把已发布 Dashboard 编译为可离线部署的 web.zip（scripts/build-dashboard-web-package.mts
 * 的进程内移植）：冻结清单复核 → 资源/字体许可闭包 → 运行时文件收集 → 清单双摘要 →
 * 确定性 ZIP。任何一步失败都整体失败（fail-closed），绝不输出部分包。
 */
export async function createDashboardWebStaticPackage(options: DashboardWebStaticPackageOptions): Promise<Uint8Array> {
  const { publication, signal } = options;
  signal?.throwIfAborted();
  const freeze = assertFrozenAuthority(publication, options.freezeManifest);
  const resources: DashboardWebResource[] = [];
  const resourceContents = new Map<string, Uint8Array>();
  const licenseFiles: PackagedFile[] = [];
  let resourceBytes = 0;
  for (const resource of freeze.resources) {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(resource.bytes) || resource.bytes < 1 || resource.bytes > DASHBOARD_WEB_FILE_LIMIT
      || (resourceBytes += resource.bytes) > DASHBOARD_WEB_TOTAL_LIMIT) throw new Error("冻结资源字节预算超限");
    assertObjectKeyConfined(resource.objectKey);
    const bytes = await options.readResourceObject(resource.objectKey, signal);
    signal?.throwIfAborted();
    if (!(bytes instanceof Uint8Array) || bytes.length !== resource.bytes || sha256(bytes) !== resource.sha256)
      throw new Error(`冻结资源与清单摘要不一致：${resource.id}`);
    const target = `resources/${resource.id.replace(/[^a-zA-Z0-9_-]/g, "_")}-${resource.sha256}`;
    let font: DashboardWebResource["font"];
    if (resource.kind === "font") {
      if (!resource.licenseEvidence) throw new Error(`冻结字体缺少许可证据：${resource.id}`);
      for (const entry of options.licensedFonts) {
        if (!path.isAbsolute(entry.path) || !path.isAbsolute(entry.licensePath)) continue;
        if ((await stat(entry.path)).size > DASHBOARD_WEB_FILE_LIMIT) continue;
        if (sha256(await readFile(entry.path)) !== resource.sha256) continue;
        signal?.throwIfAborted();
        if ((await stat(entry.licensePath)).size > FONT_LICENSE_BYTES_LIMIT) throw new Error("字体许可文件超出预算");
        const license = await readFile(entry.licensePath);
        if (!license.length) throw new Error("字体许可文件为空");
        const licensePath = `licenses/font-${resource.sha256}.txt`;
        licenseFiles.push({ path: licensePath, bytes: license, sha256: sha256(license) });
        font = { ...dashboardFrozenFontStyle(bytes), licenseEvidence: resource.licenseEvidence, licensePath };
        break;
      }
      if (!font) throw new Error(`冻结字体缺少匹配的发行许可：${resource.id}`);
    }
    resources.push({ sourceUrl: font ? `font:${resource.id}` : `/assets/${resource.objectKey}`, path: target,
      mime: resource.mime, bytes: bytes.length, sha256: resource.sha256, ...(font ? { font } : {}) });
    resourceContents.set(target, bytes);
  }
  assertDashboardWebSource(publication, freeze.entryPageId, resources);
  const publicationSha256 = runtimeContentSha256(publication);
  // 与生成器一致的两段式断言：先校验"仅许可文本"的初始清单，收齐运行时文件后终检。
  const initial = { schema: WEB_STATIC_SCHEMA, schemaVersion: 1, publication, publicationSha256,
    entryPageId: freeze.entryPageId, resources, runtimeFiles: licenseFiles.map(manifestFile) };
  assertPackageDigests({ ...initial, contentSha256: runtimeContentSha256(initial) });
  const staticFiles = await collectStaticFiles(options.webStaticRoot, signal);
  const packaged = [...licenseFiles, ...staticFiles,
    ...await distributionNotices([...licenseFiles, ...staticFiles])];
  const body = { schema: WEB_STATIC_SCHEMA, schemaVersion: 1, publication, publicationSha256,
    entryPageId: freeze.entryPageId, resources, runtimeFiles: packaged.map(manifestFile) };
  const manifest = { ...body, contentSha256: runtimeContentSha256(body) };
  assertPackageDigests(manifest);
  return zipPackage(manifest, packaged, resourceContents, signal);
}

function manifestFile(file: PackagedFile): ManifestFile {
  return { path: file.path, bytes: file.bytes.length, sha256: file.sha256 };
}

/** 冻结清单 canonical 哈希复核 + 发布身份/文档对齐；任一不符即拒绝编译。 */
function assertFrozenAuthority(publication: PublishedApplicationRecord, freeze: DashboardPublicationFreezeManifest) {
  if (freeze.schema !== "deep-engine.dashboard-publication-freeze" || freeze.schemaVersion !== 1)
    throw new Error("Web 静态包需要 Dashboard 冻结清单");
  const { manifestSha256, ...body } = freeze;
  if (dashboardCanonicalJsonSha256(body) !== manifestSha256
    || freeze.authority.publicationId !== publication.id
    || freeze.authority.applicationRevision !== publication.applicationRevision
    || freeze.documentSha256 !== dashboardCanonicalJsonSha256(createDashboardDocument(publication.document, freeze.entryPageId)))
    throw new Error("Web 静态包必须使用原始发布文档与冻结清单");
  return freeze;
}

/** 对象读取 port 收不到根路径，这里按语法挡住一切能逃出对象根的键；物理闭包由部署实现负责。 */
function assertObjectKeyConfined(objectKey: string): void {
  if (!objectKey || path.isAbsolute(objectKey) || /^[a-zA-Z]:/.test(objectKey) || objectKey.includes("\\")
    || objectKey.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error(`冻结资源对象键越界：${objectKey}`);
}

function assertPackageDigests(value: unknown): asserts value is DashboardWebPackage {
  validateDashboardWebPackageStructure(value);
  const item = value as DashboardWebPackage;
  if (runtimeContentSha256(item.publication) !== item.publicationSha256) throw new Error("静态包清单摘要不匹配");
  const { contentSha256, ...body } = item;
  if (runtimeContentSha256(body) !== contentSha256) throw new Error("静态包清单摘要不匹配");
}

async function collectStaticFiles(root: string, signal?: AbortSignal): Promise<PackagedFile[]> {
  const directory = path.resolve(root);
  const files: PackagedFile[] = [];
  const walk = async (relative: string): Promise<void> => {
    signal?.throwIfAborted();
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      // dashboard.web.json 与 licenses/ 由本模块生成；符号链接一律不进入包。
      if (entry.isDirectory()) { if (!(relative === "" && name === "licenses")) await walk(name); }
      else if (entry.isFile()) {
        if (name === "dashboard.web.json") continue;
        const bytes = await readFile(path.join(directory, name));
        files.push({ path: name, bytes, sha256: sha256(bytes) });
      }
    }
  };
  await walk("");
  return files;
}

/** webStaticRoot 缺许可文本时从仓库根注入；缺失即失败，保证每次分发都带许可。 */
async function distributionNotices(existing: readonly { readonly path: string }[]): Promise<PackagedFile[]> {
  const injected: PackagedFile[] = [];
  for (const name of DISTRIBUTION_NOTICES) {
    if (existing.some(file => file.path === name)) continue;
    const bytes = await readFile(new URL(`../../../${name}`, import.meta.url));
    injected.push({ path: name, bytes, sha256: sha256(bytes) });
  }
  return injected;
}

function zipPackage(manifest: DashboardWebPackage, runtimeFiles: readonly PackagedFile[],
  resources: ReadonlyMap<string, Uint8Array>, signal?: AbortSignal): Promise<Uint8Array> {
  const zip = new JSZip();
  // 固定 ZIP 时间与顺序，避免相同输入产生不同传输字节（对齐 dashboardPortableZip）。
  const date = new Date("2000-01-01T00:00:00Z");
  for (const file of runtimeFiles) zip.file(file.path, file.bytes, { date, createFolders: false });
  for (const [name, bytes] of resources) zip.file(name, bytes, { date, createFolders: false });
  zip.file("dashboard.web.json", JSON.stringify(manifest), { date, createFolders: false });
  signal?.throwIfAborted();
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 },
    platform: "DOS" }, () => signal?.throwIfAborted());
}
