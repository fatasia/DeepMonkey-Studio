import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { readSourceBCatalog } from "./lib/sourceBModelPolicy.mjs";
import { inspectGlbFile } from "./lib/glbAudit.mjs";
import { refreshedSourceBEvidence } from "./lib/sourceBEvidenceRefresh.mjs";

const root = resolve(import.meta.dirname, "..");
const cache = await realpath(resolve(root, "data/external-assets/source-b"));
const catalogPath = resolve(cache, "catalog.json"), lockPath = resolve(cache, "catalog.sync.lock");
const lock = await open(lockPath, "wx");
const parent = resolve(root, "test-output/source-b-evidence"); await mkdir(parent, { recursive: true });
const output = await mkdtemp(resolve(parent, "refresh-"));
const report = { output, apply: process.argv.includes("--apply"), updated: [], failures: [] };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
let limited = false, cursor = 0;
try {
  const original = await readFile(catalogPath);
  const catalog = await readSourceBCatalog(catalogPath);
  const candidates = catalog.models.filter(model => !model.licenseUrl || !model.modelAudit);
  await writeFile(resolve(output, "catalog.before.json"), original);
  async function worker() {
    while (cursor < candidates.length && !limited) {
      const record = candidates[cursor++];
      try {
        const response = await fetch(`https://api.sketchfab.com/v3/models/${record.uid}`, { signal: AbortSignal.timeout(15000) });
        if ([401, 403, 429].includes(response.status)) limited = true;
        if (!response.ok) throw new Error(`官方元数据 HTTP ${response.status}`);
        const detail = await response.json();
        const file = await realpath(resolve(cache, "models", record.fileName));
        if (!file.startsWith(`${cache}${sep}`)) throw new Error("模型路径越界");
        const inspection = await inspectGlbFile(file, (await stat(file)).size);
        const updated = refreshedSourceBEvidence(record, detail, inspection, new Date().toISOString());
        catalog.models[catalog.models.findIndex(item => item.uid === record.uid)] = updated;
        report.updated.push(record.uid);
      } catch (error) { report.failures.push({ uid: record.uid, message: error.message }); }
      if ((report.updated.length + report.failures.length) % 20 === 0) console.log(JSON.stringify({ checked: report.updated.length + report.failures.length, total: candidates.length }));
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  report.unchecked = candidates.length - cursor;
  if (report.apply && report.updated.length) {
    if (hash(await readFile(catalogPath)) !== hash(original)) throw new Error("目录被其他任务修改，保留结果但拒绝覆盖");
    const temporary = `${catalogPath}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(catalog, null, 2) + "\n", { flag: "wx" }); await rename(temporary, catalogPath); }
    finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
} finally {
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  await lock.close(); await unlink(lockPath);
  console.log(JSON.stringify({ output, applied: report.apply, updated: report.updated.length, failures: report.failures, unchecked: report.unchecked }));
}
