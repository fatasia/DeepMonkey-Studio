import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * VSM 门①口径裁决 runner(2026-10-05,用户拍板"固定档级联基线"重测):
 * 自适应品质级联基线下任何机位都保持 texel≈像素,门① corner-ratio 无可区分对
 * (验收报告 docs/specs/ue-class-b2-vsm-m2-acceptance-20261004.md 门①口径说明)。
 * 本 runner 把级联腿钉在固定低档(beginLeg options.shadows,探针参数化,不在场景硬编码),
 * 让基线真实呈现图受限锯齿,再按同机位×同口径出数定门。
 *
 * 腿(同场景同光照,近景 VIEW / 远景 VIEW_FAR;每组合 5 组采样 + 1 张 PNG 证据):
 *   cascadedFixed{Near,Far}  requestedTier 钉档级联(默认 performance = 2×1024/0.65/0.12)
 *   virtual{Near,Far}        VSM(页级驻留,无档位)
 *   {cascadedFixed,virtual}{Near,Far}Ssaa  4×SSAA 参考腿(2× 渲染 + 2×2 box 还原)
 * 备选口径:分辨率敏感度 = 1× 边缘能量 / 4×SSAA 参考边缘能量(锯齿来源判别)。
 *
 * 档位选择(CLI,可选):`node scripts/vsm-gate1-fixed-tier.mjs [tier=<name>|exact=<mapSize>]`
 *   缺省 tier=performance;基线锯齿不显著时按验收裁决调低档重跑(如 exact=512)。
 * 证据:test-output/vsm-gate1-fixed-tier/gate1.json + leg-*.png。
 */

const root = fileURLToPath(new URL("../", import.meta.url));

const argv = process.argv[2] ?? "";
const tierMatch = argv.match(/^tier=(\w+)$/);
const exactMatch = argv.match(/^exact=(\d+)$/);
const pinSuffix = tierMatch ? `tier-${tierMatch[1]}` : exactMatch ? `exact-${exactMatch[1]}` : "tier-performance";
const out = path.join(root, "test-output/vsm-gate1-fixed-tier", pinSuffix);
await mkdir(out, { recursive: true });

/** 固定档钉法参数:requestedTier(exactProfile 互斥)或 exactProfile mapSize,探针透传。 */
const fixedShadows = tierMatch ? { requestedTier: tierMatch[1] }
  : exactMatch ? { exactProfile: { cascadeCount: 1, shadowMapSize: Number(exactMatch[1]) } }
  : { requestedTier: "performance" };
const pinLabel = fixedShadows.requestedTier !== undefined
  ? `requestedTier=${fixedShadows.requestedTier}`
  : `exactProfile=${fixedShadows.exactProfile.shadowMapSize}px`;

const require = createRequire(import.meta.url);
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/virtualShadowGpuProbe.ts")],
  outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser" });
