import { assertApplicationDocument, type PublishedApplicationRecord } from "@bim-studio/contracts";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";

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
export function assertDashboardWebPackage(value: unknown): asserts value is DashboardWebPackage {
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
  if (runtimeContentSha256(item.publication) !== item.publicationSha256) throw new Error("静态包发布摘要不匹配");
  const {contentSha256,...body} = item;
  if (runtimeContentSha256(body) !== contentSha256) throw new Error("静态包清单摘要不匹配");
}
