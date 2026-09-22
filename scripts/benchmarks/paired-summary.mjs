import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// V4 配对采样聚合统计（仓内可复跑）：吃 Bevy/对手配对 harness 产出的
// paired-evidence.json，跨轮汇总 CPU/GPU 帧时分位数与指标覆盖度，
// 输出 Markdown 报告。缺失指标（null）如实标记"未采集"，不虚构分位数。
// 用法：node scripts/benchmarks/paired-summary.mjs <paired-evidence.json> [out.md]

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error("用法: node scripts/benchmarks/paired-summary.mjs <paired-evidence.json> [out.md]");
  process.exit(2);
}

const evidence = JSON.parse(await readFile(input, "utf8"));
const rounds = evidence.rounds ?? [];
if (!Array.isArray(rounds) || rounds.length === 0) {
  console.error("paired-evidence 缺少 rounds 样本，无法聚合。");
  process.exit(1);
}

const percentile = (values, fraction) => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index), high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
};

// 逐指标收集：candidate/reference 各自跨轮取分位数；null 记入 coverage 缺失。
const METRICS = [
  "cpu-frame-p50-ms", "cpu-frame-p95-ms", "cpu-frame-p99-ms",
  "gpu-frame-p50-ms", "gpu-frame-p95-ms", "gpu-frame-p99-ms",
  "frame-p99-ms", "input-latency-p95-ms", "cold-start-ms", "load-to-interactive-ms",
];

const summarize = (side) => {
  const summary = { samples: {}, missing: {} };
  for (const metric of METRICS) {
    const values = rounds.map(round => round[side]?.[metric]).filter(value => typeof value === "number" && Number.isFinite(value));
    if (values.length === 0) {
      summary.missing[metric] = rounds.length;
      continue;
    }
    summary.samples[metric] = {
      rounds: values.length,
      median: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      max: values[values.length - 1],
    };
  }
  return summary;
};

const candidate = summarize("candidate");
const reference = summarize("reference");
const caseInfo = evidence.case ?? {};

const row = (metric) => {
  const cell = (summary) => {
    const sample = summary.samples[metric];
    return sample
      ? `${sample.median.toFixed(3)} / ${sample.p95.toFixed(3)} (${sample.rounds}轮)`
      : "未采集";
  };
  return `| ${metric} | ${cell(candidate)} | ${cell(reference)} |`;
};

const lines = [
  "# 配对采样聚合报告（仓内可复跑）",
  "",
  `- 输入: \`${input}\``,
  `- case: \`${caseInfo.id ?? "unknown"}\`（track=${caseInfo.track ?? "?"}, reference=${caseInfo.reference ?? "?"} ${caseInfo.referenceVersion ?? ""}）`,
  `- 轮数: ${rounds.length}；fixtureHash=${caseInfo.fixtureHash?.slice(0, 12) ?? "?"} settingsHash=${caseInfo.settingsHash?.slice(0, 12) ?? "?"}`,
  `- 口径: 表内为 跨轮中位数 / P95（样本轮数）；缺失指标如实标"未采集"，不虚构。`,
  "",
  "| 指标 | candidate (Deep) | reference (对手) |",
  "|---|---|---|",
  ...METRICS.map(row),
  "",
  "## 指标覆盖度缺口",
  "",
  ...Object.entries(candidate.missing).map(([metric, roundsMissing]) =>
    `- \`${metric}\`: candidate ${roundsMissing}/${rounds.length} 轮缺失`),
  ...Object.entries(reference.missing).map(([metric, roundsMissing]) =>
    `- \`${metric}\`: reference ${roundsMissing}/${rounds.length} 轮缺失`),
];

const report = lines.join("\n");
if (output) {
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, `${report}\n`, "utf8");
  console.log(`报告已写入 ${output}`);
} else {
  console.log(report);
}
