import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { readSourceBCatalog } from "./lib/sourceBModelPolicy.mjs";

const root = resolve(import.meta.dirname, ".."), cache = await realpath(resolve(root, "data/external-assets/source-b"));
const manifestPath = resolve(root, process.argv.find(arg => arg.startsWith("--manifest="))?.slice(11) ?? "docs/source-b-visual-review-batch-2026-09-08.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(manifest.schemaVersion, 1); assert.ok(manifest.reviewedBy && manifest.items?.length > 0 && manifest.items.length <= 40);
const evidencePath = await realpath(resolve(root, manifest.evidence));
assert.ok(evidencePath.startsWith(`${resolve(root, "test-output")}${sep}`));
const evidence = JSON.parse(await readFile(evidencePath, "utf8")), output = dirname(evidencePath);
const catalogPath = resolve(cache, "catalog.json"), auditPath = resolve(cache, "audit.json"), lockPath = resolve(cache, "catalog.sync.lock");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const lock = await open(lockPath, "wx");
try {
  const catalogBefore = await readFile(catalogPath), auditBefore = await readFile(auditPath);
  const catalog = await readSourceBCatalog(catalogPath), audit = JSON.parse(auditBefore);
  const oldApproved = audit.items.filter(item => item.status === "approved"), seen = new Set(), thumbnails = [];
  for (const decision of manifest.items) {
    assert.ok(/^[a-f0-9]{32}$/.test(decision.uid) && !seen.has(decision.uid)); seen.add(decision.uid);
    assert.ok(["approved", "review-required"].includes(decision.status) && decision.displayName?.trim() && decision.notes?.trim());
    assert.ok(!oldApproved.some(item => item.uid === decision.uid), "已有批准记录不得被本批覆盖");
    const model = catalog.models.find(item => item.uid === decision.uid); assert.ok(model);
    const modelBytes = await readFile(resolve(cache, "models", model.fileName));
    assert.equal(hash(modelBytes), model.sha256); assert.equal(modelBytes.length, model.bytes);
    const cases = evidence.cases.filter(entry => entry.uid === decision.uid);
    assert.equal(cases.length, 4); assert.ok(cases.every(entry => entry.modelHash === model.sha256 && entry.views.length === 3));
    assert.equal(new Set(cases.map(entry => `${entry.round}-${entry.theme}-${entry.width}`)).size, 4);
    const review = { uid: model.uid, contentHash: model.sha256, status: decision.status, reviewedAt: new Date().toISOString(), displayName: decision.displayName, notes: decision.notes, evidence: manifest.evidence };
    if (decision.status === "approved") {
      assert.ok(cases.every(entry => entry.passed && entry.errors.length === 0 && entry.driverWarnings.length === 0), "有渲染异常不能批准");
      assert.ok(model.modelAudit?.valid && model.modelAudit.sha256 === model.sha256 && !model.modelAudit.externalUris.length);
      assert.ok(["CC-BY-4.0", "CC0-1.0"].includes(model.license) && model.author && model.attribution);
      assert.equal(model.originUrl, `https://sketchfab.com/3d-models/${model.uid}`);
      assert.equal(model.licenseUrl, model.license === "CC-BY-4.0" ? "https://creativecommons.org/licenses/by/4.0/" : "https://creativecommons.org/publicdomain/zero/1.0/");
      assert.ok(decision.category?.trim() && Array.isArray(decision.tags) && decision.tags.every(tag => typeof tag === "string"));
      const view = cases.flatMap(entry => entry.views).find(item => item.path === decision.thumbnail); assert.ok(view);
      const source = await realpath(resolve(output, view.path)); assert.ok(source.startsWith(`${output}${sep}`));
      const png = await readFile(source); assert.equal(hash(png), view.sha256);
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(png.readUInt32BE(16), view.width); assert.equal(png.readUInt32BE(20), view.height);
      assert.ok(view.width >= 240 && view.width <= 1920 && view.height >= 160 && view.height <= 1440);
      const relativePath = `reviewed-thumbnails/${model.uid}.png`;
      thumbnails.push({ path: resolve(cache, relativePath), png });
      Object.assign(review, { category: decision.category, tags: decision.tags, thumbnail: { relativePath, sha256: view.sha256, modelHash: model.sha256, renderer: "studio-webgl", width: view.width, height: view.height } });
      model.publicationStatus = "published";
    }
    audit.items = [...audit.items.filter(item => item.uid !== decision.uid), review];
  }
  assert.deepEqual(audit.items.filter(item => oldApproved.some(old => old.uid === item.uid)), oldApproved);
  if (process.argv.includes("--apply")) {
    assert.equal(hash(await readFile(catalogPath)), hash(catalogBefore)); assert.equal(hash(await readFile(auditPath)), hash(auditBefore));
    await writeFile(resolve(output, "catalog.before-review.json"), catalogBefore, { flag: "wx" });
    await writeFile(resolve(output, "audit.before-review.json"), auditBefore, { flag: "wx" });
    await mkdir(resolve(cache, "reviewed-thumbnails"), { recursive: true });
    for (const item of thumbnails) await writeFile(item.path, item.png, { flag: "wx" });
    // 先写审计，后开启目录发布；中途失败的新记录仍不能被目录适配器公开。
    for (const [path, data] of [[auditPath, audit], [catalogPath, catalog]]) {
      const temp = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { flag: "wx" }); await rename(temp, path); }
      finally { await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    }
  }
  console.log(JSON.stringify({ apply: process.argv.includes("--apply"), reviewed: manifest.items.length, newlyApproved: thumbnails.length, oldApprovedPreserved: oldApproved.length, evidence: manifest.evidence }));
} finally { await lock.close(); await unlink(lockPath); }
