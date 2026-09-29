import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const packageRoot = fileURLToPath(new URL("./", import.meta.url));
const require = createRequire(import.meta.url);
const playwright = require("../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
const dir = await mkdtemp(path.join(tmpdir(), "dbg-"));
await build({ absWorkingDir: packageRoot, entryPoints: ["lab/localSpotShadowAtlasTierGpuProbe.ts"], bundle: true,
  format: "esm", target: "es2022", outfile: path.join(dir, "probe.bundle.mjs"), logLevel: "silent" });
await writeFile(path.join(dir, "probe.html"), "<!doctype html><html><body></body></html>");
const server = createServer(async (req, res) => {
  const name = new URL(req.url ?? "/", "http://x").pathname.replace("/", "");
  if (name !== "probe.html" && name !== "probe.bundle.mjs") { res.writeHead(404).end(); return; }
  res.setHeader("Content-Type", name.endsWith(".html") ? "text/html" : "text/javascript");
  res.end(await readFile(path.join(dir, name)));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, args: ["--enable-unsafe-webgpu"] });
const page = await browser.newPage({ viewport: { width: 512, height: 384 } });
page.on("console", m => console.log("[pg]", m.text().slice(0, 300)));
page.on("pageerror", e => console.log("[err]", e.message));
await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
// 打补丁:在 beginLeg 后改视图——通过 evaluate 直接调用内部不可行,改用 stepLeg 前注入定向光:
// 直接跑 standard 腿并取读回统计 + renderer 内部状态
const stats = await page.evaluate(async () => {
  const mod = await import("./probe.bundle.mjs");
  const abi = mod.probeAbiBudget();
  await mod.beginLeg("standard");
  // 内省:重渲染一帧并抓 readback 原始分布
  const frames = await mod.stepLeg(6);
  return { abi, frames };
});
console.log(JSON.stringify(stats));
// 抓 luma 分布:再跑一次并读 raw
const dist = await page.evaluate(async () => {
  const mod = await import("./probe.bundle.mjs");
  await mod.endLeg();
  await mod.beginLeg("standard");
  await mod.stepLeg(6);
  // patchRect 信息通过 endLeg 前 probe 常量不可得——直接 endLeg 拿 aggregate
  const leg = await mod.endLeg();
  return { covered: leg.coveredLights, rmse: leg.aggregate.rmse, leak: leg.aggregate.leakFraction,
    perFirst: leg.perLight.slice(0, 3).map(p => ({ key: p.key, shadowed: p.shadowed,
      rmse: Number(p.stats.rmse.toFixed(3)), leak: Number(p.stats.leakFraction.toFixed(3)),
      shadowedSamples: p.stats.shadowedSamples, samples: p.stats.samples })) };
});
console.log(JSON.stringify(dist, null, 1));
await browser.close(); server.close(); await rm(dir, { recursive: true, force: true });
