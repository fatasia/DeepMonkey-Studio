import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile, mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// R8 体积账本（用户 2026-09-19 批准）：把 web 产物、WASM、Native 可执行文件的体积
// 记成带预算的账本；超预算即退出非零（可挂 CI 阻断）。每次运行写入带日期的历史
// 与 latest.json，自动对比上一次账本给出趋势；禁止用降低内容换体积。

const root = process.cwd();
const webDist = resolve(root, "apps/web/dist");
const nativeRelease = resolve(root, "packages/deep-engine-native/target/release");
const outDir = resolve(root, "test-output/size-ledger");

// 预算（初始基线 = 2026-09-19 实测 + 工程余量；调整必须随证据一起改，禁止只改数字）
const BUDGETS = {
  "web.dist.totalMiB": 160,
  "native.deep-engine-native.exeMiB": 40,
  "native.industrial-worker-host.exeMiB": 4,
};

async function dirBytes(dir) {
  let total = 0;
  const files = [];
  const walk = async (current, prefix) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = resolve(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, rel);
      else {
        const info = await stat(full);
        total += info.size;
        files.push({ path: rel, bytes: info.size });
      }
    }
  };
  if (existsSync(dir)) await walk(dir, "");
  return { total, files };
}

if (!existsSync(webDist)) throw new Error("缺少 apps/web/dist，请先 pnpm --dir apps/web build");
const dist = await dirBytes(webDist);
const wasmFiles = dist.files.filter((file) => file.path.endsWith(".wasm")).map((file) => ({ path: file.path, MiB: Number((file.bytes / 1048576).toFixed(2)) }));

const nativeExes = [];
if (existsSync(nativeRelease)) {
  for (const entry of await readdir(nativeRelease, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".exe")) {
      const info = await stat(resolve(nativeRelease, entry.name));
      nativeExes.push({ name: entry.name, MiB: Number((info.size / 1048576).toFixed(2)) });
    }
  }
}

const measurements = {
  "web.dist.totalMiB": Number((dist.total / 1048576).toFixed(2)),
  "native.deep-engine-native.exeMiB": nativeExes.find((item) => item.name === "deep-engine-native.exe")?.MiB ?? null,
  "native.industrial-worker-host.exeMiB": nativeExes.find((item) => item.name === "industrial-worker-host.exe")?.MiB ?? null,
};

const largest = [...dist.files].sort((a, b) => b.bytes - a.bytes).slice(0, 12).map((file) => ({ path: file.path, MiB: Number((file.bytes / 1048576).toFixed(2)) }));

const violations = Object.entries(BUDGETS).flatMap(([key, budget]) => {
  const value = measurements[key];
  if (value === null || value === undefined) return [`${key}: 未测得（产物缺失）`];
  return value > budget ? [`${key}: ${value} MiB 超预算 ${budget} MiB`] : [];
});

const previousPath = resolve(outDir, "latest.json");
let trend = null;
if (existsSync(previousPath)) {
  try {
    const previous = JSON.parse(await readFile(previousPath, "utf8"));
    trend = Object.fromEntries(Object.entries(measurements).map(([key, value]) => {
      const before = previous.measurements?.[key];
      return [key, before == null || value == null ? null : Number((value - before).toFixed(2))];
    }));
  } catch {
    trend = null;
  }
}

const report = {
  schema: "deep-monkey.size-ledger.v1",
  generatedAt: new Date().toISOString(),
  budgets: BUDGETS,
  measurements,
  trend,
  wasm: wasmFiles,
  native: nativeExes,
  largestDistFiles: largest,
  webDistSha256: createHash("sha256").update(String(dist.total)).digest("hex").slice(0, 16),
  violations,
  verdict: violations.length === 0 ? "passed" : "failed",
  evidenceBoundary: "体积账本只记录产物体积与预算；不把删功能/降画质当体积优化",
};

await mkdir(outDir, { recursive: true });
const stamp = report.generatedAt.slice(0, 10);
await writeFile(resolve(outDir, `ledger-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await cp(resolve(outDir, `ledger-${stamp}.json`), previousPath);
console.log(JSON.stringify({ verdict: report.verdict, measurements, trend, violations }, null, 2));
if (violations.length > 0) process.exit(1);
