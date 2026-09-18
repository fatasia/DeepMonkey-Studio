import { assertApplicationDocument, type PublishedApplicationRecord } from "./application.js";

/**
 * Dashboard Web 静态包合同：离线部署目录中的 dashboard.web.json 形状与结构规则。
 * 本模块只依赖 contracts 自身；runtimeContentSha256 摘要断言留在消费端
 * （web 交付层 / api 生成器），因为它们依赖 deep-engine 的运行时哈希。
 */
export interface DashboardWebResource {
  readonly sourceUrl: string;
  readonly path: string;
  readonly mime: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly font?: { readonly weight: number; readonly style: "normal" | "italic"; readonly licenseEvidence: string; readonly licensePath: string };
}
export interface DashboardWebPackage {
  readonly schema: "deep-monkey.dashboard-web";
  readonly schemaVersion: 1;
  readonly publication: PublishedApplicationRecord;
  readonly publicationSha256: string;
  readonly entryPageId: string;
  readonly resources: readonly DashboardWebResource[];
  readonly runtimeFiles: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
  readonly contentSha256: string;
}
export const DASHBOARD_WEB_FILE_LIMIT = 64 * 1024 * 1024;
export const DASHBOARD_WEB_TOTAL_LIMIT = 256 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const STATIC_WIDGETS = new Set(["text", "kpi", "bar", "line", "pie", "scatter", "table", "filter", "shape", "image", "gauge", "progress"]);
export function dashboardWebPath(value: string): boolean {
  return /^[a-zA-Z0-9_./-]+$/.test(value) && !value.startsWith("/")
    && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
export function assertDashboardWebSource(publication: PublishedApplicationRecord, entryPageId: string,
  resources: readonly DashboardWebResource[]): void {
  assertApplicationDocument(publication?.document);
  const application = publication.document;
  if (!publication.id || publication.applicationId !== application.metadata.id
    || publication.projectId !== application.metadata.projectId || publication.applicationRevision !== application.metadata.revision
    || !application.pages.some(page => page.id === entryPageId)) throw new Error("静态包发布身份或入口页不一致");
  if (application.scripts.length || application.scriptDependencies?.length || application.scenes.length || application.interactions.length)
    throw new Error("静态包尚未冻结脚本、三维或交互依赖，请移除这些依赖后重新发布");
  const urls = new Set(resources.filter(item => !item.font).map(item => item.sourceUrl));
  const required = new Set<string>();
  const visit = (value: unknown, key = "", depth = 0): void => {
    if (depth > 64) throw new Error("静态包内容嵌套超限");
    if (typeof value === "string") {
      if (value && (/url$/i.test(key) || /^(?:https?:|data:|blob:|file:|\/\/|\/assets\/)|url\s*\(/i.test(value))) {
        if (!urls.has(value)) throw new Error(`静态包资源未冻结：${key}`);
        required.add(value);
      }
    } else if (Array.isArray(value)) value.forEach(item => visit(item, key, depth + 1));
    else if (value && typeof value === "object") Object.entries(value).forEach(([name,item]) => visit(item,name,depth + 1));
  };
  for (const page of application.pages) for (const node of page.nodes) {
    if (node.kind !== "data-widget" || !STATIC_WIDGETS.has(node.widget.type)) throw new Error(`静态包暂不支持节点：${node.id}`);
    const widget = node.widget;
    if (widget.datasetId || widget.pipelineId || widget.directBinding || widget.semanticBinding)
      throw new Error(`静态包数据未冻结：${node.id}`);
  }
  visit(application);
  if (required.size !== urls.size) throw new Error("静态包包含未被发布文档使用的图片资源");
  if (!resources.some(item => item.font?.weight === 400 && item.font.style === "normal")
    || !resources.some(item => item.font?.weight === 700 && item.font.style === "normal"))
    throw new Error("静态包缺少已授权的正常与粗体字体");
}
/** 除两个 runtimeContentSha256 摘要断言外的全部清单规则；api 侧生成器用它加自有摘要断言。 */
export function validateDashboardWebPackageStructure(value: unknown): asserts value is DashboardWebPackage {
  if (!value || typeof value !== "object") throw new Error("静态包清单无效");
  const item = value as DashboardWebPackage;
  if (item.schema !== "deep-monkey.dashboard-web" || item.schemaVersion !== 1 || !Array.isArray(item.resources)
    || !Array.isArray(item.runtimeFiles) || item.resources.length + item.runtimeFiles.length > 4096)
    throw new Error("静态包版本或文件清单无效");
  let total = 0;
  const paths = new Set<string>(), urls = new Set<string>(), fonts = new Set<string>();
  for (const file of [...item.resources,...item.runtimeFiles]) {
    if (!dashboardWebPath(file.path) || paths.has(file.path) || !SHA.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > DASHBOARD_WEB_FILE_LIMIT)
      throw new Error("静态包文件路径、摘要或预算无效");
    total += file.bytes; paths.add(file.path);
    if (total > DASHBOARD_WEB_TOTAL_LIMIT) throw new Error("静态包总预算超限");
  }
  for (const resource of item.resources) {
    if (typeof resource.sourceUrl !== "string" || urls.has(resource.sourceUrl)) throw new Error("静态包资源身份重复");
    urls.add(resource.sourceUrl);
    if (resource.font) {
      const key = `${resource.font.weight}:${resource.font.style}`;
      if (!Number.isInteger(resource.font.weight) || resource.font.weight < 1 || resource.font.weight > 1000
        || !["normal","italic"].includes(resource.font.style) || !resource.font.licenseEvidence || fonts.has(key)
        || !["font/ttf","font/otf"].includes(resource.mime)
        || !item.runtimeFiles.some(file=>file.path===resource.font!.licensePath)) throw new Error("静态包字体身份或授权记录无效");
      fonts.add(key);
    } else if (!["image/png","image/jpeg","image/webp","image/gif"].includes(resource.mime))
      throw new Error("静态包图片类型尚未封闭，SVG 和外部引用不能直接交付");
  }
  assertDashboardWebSource(item.publication,item.entryPageId,item.resources);
}
/** 读取单个静态 sfnt 字面的 OS/2 样式；绝不猜测字重，也不合成样式。 */
export function dashboardFrozenFontStyle(bytes: Uint8Array): { weight: number; style: "normal" | "italic" } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || ![0x00010000, 0x4f54544f].includes(view.getUint32(0)))
    throw new Error("Heading layout requires an individual static OpenType font");
  const count = view.getUint16(4);
  if (12 + count * 16 > bytes.length) throw new Error("Truncated frozen font directory");
  let os2 = -1;
  for (let index = 0; index < count; index++) {
    const entry = 12 + index * 16, tag = view.getUint32(entry);
    const offset = view.getUint32(entry + 8), length = view.getUint32(entry + 12);
    if (offset + length > bytes.length) throw new Error("Truncated frozen font table");
    if (tag === 0x66766172) throw new Error("Variable font coordinates require an explicit capture contract");
    if (tag === 0x4f532f32 && length >= 64) os2 = offset;
  }
  if (os2 < 0) throw new Error("Frozen font has no OS/2 style identity");
  const weight = view.getUint16(os2 + 4), selection = view.getUint16(os2 + 62);
  if (weight < 1 || weight > 1000 || selection & 512) throw new Error("Unsupported frozen font style");
  return { weight, style: selection & 1 ? "italic" : "normal" };
}
