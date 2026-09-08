// 删除未通过视觉审核的 source-b 素材（用户 2026-09-09 指令）。
// 仅保留 audit 中 status=approved 的模型；catalog/audit/模型文件三者同步；
// 删除前把 catalog 与 audit 原样备份到 test-output（gitignored），原 GLB 不进 Git 因此无需另档。
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cache = resolve(root, "data/external-assets/source-b");
const backupDir = resolve(root, "test-output/source-b-prune-backup");

const catalogPath = resolve(cache, "catalog.json");
const auditPath = resolve(cache, "audit.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const audit = JSON.parse(await readFile(auditPath, "utf8"));

const approvedUids = new Set(audit.items.filter((item) => item.status === "approved").map((item) => item.uid));
assert.equal(approvedUids.size, 89, `批准项应为 89，实际 ${approvedUids.size}`);

const keepModels = catalog.models.filter((model) => approvedUids.has(model.uid));
const removeModels = catalog.models.filter((model) => !approvedUids.has(model.uid));
assert.equal(keepModels.length, 89, `保留模型应为 89，实际 ${keepModels.length}`);
assert.equal(removeModels.length, 77, `待删模型应为 77，实际 ${removeModels.length}`);

await mkdir(backupDir, { recursive: true });
await copyFile(catalogPath, resolve(backupDir, "catalog.before-prune.json"));
await copyFile(auditPath, resolve(backupDir, "audit.before-prune.json"));

let removedFiles = 0;
for (const model of removeModels) {
  await unlink(resolve(cache, "models", model.fileName));
  removedFiles += 1;
}

catalog.models = keepModels;
audit.items = audit.items.filter((item) => item.status === "approved");

const nextCatalog = resolve(cache, "catalog.json.next");
const nextAudit = resolve(cache, "audit.json.next");
await writeFile(nextCatalog, JSON.stringify(catalog, null, 2));
await writeFile(nextAudit, JSON.stringify(audit, null, 2));
await rename(nextCatalog, catalogPath);
await rename(nextAudit, auditPath);

console.log(JSON.stringify({
  pruned: removedFiles,
  keptModels: keepModels.length,
  keptAuditItems: audit.items.length,
  backup: backupDir,
}));
