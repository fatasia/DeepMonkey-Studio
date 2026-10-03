/**
 * H-C6-S3-connect v2:apiClients 方法 × UI 消费点对账(inventory v2 余量②的自动化面)。
 *
 * 口径:以 apps/web/src/apiClients/*.ts 的导出 client 函数为对账主体——
 * 每个函数提取其请求路径模板,再全仓 grep 该函数名的调用方文件并按域分类
 * (components/hooks/panels/tests/其他 client)。无 UI 消费的函数列出
 * (API-only 合法或缺口,由人工口径判定,脚本只给事实)。
 *
 * 用法:node apps/web/scripts/apiEndpointConsumptionAudit.mjs
 * 产物:test-output/hc6s3-v2-audit-20261003/consumption-audit.json + 摘要 stdout
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const srcRoot = resolve(webRoot, "src");
const outputRoot = resolve(webRoot, "../../test-output/hc6s3-v2-audit-20261003");
mkdirSync(outputRoot, { recursive: true });

/** 递归收集 .ts/.tsx(排除测试)。 */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "node_modules") out.push(...walk(full)); }
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) out.push(full);
  }
  return out;
}

const allFiles = walk(srcRoot);
const clientFiles = allFiles.filter(path => path.includes(`${resolve(srcRoot, "apiClients")}`));

/** 从 client 文件提取导出函数与其 URL 模板。 */
const methods = [];
for (const file of clientFiles) {
  const name = basename(file).replace(/Api\.ts$/, "").replace(/\.ts$/, "");
  const src = readFileSync(file, "utf-8");
  // 函数形态:async function fn(...) { ... open/request<...>("/path...") ... } 或对象字面量方法 fn: (...) => request("/path")
  const fnPattern = /(?:async\s+function\s+([A-Za-z0-9_]+)|([A-Za-z0-9_]+)\s*:\s*(?:async\s*)?\()/g;
  const seen = new Set();
  for (const fileLine of src.split("\n").entries()) {
    const [index, line] = fileLine;
    const fn = /(?:async\s+function\s+([A-Za-z0-9_]+))|((?:^|\s{2,})([A-Za-z0-9_]+):\s*(?:async\s*)?\()/.exec(line);
    const methodName = fn?.[1] ?? fn?.[3];
    if (!methodName || seen.has(methodName)) continue;
    // 向后找该函数体内的第一个 URL 字面量(最多 40 行)。
    let url = null, httpMethod = null;
    for (let ahead = index; ahead < Math.min(index + 40, src.split("\n").length); ahead += 1) {
      const urlMatch = /["'`](\/(?:api|health)[^"'`]*)["'`]/.exec(src.split("\n")[ahead]);
      if (urlMatch) {
        url = urlMatch[1];
        const methodMatch = /method:\s*["'`](\w+)["'`]/.exec(src.split("\n").slice(index, ahead + 1).join("\n"));
        httpMethod = methodMatch?.[1] ?? "GET";
        break;
      }
    }
    if (!url) continue;
    seen.add(methodName);
    methods.push({ client: name, method: methodName, urlTemplate: url, httpMethod, file: `apps/web/src/apiClients/${basename(file)}` });
  }
}

/** 全仓统计每个方法的 UI 消费文件。 */
function consumersOf(methodName) {
  const consumers = { components: [], hooks: [], panels: [], controllers: [], adapters: [], delivery: [], studio: [], apiClients: [], other: [] };
  for (const file of allFiles) {
    if (clientFiles.includes(file) && !readFileSync(file, "utf-8").includes(`.${methodName}`) && !readFileSync(file, "utf-8").includes(methodName)) continue;
    const rel = file.slice(srcRoot.length + 1).replaceAll("\\", "/");
    let src;
    try { src = readFileSync(file, "utf-8"); } catch { continue; }
    if (!new RegExp(`\\b${methodName}\\b`).test(src)) continue;
    if (rel.startsWith("apiClients/")) consumers.apiClients.push(rel);
    else if (rel.startsWith("components/")) consumers.components.push(rel);
    else if (rel.startsWith("hooks/")) consumers.hooks.push(rel);
    else if (rel.startsWith("controllers/")) consumers.controllers.push(rel);
    else if (rel.startsWith("adapters/")) consumers.adapters.push(rel);
    else if (rel.startsWith("delivery/")) consumers.delivery.push(rel);
    else if (rel.startsWith("studio/")) consumers.studio.push(rel);
    else if (/Panel|View|Dialog|Card|Workbench|Workspace/.test(rel)) consumers.panels.push(rel);
    else consumers.other.push(rel);
  }
  return consumers;
}

const audit = methods.map(entry => {
  const consumers = consumersOf(entry.method);
  const uiFiles = [...consumers.components, ...consumers.hooks, ...consumers.panels, ...consumers.controllers,
    ...consumers.adapters, ...consumers.delivery, ...consumers.studio];
  return { ...entry, uiConsumerCount: uiFiles.length, uiConsumers: uiFiles.slice(0, 6), otherConsumers: [...consumers.apiClients, ...consumers.other].slice(0, 4) };
});

const unconsumed = audit.filter(entry => entry.uiConsumerCount === 0);
const summary = {
  generatedAt: new Date().toISOString(),
  totalClientMethods: audit.length,
  withUiConsumers: audit.length - unconsumed.length,
  withoutUiConsumers: unconsumed.length,
  byClient: audit.reduce((acc, entry) => { acc[entry.client] = (acc[entry.client] ?? 0) + 1; return acc; }, {}),
};
writeFileSync(resolve(outputRoot, "consumption-audit.json"), JSON.stringify({ summary, methods: audit }, null, 1));
console.log(JSON.stringify(summary, null, 1));
console.log("\n无 UI 消费的 client 方法(API-only 候选,逐条人工判定):");
for (const entry of unconsumed) console.log(`  - ${entry.client}.${entry.method}  ${entry.httpMethod} ${entry.urlTemplate}`);
