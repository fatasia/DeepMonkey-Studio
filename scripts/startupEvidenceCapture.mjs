#!/usr/bin/env node
/**
 * 批次 F 冷/热启动证据采集（web 端）：playwright + 系统 Chrome 驱动目标 URL，
 * 经 window.__deepStartupEvidence() 取证（冷=全新 context 首访；热=同 context 二次导航），
 * 多轮采样后输出 JSON（含 evidence schema 与每轮 spans/marks）。
 * 用法：node scripts/startupEvidenceCapture.mjs <url> [rounds=5] [outFile]
 * 依赖 playwright-core：沿仓内先例从 apps/cloud-render-worker/node_modules 解析。
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

const require2 = createRequire(import.meta.url);
const { chromium } = require2(resolve(import.meta.dirname, "../apps/cloud-render-worker/node_modules/playwright-core"));

const url = process.argv[2];
const rounds = Math.max(1, Math.min(Number(process.argv[3] ?? 5), 20));
const outFile = process.argv[4];
if (!url || !url.startsWith("http")) {
  console.error("usage: node scripts/startupEvidenceCapture.mjs <url> [rounds=5] [outFile]");
  process.exit(1);
}

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const samples = [];
try {
  for (let round = 1; round <= rounds; round++) {
    const page = await context.newPage();
    const startedAt = Date.now();
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    const loadedAt = Date.now();
    // interactive 标记（editor-interactive）由应用在挂载后打点；轮询等待其出现（最多 30s）。
    let evidence;
    for (let attempt = 0; attempt < 60; attempt++) {
      evidence = await page.evaluate(() => {
        const collector = window.__deepStartupEvidence;
        return typeof collector === "function" ? collector() : undefined;
      }).catch(() => undefined);
      if (evidence) break;
      await page.waitForTimeout(500);
    }
    samples.push({
      round, kind: round === 1 ? "cold(first-visit-in-context)" : "warm",
      loadWallMs: loadedAt - startedAt,
      interactiveWallMs: Date.now() - startedAt,
      ...(evidence ? { evidence } : { evidenceError: "collector unavailable (mark only fires on editor shell)" }),
    });
    console.log(`round ${round}: load=${samples.at(-1).loadWallMs}ms interactive=${samples.at(-1).interactiveWallMs}ms evidence=${evidence ? "yes" : "no"}`);
    await page.close();
  }
} finally {
  await browser.close();
}
const payload = { schema: "deep-monkey.startup-evidence-capture.v1", url, rounds, samples,
  capturedAt: new Date().toISOString() };
if (outFile) {
  mkdirSync(dirname(resolve(outFile)), { recursive: true });
  writeFileSync(resolve(outFile), `${JSON.stringify(payload, null, 1)}\n`);
  console.log(`wrote ${outFile}`);
} else {
  console.log(JSON.stringify(payload, null, 1));
}
