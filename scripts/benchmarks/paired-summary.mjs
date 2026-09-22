import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// V4 配对采样聚合统计（仓内可复跑）：吃配对 harness 产出的 paired-evidence，
// 跨轮汇总 CPU/GPU 帧时分位数与指标覆盖度，输出 Markdown 报告。
// 缺失指标（null）如实标记"未采集"，不虚构分位数。
// 用法：node scripts/benchmarks/paired-summary.mjs <paired-evidence.json> [out.md]
// 亦可被 a01x-paired-adapter.mjs import（summarizeEvidence）直连聚合：适配后的
// a01x 输入可带 suppression/stability/额外指标（visual-similarity）字段，有则透出，
// 无则输出与 bevy 轨道完全一致，不改变既有格式。

// 基础指标口径（bevy 轨道）；适配层注入的额外指标按首轮出现顺序追加在表尾。
const BASE_METRICS = [
  "cpu-frame-p50-ms", "cpu-frame-p95-ms", "cpu-frame-p99-ms",
  "gpu-frame-p50-ms", "gpu-frame-p95-ms", "gpu-frame-p99-ms",
  "frame-p99-ms", "input-latency-p95-ms", "cold-start-ms", "load-to-interactive-ms",
];

const percentile = (values, fraction) => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index), high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
};

// 判定抑制标注：evaluation=invalid/withheld（如视觉相似度低于合同下限）时，
// 排名按合同抑制，必须在报告首屏显著可见，防止把被抑制的指标误读为胜出证据。
const suppressionLines = (suppression) => {
  if (!suppression?.active) return [];
  const lines = [
    `> **【判定抑制】evaluation=${suppression.status ?? "?"} / outcome=${suppression.outcome ?? "?"} —— 排名按合同抑制，下列指标不得用于宣称领先。**`,
  ];
  for (const reason of suppression.reasons ?? []) lines.push(`> - 理由：${reason}`);
  for (const issue of suppression.issues ?? []) lines.push(`> - issues: ${issue}`);
  lines.push("");
  return lines;
};

// 稳定性口径透传：a01x 适配输入可带 stability（如双轮未测），bevy 输入无此字段则不输出。
const stabilityLines = (stability) => {
  if (!stability) return [];
  return [stability.measured ? "- 稳定性: 已测量" : `- 稳定性: 未测量${stability.reason ? `（${stability.reason}）` : ""}`];
};

const formatBytes = (value) =>
  typeof value === "number" && Number.isFinite(value) ? `${(value / 1048576).toFixed(1)} MB` : "未采集";

// 进程内存口径透传（a01x 适配输入可带 processMetrics，bevy 输入无此字段则不输出）：
// Chrome 树共享口径——双引擎同页同树渲染，peak/mean 是双侧共享总量、不可按引擎拆分，
// 因此作块级标注而非轮级指标行，防止把共享总量误读成单引擎占用或覆盖度虚标。
const processMetricsLines = (processMetrics) => {
  if (!processMetrics?.sampled) return [];
  const lines = [`- 进程内存（Chrome 树，双引擎同树共享，不可按引擎拆分）: peak-host ${formatBytes(processMetrics.peakHostBytes)} · mean-host ${formatBytes(processMetrics.meanHostBytes)} · peak-gpu ${formatBytes(processMetrics.peakGpuBytes)}（${processMetrics.sampleCount ?? "?"} 样本 @ ${processMetrics.sampleIntervalMilliseconds ?? "?"}ms）`];
  if (processMetrics.gpuCounterError) lines.push(`  - GPU 计数器未产出: ${processMetrics.gpuCounterError}`);
  if (processMetrics.samplerError) lines.push(`  - 采样器异常: ${processMetrics.samplerError}`);
  return lines;
};

// 长稳口径透传（a01x 适配输入可带 longRun）：表内 long-run-frame-p99 行只出现在收尾轮，
// 这里补充时长与采样口径，防止把短跑长稳误读为正式 30 分钟口径。
const longRunLines = (longRun) => {
  if (!longRun) return [];
  return [`- 长稳: long-run ${longRun.minutes} 分钟/引擎（${longRun.sampleMode} 口径）；30 分钟为正式 V4 口径`];
};

export function summarizeEvidence(evidence, inputLabel) {
  const rounds = evidence.rounds ?? [];
  if (!Array.isArray(rounds) || rounds.length === 0) {
    throw new Error("paired-evidence 缺少 rounds 样本，无法聚合。");
  }
  // 额外指标：不在基础口径、但适配层注入的指标（如 a01x visual-similarity），
  // 按首轮出现顺序追加表尾；bevy 轨道无额外指标，表格与既有输出完全一致。
  const extraMetrics = [...new Set(rounds.flatMap((round) => [
    ...Object.keys(round.candidate ?? {}),
    ...Object.keys(round.reference ?? {}),
  ]))].filter((metric) => !BASE_METRICS.includes(metric));
  const metrics = [...BASE_METRICS, ...extraMetrics];

  // 逐指标收集：candidate/reference 各自跨轮取分位数；null 记入 coverage 缺失。
  const summarize = (side) => {
    const summary = { samples: {}, missing: {} };
    for (const metric of metrics) {
      const values = rounds.map((round) => round[side]?.[metric]).filter((value) => typeof value === "number" && Number.isFinite(value));
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
    ...suppressionLines(evidence.suppression),
    `- 输入: \`${inputLabel}\``,
    `- case: \`${caseInfo.id ?? "unknown"}\`（track=${caseInfo.track ?? "?"}, reference=${caseInfo.reference ?? "?"} ${caseInfo.referenceVersion ?? ""}）`,
    `- 轮数: ${rounds.length}；fixtureHash=${caseInfo.fixtureHash?.slice(0, 12) ?? "?"} settingsHash=${caseInfo.settingsHash?.slice(0, 12) ?? "?"}`,
    `- 口径: 表内为 跨轮中位数 / P95（样本轮数）；缺失指标如实标"未采集"，不虚构。`,
    ...stabilityLines(evidence.stability),
    ...processMetricsLines(evidence.processMetrics),
    ...longRunLines(evidence.longRun),
    "",
    "| 指标 | candidate (Deep) | reference (对手) |",
    "|---|---|---|",
    ...metrics.map(row),
    "",
    "## 指标覆盖度缺口",
    "",
    ...Object.entries(candidate.missing).map(([metric, roundsMissing]) =>
      `- \`${metric}\`: candidate ${roundsMissing}/${rounds.length} 轮缺失`),
    ...Object.entries(reference.missing).map(([metric, roundsMissing]) =>
      `- \`${metric}\`: reference ${roundsMissing}/${rounds.length} 轮缺失`),
  ];
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const [input, output] = argv;
  if (!input) {
    console.error("用法: node scripts/benchmarks/paired-summary.mjs <paired-evidence.json> [out.md]");
    process.exit(2);
  }

  let evidence;
  try {
    evidence = JSON.parse(await readFile(input, "utf8"));
  } catch (error) {
    console.error(`读取/解析输入失败: ${input}\n${error.message}`);
    process.exit(1);
  }

  let report;
  try {
    report = summarizeEvidence(evidence, input);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  if (output) {
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await writeFile(output, `${report}\n`, "utf8");
    console.log(`报告已写入 ${output}`);
  } else {
    console.log(report);
  }
}

// 直接执行时跑 CLI；被 a01x-paired-adapter.mjs import（复用 summarizeEvidence）时不触发。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