const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const server = createServer(async (request, response) => {
  if (request.url === "/probe.mjs") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(await readFile(path.join(out, "probe.mjs")));
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<html><head><meta charset="utf-8"><style>${css}</style></head>`
      + `<body style="padding:24px;background:var(--bg-0);color:var(--text-strong)">`
      + `<h1>VSM 门①口径裁决(固定档级联基线)</h1><div id="results"></div></body></html>`);
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

/** 门①腿模板:settle → 5 组采样 → PNG 证据 captureStill → 结腿。SSAA 腿走 captureStillSsaa,
 *  并与同机位 1× 腿的 shadowBand 在页内配对差分(CDP returnByValue 会把 Float32Array
 *  序列化成无 length 的对象,node 侧差分不可行,只回传数字)。 */
const LEGS_FLOW = `(async () => {
    const probe = await import("/probe.mjs");
    const output = { adapter: await probe.probeAdapterInfo(), legs: {} };
    const pin = ${JSON.stringify(fixedShadows)};
    const bandOf = new Map();
    const sampleLeg = async (name, mode, shadows, supersample) => {
      await probe.beginLeg(mode, true, { ...(shadows ? { shadows } : {}), ...(supersample === 2 ? { supersample } : {}) });
      await probe.settleLeg();
      const samples = supersample === 2 ? undefined : await probe.captureEdgeSamples(5);
      const ssaa = supersample === 2 ? await probe.captureStillSsaa() : undefined;
      const still = supersample === 2 ? undefined : await probe.captureStill();
      const leg = await probe.finishLeg({ p50Ms: 0, p95Ms: 0, samples: 0 },
        supersample === 2 ? undefined : still, undefined, samples);
      if (ssaa) {
        leg.ssaaCanvasPng = ssaa.canvasPng;
        const oneX = bandOf.get(name.replace(/Ssaa$/, ""));
        if (oneX === undefined) leg.ssaaDelta = "oneX-band-missing";
        else {
          const delta = probe.meanAbsDiff(oneX, ssaa.band);
          leg.ssaaDelta = Number.isFinite(delta) ? delta : "non-finite:" + String(delta);
          leg.ssaaDiag = { oneXW: oneX.width, oneXH: oneX.height, ssaaW: ssaa.band.width, ssaaH: ssaa.band.height };
        }
      } else {
        bandOf.set(name, still.shadowBand);
      }
      output.legs[name] = leg;
      return leg;
    };
    // 近景(corner 机位)
    await sampleLeg("cascadedFixedNear", "cascaded", pin, 1);
    await sampleLeg("virtualNear", "virtual", undefined, 1);
    // 远景机位(基线覆盖扩大 → split texel 超过像素足迹 → 图受限锯齿)
    await probe.setActiveView(probe.VIEW_FAR);
    await sampleLeg("cascadedFixedFar", "cascaded", pin, 1);
    await sampleLeg("virtualFar", "virtual", undefined, 1);
    // 4×SSAA 参考腿(2× 渲染 + 2×2 box 还原,同测区口径;与同机位 1× band 页内配对)
    await sampleLeg("cascadedFixedNearSsaa", "cascaded", pin, 2);
    await sampleLeg("virtualNearSsaa", "virtual", undefined, 2);
    await sampleLeg("cascadedFixedFarSsaa", "cascaded", pin, 2);
    await sampleLeg("virtualFarSsaa", "virtual", undefined, 2);
    await probe.setActiveView(probe.VIEW);
    return output;
  })()`;

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

/** 5 组采样统计:均值/中位/极差(cornerRatio 与边界长度都要,防"均值被空测区洗白")。 */
function sampleStats(samples) {
  const ratios = samples.map(s => s.cornerRatio).sort((a, b) => a - b);
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return {
    cornerRatioMean: mean,
    cornerRatioMedian: ratios[Math.floor(ratios.length / 2)] ?? 0,
    cornerRatioMin: ratios[0] ?? 0,
    cornerRatioMax: ratios[ratios.length - 1] ?? 0,
    boundaryPixelsMean: Math.round(samples.reduce((a, s) => a + s.boundaryPixels, 0) / samples.length),
    cornerPixelsMean: Math.round(samples.reduce((a, s) => a + s.cornerPixels, 0) / samples.length),
    shadowPixelsMean: Math.round(samples.reduce((a, s) => a + s.shadowPixels, 0) / samples.length),
    samples: samples.length,
  };
}

let browser;
const result = { pin: pinLabel, shadows: fixedShadows, adapter: undefined, legs: {}, gate: undefined,
  error: undefined, executedAt: new Date().toISOString() };
try {
  browser = await launchCdpBrowser();
  await browser.evaluate(`location.href = "http://127.0.0.1:${server.address().port}"`);
  await new Promise(resolve => setTimeout(resolve, 800));
  console.error("[gate1] legs flow start...");
  await browser.evaluate(`(async () => {
    const probe = await import("/probe.mjs");
    probe.installErrorCapture();
  })()`);
  const legs = await browser.evaluate(LEGS_FLOW);
  console.error("[gate1] legs flow done");
  result.adapter = legs.adapter;
  // PNG 证据落盘(整帧 + 测区裁剪;SSAA 腿整帧走 ssaaCanvasPng)。
  for (const [name, leg] of Object.entries(legs.legs)) {
    for (const [kind, key] of [["leg", "image.canvasPng"], ["crop", "image.cropPng"], ["ssaa", "ssaaCanvasPng"]]) {
      const png = key.split(".").reduce((node, k) => node?.[k], leg);
      if (typeof png === "string" && png.startsWith("data:image/png")) {
        await writeFile(path.join(out, `${kind}-${name}.png`), Buffer.from(png.split(",")[1], "base64"));
      }
    }
  }
  // JSON 只留采样统计与轻量字段,canvasPng/cropPng/shadowBand 剥离(PNG 已落盘)。
  for (const [name, leg] of Object.entries(legs.legs)) {
    result.legs[name] = {
      mode: leg.mode,
      edgeSamples: leg.edgeSamples ?? undefined,
      edgeSamplesStats: leg.edgeSamples ? sampleStats(leg.edgeSamples) : undefined,
      stillEdge: leg.image?.edge ?? undefined,
      holes: leg.image?.holes ?? undefined,
      ssaaDelta: leg.ssaaDelta ?? undefined,
      ssaaCanvasPng: typeof leg.ssaaCanvasPng === "string" ? "saved" : undefined,
    };
  }
  await writeFile(path.join(out, "leg-raw-digest.json"), JSON.stringify(Object.fromEntries(
    Object.entries(legs.legs).map(([name, leg]) => [name, {
      mode: leg.mode, edgeSamples: leg.edgeSamples, stillEdge: leg.image?.edge,
      ssaaDelta: leg.ssaaDelta ?? null,
    }])), null, 2));

  // ---- 门①两口径判定 ----
  const mean = leg => result.legs[leg]?.edgeSamplesStats?.cornerRatioMean;
  const farBaseline = mean("cascadedFixedFar"), farVirtual = mean("virtualFar");
  const nearBaseline = mean("cascadedFixedNear"), nearVirtual = mean("virtualNear");
  const ratioNear = nearBaseline > 0 ? nearVirtual / nearBaseline : null;
  const ratioFar = farBaseline > 0 ? farVirtual / farBaseline : null;
  // 基线有效性:固定档远景基线锯齿能量须显著高于 VSM(≥1.5×)且自身非零测
  // (cornerRatio ≥ 0.01、边界像素 ≥ 200,防"边界空集伪零"复发 —— B1 教训)。
  const boundaryFar = result.legs.cascadedFixedFar?.edgeSamplesStats?.boundaryPixelsMean ?? 0;
  const baselineSignificant = farBaseline !== undefined && farVirtual !== undefined
    && farBaseline >= 0.01 && boundaryFar >= 200 && farBaseline >= 1.5 * farVirtual;
  const gate1 = (ratio, baselineOk) => {
    if (!baselineOk) return { status: "inconclusive", reason: "fixed-tier baseline aliasing not significant under corner-ratio: PCF-linear softens image-limited texel stairs into gradients, and a thresholded mask scores soft and hard edges alike (measured 2026-10-05, both tiers identical)" };
    if (ratio === null) return { status: "inconclusive", reason: "baseline cornerRatio is zero (empty edge set)" };
    return ratio <= 0.40 ? { status: "pass", reason: `virtual/baseline = ${ratio.toFixed(4)} ≤ 0.40 (↓≥60%)` }
      : { status: "fail", reason: `virtual/baseline = ${ratio.toFixed(4)} > 0.40` };
  };
  // 备选(分辨率敏感)口径:delta = |1× 渲染 − 4×SSAA 参考| 测区亮度均值 = 锯齿成分能量
  // (delta 挂在各 pose 的 *Ssaa 腿上)。显著性地板:远景两腿 delta 实测 ~3e-4
  // (渐变边对 SSAA 不敏感),取 0.001(≈3× 地板)为显著线。
  const deltaOf = leg => result.legs[`${leg}Ssaa`]?.ssaaDelta;
  const deltaGate = (pose, base, virt) => {
    if (typeof base !== "number" || typeof virt !== "number") return { status: "inconclusive", reason: "delta missing" };
    if (base < 0.001) return { status: "inconclusive", reason: "baseline delta at noise floor (gradient edges, SSAA-insensitive)" };
    const ratio = virt / base;
    return ratio <= 0.40 ? { status: "pass", reason: `virtual/baseline = ${ratio.toFixed(4)} ≤ 0.40 (↓≥60%)` }
      : { status: "fail", reason: `virtual/baseline = ${ratio.toFixed(4)} > 0.40` };
  };
  const deltaNearBase = deltaOf("cascadedFixedNear"), deltaNearVirt = deltaOf("virtualNear");
  const deltaFarBase = deltaOf("cascadedFixedFar"), deltaFarVirt = deltaOf("virtualFar");
  result.gate = {
    "①a corner-ratio near pose (fixed-tier baseline)": {
      baseline: nearBaseline, virtual: nearVirtual, ratio: ratioNear, ...gate1(ratioNear, true) },
    "①b corner-ratio far pose (fixed-tier baseline, adjudication gate)": {
      baseline: farBaseline, virtual: farVirtual, ratio: ratioFar, ...gate1(ratioFar, baselineSignificant) },
    "baselineValidity(far, corner-ratio)": { baselineCornerRatioMean: farBaseline, baselineBoundaryPixelsMean: boundaryFar,
      virtualCornerRatioMean: farVirtual, significant: baselineSignificant },
    "①-alt resolution-sensitivity near pose (1x vs 4xSSAA delta)": {
      baselineDelta: deltaNearBase, virtualDelta: deltaNearVirt,
      ratio: deltaNearBase > 0 ? deltaNearVirt / deltaNearBase : null,
      ...deltaGate("near", deltaNearBase, deltaNearVirt) },
    "①-alt resolution-sensitivity far pose (1x vs 4xSSAA delta)": {
      baselineDelta: deltaFarBase, virtualDelta: deltaFarVirt,
      ratio: deltaFarBase > 0 ? deltaFarVirt / deltaFarBase : null,
      ...deltaGate("far", deltaFarBase, deltaFarVirt) },
  };
} catch (error) {
  result.error = String(error);
} finally {
  try {
    result.capturedErrors = await browser.evaluate("({ errors: window.__vsmErrors ?? [], hasFlag: Boolean(window.__vsmErrors) })");
  } catch (captureError) { result.captureError = String(captureError); }
  if (browser) await browser.close();
  server.close();
}
await writeFile(path.join(out, "gate1.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ pin: pinLabel, gate: result.gate, error: result.error }, null, 2));
