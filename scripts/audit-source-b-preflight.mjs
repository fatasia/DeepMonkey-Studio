import { mkdtemp, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { inspectGlbFile } from "./lib/glbAudit.mjs";
import { readSourceBCatalog } from "./lib/sourceBModelPolicy.mjs";

// 只生成候选审核清单；结构合格不代表许可或人工视觉审核通过，不写回素材目录。
const root = resolve(import.meta.dirname, "..");
const cache = await realpath(resolve(root, "data/external-assets/source-b"));
const catalog = await readSourceBCatalog(resolve(cache, "catalog.json"));
const reviews = JSON.parse(await readFile(resolve(cache, "audit.json"), "utf8"));
const parent = resolve(root, "test-output/source-b-preflight");
await mkdir(parent, { recursive: true });
const output = await mkdtemp(resolve(parent, "audit-"));
const items = [];
for (const model of catalog.models) {
  const item = { uid: model.uid, name: model.name, issues: [], visuallyReviewed: false };
  try {
    const file = await realpath(resolve(cache, "models", model.fileName));
    if (!file.startsWith(`${cache}${sep}`)) throw new Error("模型路径不在素材缓存内");
    const bytes = (await stat(file)).size;
    const inspected = await inspectGlbFile(file, bytes);
    item.structure = inspected;
    if (!inspected.valid || !inspected.meshCount || !inspected.primitiveCount) item.issues.push("invalid-geometry");
    if (inspected.sha256 !== model.sha256 || bytes !== model.bytes) item.issues.push("catalog-content-mismatch");
    if (inspected.externalUris?.length) item.issues.push("external-resources");
    const licenseUrl = model.license === "CC-BY-4.0" ? "https://creativecommons.org/licenses/by/4.0/"
      : model.license === "CC0-1.0" ? "https://creativecommons.org/publicdomain/zero/1.0/" : undefined;
    if (!licenseUrl || model.licenseUrl !== licenseUrl || !model.author || !model.attribution) item.issues.push("license-evidence-required");
    const review = reviews.items.find(value => value.uid === model.uid);
    item.visuallyReviewed = Boolean(review?.status === "approved" && review.contentHash === inspected.sha256 && review.thumbnail?.modelHash === inspected.sha256);
    if (!item.visuallyReviewed) item.issues.push("visual-review-and-thumbnail-required");
  } catch (error) { item.issues.push("inspection-failed"); item.error = error.message; }
  items.push(item);
}
const summary = {
  total: items.length,
  structurallyValid: items.filter(item => item.structure?.valid && item.structure.meshCount && item.structure.primitiveCount && !item.structure.externalUris?.length && !item.issues.includes("catalog-content-mismatch")).length,
  licenseEvidenceRequired: items.filter(item => item.issues.includes("license-evidence-required")).length,
  visuallyReviewed: items.filter(item => item.visuallyReviewed).length,
  issues: Object.fromEntries([...new Set(items.flatMap(item => item.issues))].map(issue => [issue, items.filter(item => item.issues.includes(issue)).length])),
};
await writeFile(resolve(output, "report.json"), JSON.stringify({ createdAt: new Date().toISOString(), boundary: "离线结构预检；不自动审核、不发布、不修改原始文件", summary, items }, null, 2));
console.log(JSON.stringify({ output, ...summary }, null, 2));
if (items.some(item => item.issues.some(issue => ["inspection-failed", "invalid-geometry", "catalog-content-mismatch", "external-resources"].includes(issue)))) process.exitCode = 1;
