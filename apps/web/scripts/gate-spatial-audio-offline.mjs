import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

// T29 空间音频离线渲染门禁:在真实 Chrome 的 OfflineAudioContext 中渲染固定场景,
// 断言 inverse 距离增益包络、告警启停包络、方位定位、构造/释放无残留。
// 依赖 Vite dev server(pnpm --filter @bim-studio/web dev)提供 /@fs/ TS 变换端点,
// 生产代码零拷贝直测(模式同 deep-gpu-stage-smoke.mjs)。

const origin = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5173";
const auditModuleUrl = `/@fs/${fileURLToPath(new URL("../src/audio/offlineAudioAudit.ts", import.meta.url)).replaceAll("\\", "/")}`;
const output = fileURLToPath(new URL("../../../test-output/spatial-audio-offline/", import.meta.url));
await mkdir(output, { recursive: true });

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});

let report;
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.goto(`${origin}/dev/engine.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch {
    console.error(`[gate-spatial-audio] 无法访问 ${origin}:请先启动 pnpm --filter @bim-studio/web dev`);
    process.exit(2);
  }
  report = await page.evaluate(async (moduleUrl) => {
    const audit = await import(moduleUrl);
    return audit.runOfflineAudioAudit({ leakCycles: 500 });
  }, auditModuleUrl);
  if (pageErrors.length) {
    report.passed = false;
    report.failures.push(...pageErrors.map((message) => `pageerror: ${message}`));
  }
} finally {
  await browser.close();
}

assert.equal(report.schema, "deep-monkey.spatial-audio-offline-audit.v1");
const lines = [
  "# T29 空间音频离线渲染审计(Chrome OfflineAudioContext)",
  "",
  `- userAgent: ${report.userAgent}`,
  `- sampleRate: ${report.sampleRate} Hz;增益断言容差 ±${(report.tolerance * 100).toFixed(0)}%`,
  `- 总判定: ${report.passed ? "PASS" : "FAIL"}`,
  "",
  "## 距离增益包络(ref=2m, rolloff=1, equalpower)",
  "",
  "| 场景 | 距离 | 期望增益 | 实测增益 | 相对误差 | 判定 |",
  "|---|---|---|---|---|---|",
  ...report.distanceCases.map((item) =>
    `| ${item.label} | ${item.distance}m | ${item.expectedGain.toFixed(4)} | ${item.measuredGain.toFixed(4)} | ${(item.relativeError * 100).toFixed(2)}% | ${item.passed ? "PASS" : "FAIL"} |`),
  "",
  `- 静音: 期望 ${report.muteCase.expectedGain}, 实测 ${report.muteCase.measuredGain.toExponential(3)} → ${report.muteCase.passed ? "PASS" : "FAIL"}`,
  `- 告警启停: 0–0.7s RMS=${report.alarmEnvelope.loudRms.toFixed(5)}, 0.8s 计划停止后 0.9–2s RMS=${report.alarmEnvelope.afterStopRms.toExponential(3)} → ${report.alarmEnvelope.passed ? "PASS" : "FAIL"}`,
  `- 方位定位: 声源 -X(左) L RMS=${report.direction.leftRms.toFixed(5)} / R RMS=${report.direction.rightRms.toFixed(5)}(比值 ${report.direction.ratio.toFixed(3)}) → ${report.direction.passed ? "PASS" : "FAIL"}`,
  `- 泄漏: ${report.leak.cycles} 轮 build/dispose, 残留 ${report.leak.residualGraphs} → ${report.leak.passed ? "PASS" : "FAIL"}`,
  "",
  "## 说明",
  "",
  ...report.notes.map((note) => `- ${note}`),
  "",
];
if (report.failures.length) {
  lines.push("## 失败项", "", ...report.failures.map((item) => `- ${item}`), "");
}
await writeFile(`${output}audit.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(`${output}audit.md`, lines.join("\n"), "utf8");
console.log(lines.join("\n"));
if (!report.passed) process.exit(1);
