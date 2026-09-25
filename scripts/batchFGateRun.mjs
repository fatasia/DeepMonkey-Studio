#!/usr/bin/env node
/**
 * 批次 F 全量门禁序列 runner：按验证顺序逐条执行，中间失败继续后续项，
 * 汇总 JSON 报告（逐项 exit code/耗时/输出尾部）到 test-output/batch-f-gate-<时间戳>/。
 * 用法：node scripts/batchFGateRun.mjs [--quick]（--quick 跳过 test/build 长项只跑快速门禁）。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const quick = process.argv.includes("--quick");
const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[-:T]/g, "").slice(0, 14);
const outDir = resolve("test-output", `batch-f-gate-${stamp}`);
mkdirSync(outDir, { recursive: true });

const GATES = [
  { id: "repository", cmd: "pnpm gate:repository" },
  { id: "source-size", cmd: "pnpm quality:source-size" },
  { id: "public-brand", cmd: "pnpm quality:public-brand" },
  { id: "typecheck", cmd: "pnpm typecheck" },
  { id: "test", cmd: "pnpm test", skippableByQuick: true },
  { id: "build", cmd: "pnpm build", skippableByQuick: true },
  { id: "deep-p0", cmd: "pnpm gate:deep-p0" },
  { id: "scene-client", cmd: "pnpm test:scene-client" },
  { id: "product-browser", cmd: "pnpm gate:product-browser" },
  { id: "webgpu", cmd: "pnpm gate:webgpu" },
  { id: "production-artifact", cmd: "pnpm gate:production-artifact" },
];

const results = [];
for (const gate of GATES) {
  if (quick && gate.skippableByQuick) {
    results.push({ id: gate.id, status: "skipped(quick)" });
    continue;
  }
  console.log(`\n===== [${gate.id}] ${gate.cmd} =====`);
  const t0 = Date.now();
  const proc = spawnSync("cmd", ["/c", gate.cmd], { encoding: "utf8", shell: false,
    env: { ...process.env, FORCE_COLOR: "0" }, timeout: 30 * 60_000 });
  const durationMs = Date.now() - t0;
  const output = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
  const logPath = resolve(outDir, `${String(results.length + 1).padStart(2, "0")}-${gate.id}.log`);
  writeFileSync(logPath, output);
  const tail = output.split(/\r?\n/).filter(Boolean).slice(-4).join(" | ").slice(0, 400);
  const status = proc.status === 0 ? "PASS" : `FAIL(exit ${proc.status})`;
  console.log(`[${status}] ${gate.id} (${(durationMs / 1000).toFixed(0)}s) log=${logPath}`);
  console.log(`  tail: ${tail}`);
  results.push({ id: gate.id, status, durationMs, logPath, tail });
}

const passed = results.filter(r => r.status === "PASS").length;
const failed = results.filter(r => String(r.status).startsWith("FAIL")).length;
const skipped = results.filter(r => String(r.status).startsWith("skipped")).length;
const report = { schema: "deep-monkey.batch-f-gate-run.v1", startedAt, finishedAt: new Date().toISOString(),
  summary: { passed, failed, skipped, total: results.length }, results };
writeFileSync(resolve(outDir, "gate-run-summary.json"), `${JSON.stringify(report, null, 1)}\n`);
console.log(`\nbatch-F gate run: ${passed} passed / ${failed} failed / ${skipped} skipped → ${outDir}\\gate-run-summary.json`);
process.exit(failed > 0 ? 1 : 0);
