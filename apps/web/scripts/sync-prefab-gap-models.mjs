// 缺口预制体 CC0/CC-BY 模型补充管线(下载 → 真实渲染缩略图 → 目检批准登记)。
//
// 三段用法(计划文件为 apps/web/test-output/prefab-cc0/plan.json):
//   1. --download :按计划逐 uid 走 Sketchfab 官方下载端点,许可硬校验(CC0-1.0/CC-BY-4.0)、
//                  ≤15MB、GLB 结构审计(有效几何、无外部依赖、≤10万三角面)后入库
//                  data/external-assets/source-b(初始 publicationStatus=review-required)。
//   2. --render   :对本轮新增 uid 用产品 /optimizer 页面真实 WebGL 渲染并导出预览图到
//                  test-output/prefab-cc0/renders/,供人工(代理)目检。
//   3. --approve  :仅对目检通过的 uid(picks.json)把渲染图升格为 reviewed-thumbnails/,
//                  追加 audit.json approved 记录并将 catalog 置 published。
//
// 复用既有机制:scripts/lib 的原子下载、GLB 审计、许可判定与目录锁;
// catalog/audit 记录结构与既有 80 条完全一致(sourceBAssetCatalog.ts 按 eligible 校验)。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { downloadAssetAtomically } from "../../../scripts/lib/atomicAssetDownload.mjs";
import { inspectGlbFile } from "../../../scripts/lib/glbAudit.mjs";
import { readSourceBCatalog, sourceBModelId, sourceBModelLicense, validateSourceBGlb, validateSourceBThumbnail } from "../../../scripts/lib/sourceBModelPolicy.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const cache = path.resolve(repoRoot, "data/external-assets/source-b");
const evidenceRoot = path.resolve(import.meta.dirname, "../test-output/prefab-cc0");
const planPath = path.join(evidenceRoot, "plan.json");
const picksPath = path.join(evidenceRoot, "picks.json");
const rendersDir = path.join(evidenceRoot, "renders");
const MAX_MODEL_BYTES = 15 * 1024 * 1024; // 任务硬约束:与既有库体量一致
const MAX_TRIANGLE_COUNT = 100_000;       // 任务硬约束:面数合理

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const token = (await readFile(path.join(cache, "api-keys.env"), "utf8")).match(/^SKETCHFAB_API_TOKEN\s*=\s*([^\r\n]+)$/m)?.[1]?.trim();
assert.ok(token, "缺少 SKETCHFAB_API_TOKEN");

async function apiJson(relativePath) {
  const url = new URL(`/v3${relativePath}`, "https://api.sketchfab.com");
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(url, { headers: { Authorization: `Token ${token}`, "User-Agent": "BimStudioAssetSync/2.0" }, signal: AbortSignal.timeout(45_000) });
    if (response.status === 429 && attempt < 4) { await response.body?.cancel(); await new Promise((r) => setTimeout(r, attempt * 6000)); continue; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Sketchfab API HTTP ${response.status} ${relativePath}`); }
    return response.json();
  }
  throw new Error(`Sketchfab API 持续限流:${relativePath}`);
}

/** catalog.sync.lock 与既有同步脚本同款:拒绝并行写目录。 */
async function withCatalogLock(fn) {
  const lockPath = path.join(cache, "catalog.sync.lock");
  const lock = await open(lockPath, "wx").catch((error) => {
    if (error.code === "EEXIST") throw new Error("source-b 同步锁已存在,拒绝并行覆盖目录;请先确认原同步进程状态");
    throw error;
  });
  try { return await fn(); } finally { await lock.close(); await unlink(lockPath); }
}

async function writeJsonAtomic(target, value) {
  const temporary = `${target}.${createHash("sha1").update(String(Math.random())).digest("hex").slice(0, 8)}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); await rename(temporary, target); }
  finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}

