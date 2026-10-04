import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * VSM M2 定位诊断:虚拟腿 settle 后,对栅栏遮挡体/地面接收点做 GPU 读回逐 mip
 * resolve 重放(.deepVsmResolveRing 等价),输出每 (样本,环,mip) 的
 * slot/atlasDepth/shadowed —— 定位"全亮"缺陷发生在 驻留/物化内容/深度合同 哪一环。
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "test-output/vsm-m2-diag");
await mkdir(out, { recursive: true });
const require = createRequire(import.meta.url);
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/virtualShadowGpuProbe.ts")],
  outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser" });

const server = createServer(async (request, response) => {
  if (request.url === "/probe.mjs") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(await readFile(path.join(out, "probe.mjs")));
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<html><body style="background:#111;color:#eee"><div id="results"></div></body></html>`);
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

const FLOW = `(async () => {
    const probe = await import("/probe.mjs");
    await probe.beginLeg("virtual", false);
    await probe.settleLeg();
    const band = await probe.diagVirtualBand(6);
    return { band, residencyCount: probe.dumpVirtualShadowResidency().length };
  })()`;

/** 策略评分:与 8192 参考带逐点对分(可见度域),级联带同口径并列。 */
function scorePolicy(band, referenceBand, cascadeBand) {
  const refLuma = referenceBand.luma, casLuma = cascadeBand.luma;
  const brightRef = referenceBand.brightMean ?? undefined;
  // 参考二值掩码(与 edgeAliasingEnergy 同阈口径的软化版):影 < 0.55·亮均值。
  const brightSamples = [];
  for (const key of Object.keys(refLuma)) { const v = refLuma[key]; if (v > 0.3) brightSamples.push(v); }
  const brightMean = brightSamples.reduce((a, b) => a + b, 0) / brightSamples.length;
  const threshold = 0.55 * brightMean;
  const stats = new Map();
  const ensure = policy => {
    if (!stats.has(policy)) stats.set(policy, { shadowed: 0, recovered: 0, lit: 0, leak: 0,
      absSum: 0, count: 0, miss: 0 });
    return stats.get(policy);
  };
  for (const sample of band.samples) {
    const ref = refLuma[sample.bandIndex] ?? null;
    if (ref === null) continue;
    const refShadow = ref < threshold;
    // 参考可见度域:luma 线性映射到 [0,1](0.55·亮均值以下 = 0,亮均值 = 1 的软化带)。
    const refVis = Math.max(0, Math.min(1, (ref - 0.35 * brightMean) / (0.65 * brightMean)));
    for (const entry of sample.visibility) {
      const s = ensure(entry.policy);
      const visibility = entry.visibility < 0 ? 1 : entry.visibility;
      if (entry.visibility < 0) s.miss += 1;
      if (refShadow) { s.shadowed += 1; if (visibility < 0.5) s.recovered += 1; }
      else { s.lit += 1; if (visibility < 0.5) s.leak += 1; }
      s.absSum += Math.abs(visibility - refVis);
      s.count += 1;
    }
  }
  const cascadeBright = Object.keys(casLuma).reduce((acc, key) => { const v = casLuma[key]; return v > 0.3 ? acc + v : acc; }, 0);
  void cascadeBright; void brightRef;
  return { thresholdBrightMean: brightMean,
    policies: Object.fromEntries([...stats.entries()].map(([policy, s]) => [policy, {
      samples: s.count, miss: s.miss,
      shadowRecovery: s.shadowed > 0 ? s.recovered / s.shadowed : null,
      litLeak: s.lit > 0 ? s.leak / s.lit : null,
      meanAbsVsRef: s.count > 0 ? s.absSum / s.count : null }])) };
}

async function launchCdpBrowser() {
  const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0",
    "--enable-unsafe-webgpu", "--use-angle=default", "--no-first-run",
    `--user-data-dir=${path.join(out, `chrome-profile-${Date.now()}`)}`, "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] });
  const wsEndpoint = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("chrome devtools endpoint timeout")), 30000);
    chrome.stderr.on("data", chunk => {
      buffer += chunk.toString();
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    chrome.on("exit", () => { clearTimeout(timer); reject(new Error("chrome exited before devtools endpoint")); });
  });
  const wsUrl = new URL(wsEndpoint);
  const targets = await (await fetch(`http://${wsUrl.host}/json/list`)).json();
  const page = targets.find(target => target.type === "page");
  if (!page) throw new Error("no page target in chrome devtools list");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = async event => {
    const text = typeof event.data === "string" ? event.data : await event.data.text();
    if (!text.trim()) return;
    const message = JSON.parse(text);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    chrome, socket,
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description
          ?? result.exceptionDetails.text ?? "evaluate failed");
      }
      return result.result?.value;
    },
    async close() {
      try { socket.close(); } catch { /* already closed */ }
      chrome.kill();
    },
  };
}

let browser;
const result = { error: undefined, executedAt: new Date().toISOString() };
try {
  browser = await launchCdpBrowser();
  await browser.evaluate(`location.href = "http://127.0.0.1:${server.address().port}"`);
  await new Promise(resolve => setTimeout(resolve, 800));
  console.error("[vsm-diag] virtual leg + band policy replay...");
  const flow = await browser.evaluate(FLOW);
  const acceptance = JSON.parse(await readFile(path.join(root, "test-output/vsm-20261003/acceptance.json"), "utf8"));
  const referenceBand = acceptance.legs.referenceImage.image.shadowBand;
  const cascadeBand = acceptance.legs.cascadedImage.image.shadowBand;
  result.desiredHistogram = flow.band.desiredHistogram;
  result.replayedPixels = flow.band.replayedPixels;
  result.residencyCount = flow.residencyCount;
  result.band = flow.band;
  result.score = scorePolicy(flow.band, referenceBand, cascadeBand);
} catch (error) {
  result.error = String(error);
} finally {
  if (browser) await browser.close();
  server.close();
}
await writeFile(path.join(out, "resolve-diag.json"), JSON.stringify(result, null, 1));
console.log(JSON.stringify({ error: result.error, desiredHistogram: result.desiredHistogram,
  replayedPixels: result.replayedPixels, score: result.score }, null, 1));