// ── 第 1 段:下载与登记(review-required)─────────────────────────────────
async function downloadAll() {
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  assert.ok(Array.isArray(plan) && plan.length > 0 && plan.length <= 40, "计划必须为 1~40 条");
  const report = [];
  await withCatalogLock(async () => {
    const catalogPath = path.join(cache, "catalog.json");
    const catalog = await readSourceBCatalog(catalogPath);
    const known = new Map(catalog.models.map((record) => [record.uid, record]));
    for (const entry of plan) {
      const uid = sourceBModelId(entry.uid);
      const item = { uid, prefab: entry.prefabId, name: entry.name };
      try {
        const existing = known.get(uid);
        if (existing?.publicationStatus === "published") { item.result = "already-published"; report.push(item); continue; }
        // 1) 许可与作者信息来自模型详情端点,label 不可信,走官方许可 URL 判定。
        const detail = await apiJson(`/models/${uid}`);
        const provenance = sourceBModelLicense({ ...detail, license: detail.license, user: detail.user, name: detail.name });
        if (!provenance) { item.result = "skipped-license"; report.push(item); continue; }
        if (!detail.isDownloadable) { item.result = "skipped-not-downloadable"; report.push(item); continue; }
        // 2) 下载端点只取元数据核大小,超限不消耗文件流量。
        const download = await apiJson(`/models/${uid}/download`);
        if (!download.glb?.url) { item.result = "skipped-no-glb"; report.push(item); continue; }
        if (Number(download.glb.size) > MAX_MODEL_BYTES) { item.result = "skipped-too-large"; item.size = Number(download.glb.size); report.push(item); continue; }
        // 3) 原子下载 + 结构审计(有效几何、无外部依赖)。
        const modelPath = path.join(cache, "models", `${uid}.glb`);
        const { inspection } = await downloadAssetAtomically(download.glb.url, modelPath, { maxBytes: MAX_MODEL_BYTES, validate: validateSourceBGlb });
        if (inspection.triangleCount > MAX_TRIANGLE_COUNT) {
          await unlink(modelPath);
          item.result = "skipped-too-many-triangles"; item.triangleCount = inspection.triangleCount; report.push(item); continue;
        }
        // 4) Sketchfab 官方预览图入 thumbnails/(catalog.thumbnailName 字段与既有结构一致)。
        let thumbnailName;
        const official = [...(detail.thumbnails?.images ?? [])].sort((a, b) => b.width - a.width).find((image) => image.url);
        if (official) {
          try {
            await downloadAssetAtomically(official.url, path.join(cache, "thumbnails", `${uid}.png`), { maxBytes: 8 * 1024 * 1024, validate: validateSourceBThumbnail });
            thumbnailName = `${uid}.png`;
          } catch (error) { console.error(`  官方预览图待补 ${uid}:${error.message}`); }
        }
        const record = {
          uid, name: String(detail.name || uid), keyword: entry.searchKeyword ?? entry.prefabId ?? "", ...provenance,
          fileName: `${uid}.glb`, ...(thumbnailName ? { thumbnailName } : {}),
          bytes: inspection.bytes, sha256: inspection.sha256, modelAudit: inspection,
          synchronizedAt: new Date().toISOString(), publicationStatus: "review-required",
        };
        known.set(uid, record);
        await writeJsonAtomic(catalogPath, { ...catalog, generatedAt: new Date().toISOString(), licensePolicy: "CC0-1.0 / CC-BY-4.0(完整署名与来源)", models: [...known.values()].sort((a, b) => a.uid.localeCompare(b.uid)) });
        item.result = "downloaded"; item.license = provenance.license; item.author = provenance.author;
        item.triangleCount = inspection.triangleCount; item.bytes = inspection.bytes;
      } catch (error) { item.result = "error"; item.message = error.message; }
      report.push(item);
      console.error(`[${item.result}] ${uid} ${item.name ?? ""} ${item.message ?? ""}`);
    }
  });
  await writeFile(path.join(evidenceRoot, "download-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ total: report.length, downloaded: report.filter((r) => r.result === "downloaded").length }));
}

// ── 第 2 段:真实渲染(产品 /optimizer 页面,WebGL 出图)────────────────────
async function renderAll() {
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const catalog = JSON.parse(await readFile(path.join(cache, "catalog.json"), "utf8"));
  const byUid = new Map(catalog.models.map((record) => [record.uid, record]));
  const targets = plan.map((entry) => byUid.get(sourceBModelId(entry.uid))).filter((record) => record);
  assert.ok(targets.length > 0, "计划内没有可渲染的目录条目");
  await mkdir(rendersDir, { recursive: true });
  const origin = process.argv.find((a) => a.startsWith("--origin="))?.slice(9) ?? "http://127.0.0.1:5173";
  const browser = await playwright.chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const results = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(45000);
    await page.goto(origin);
    const appReady = page.locator(".scene-manager-page");
    if (!await appReady.waitFor({ timeout: 8000 }).then(() => true).catch(() => false)) {
      await page.getByLabel("用户名").fill("admin");
      await page.getByLabel("密码").fill("admin");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await appReady.waitFor();
    }
    for (const record of targets) {
      const entry = { uid: record.uid, name: record.name, errors: [], passed: false };
      try {
        const file = path.join(cache, "models", `${record.uid}.glb`);
        assert.equal(hash(await readFile(file)), record.sha256, "GLB 与目录哈希不一致");
        await page.goto(`${origin}/optimizer`);
        await page.locator('.optimizer-page input[type="file"]').setInputFiles(file);
        await page.locator(".optimizer-canvas canvas").waitFor();
        await page.locator(".optimizer-preview-state").waitFor({ state: "detached" });
        await page.getByRole("button", { name: "适应窗口", exact: true }).click();
        const reflections = page.locator(".optimizer-render-settings label").filter({ hasText: "环境反射" }).getByRole("button");
        if (await reflections.innerText() === "关闭") await reflections.click();
        await page.waitForTimeout(650);
        const downloading = page.waitForEvent("download");
        await page.getByRole("button", { name: "下载预览图", exact: true }).click();
        const preview = path.join(rendersDir, `${record.uid}.png`);
        await (await downloading).saveAs(preview);
        const metadata = await sharp(await readFile(preview)).metadata();
        assert.equal(metadata.format, "png", "预览图必须是 PNG");
        assert.ok(metadata.width >= 240 && metadata.width <= 1920 && metadata.height >= 160 && metadata.height <= 1440, `预览图尺寸越界 ${metadata.width}×${metadata.height}`);
        entry.width = metadata.width; entry.height = metadata.height;
        await page.screenshot({ path: path.join(rendersDir, `${record.uid}-page.png`) });
        entry.passed = true;
      } catch (error) { entry.errors.push(error.message); }
      results.push(entry);
      console.error(`[${entry.passed ? "rendered" : "failed"}] ${record.uid} ${entry.errors.join(";")}`);
    }
  } finally { await browser.close(); }
  await writeFile(path.join(evidenceRoot, "render-report.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ total: results.length, rendered: results.filter((r) => r.passed).length }));
}

// ── 第 3 段:目检批准登记(reviewed-thumbnails + audit + published)──────────
async function approveAll() {
  const picks = JSON.parse(await readFile(picksPath, "utf8"));
  const catalog = JSON.parse(await readFile(path.join(cache, "catalog.json"), "utf8"));
  const audit = JSON.parse(await readFile(path.join(cache, "audit.json"), "utf8"));
  assert.equal(audit.schemaVersion, 1, "audit.json 格式必须为 schemaVersion 1");
  const byUid = new Map(catalog.models.map((record) => [record.uid, record]));
  const approvedBefore = audit.items.filter((item) => item.status === "approved");
  const thumbnails = [];
  for (const [rawUid, pick] of Object.entries(picks)) {
    const uid = sourceBModelId(rawUid);
    const model = byUid.get(uid);
    assert.ok(model, `${uid} 不在 catalog 中`);
    if (approvedBefore.some((item) => item.uid === uid)) { console.error(`[skip] ${uid} 已有批准记录`); continue; }
    assert.equal(pick.approved, true, `${uid} 未标记 approved`);
    // 目检通过的证据:渲染图真实存在且与模型哈希绑定。
    const renderPath = path.join(rendersDir, `${uid}.png`);
    const png = await readFile(renderPath);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "渲染图必须是 PNG");
    const metadata = await sharp(png).metadata();
    assert.ok(metadata.width >= 240 && metadata.width <= 1920 && metadata.height >= 160 && metadata.height <= 1440, "渲染图尺寸越界");
    assert.ok(model.modelAudit?.valid && model.modelAudit.sha256 === model.sha256 && !model.modelAudit.externalUris.length, "模型结构审计未通过");
    assert.ok(["CC-BY-4.0", "CC0-1.0"].includes(model.license) && model.author && model.attribution, "许可与署名不完整");
    assert.equal(model.originUrl, `https://sketchfab.com/3d-models/${uid}`);
    const relativePath = `reviewed-thumbnails/${uid}.png`;
    thumbnails.push({ path: path.join(cache, relativePath), png });
    const review = {
      uid, contentHash: model.sha256, status: "approved", reviewedAt: new Date().toISOString(),
      displayName: pick.displayName, category: pick.category, tags: pick.tags,
      notes: pick.notes, evidence: "apps/web/test-output/prefab-cc0/renders/",
      thumbnail: { relativePath, sha256: hash(png), modelHash: model.sha256, renderer: "studio-webgl", width: metadata.width, height: metadata.height },
    };
    audit.items = [...audit.items.filter((item) => item.uid !== uid), review];
    model.publicationStatus = "published";
  }
  assert.ok(Array.isArray(audit.items) && audit.items.length >= approvedBefore.length, "既有批准记录不得丢失");
  await withCatalogLock(async () => {
    // 先写审计与缩略图,后置 published:中途失败的新记录不会被目录适配器公开。
    await mkdir(path.join(cache, "reviewed-thumbnails"), { recursive: true });
    for (const item of thumbnails) await writeFile(item.path, item.png, { flag: "wx" });
    await writeJsonAtomic(path.join(cache, "audit.json"), audit);
    await writeJsonAtomic(path.join(cache, "catalog.json"), catalog);
  });
  console.log(JSON.stringify({ approved: thumbnails.length, auditTotal: audit.items.length }));
}

const mode = process.argv.includes("--download") ? "download" : process.argv.includes("--render") ? "render" : process.argv.includes("--approve") ? "approve" : undefined;
assert.ok(mode, "用法:--download | --render | --approve");
await (mode === "download" ? downloadAll : mode === "render" ? renderAll : approveAll)();
