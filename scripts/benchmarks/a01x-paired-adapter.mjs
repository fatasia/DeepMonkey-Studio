// a01x 配对产物适配层：把 deep-monkey.a01x-babylon-pairing.v1 轨道的 pass 文件
// （records[].rounds[]，candidate/reference 指标为 camelCase，visualSimilarity 挂在轮级）
// 转换为 scripts/benchmarks/paired-summary.mjs 可消费的 paired-raw 形状
// （rounds[].candidate/reference 的 snake_case 指标字典）。
// 纪律：缺失指标保持缺失（null 原样保留、缺键不补），不虚构任何数值；
// 判定 evaluation=invalid/withheld 翻译为 suppression 显著透传（相似度低于合同
// 下限时排名按合同抑制），pass-1/pass-2 各自独立适配并在 source 标注来源。
//
// 用法：
//   node scripts/benchmarks/a01x-paired-adapter.mjs <pass.json> [--evidence <evidence.json>]
//        [--out <adapted.json>] [--summary <out.md>]
//   --evidence  可选，补充 stability 透传与 referenceVersion（pass 文件本身不带这两项）
//   --out       写适配后 JSON（缺省打印到 stdout）
//   --summary   直连 paired-summary 聚合输出 Markdown（复用 summarizeEvidence，与两步式等价）

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { summarizeEvidence } from "./paired-summary.mjs";

// camelCase → paired-summary 口径（snake_case）的显式映射。只搬聚合指标，
// warmupFrames/drawCalls/cpuStages 等元数据与过程量不进指标表，防止污染报告行。
// longRunFrameP99Ms 仅长稳 pass 的收尾轮携带（其余轮缺键如实缺失），映射到
// bevy 轨道 long-run-frame-p99-ms 同名字段。
const METRIC_MAP = {
  cpuFrameP50Ms: "cpu-frame-p50-ms",
  cpuFrameP95Ms: "cpu-frame-p95-ms",
  cpuFrameP99Ms: "cpu-frame-p99-ms",
  gpuFrameP50Ms: "gpu-frame-p50-ms",
  gpuFrameP95Ms: "gpu-frame-p95-ms",
  gpuFrameP99Ms: "gpu-frame-p99-ms",
  longRunFrameP99Ms: "long-run-frame-p99-ms",
};

// visualSimilarity 是轮级字段，语义为 candidate 画面相对 reference 基准的相似度，
// 注入 candidate 侧；reference 侧不回填（自比恒为 1，无信息量，回填即虚构）。
const VISUAL_SIMILARITY_SOURCE = "visualSimilarity";
const VISUAL_SIMILARITY_METRIC = "visual-similarity";

const formatNumber = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(6) : String(value);

const mapSideMetrics = (sideDict) => {
  const mapped = {};
  for (const [camel, snake] of Object.entries(METRIC_MAP)) {
    if (sideDict && camel in sideDict) mapped[snake] = sideDict[camel]; // null 保留 = 如实缺失
  }
  return mapped;
};

// 判定抑制翻译：status=invalid 或 outcome=withheld 时激活；理由从
// evaluation.benchmark.criteria 的未通过项构造，合同阈值（absoluteMinimum）取自 case.criteria。
const buildSuppression = (record) => {
  const evaluation = record.evaluation;
  if (!evaluation) return null;
  const active = evaluation.status === "invalid" || evaluation.outcome === "withheld";
  if (!active) return null;
  const contract = new Map((record.case?.criteria ?? []).map((item) => [item.metric, item]));
  const reasons = (evaluation.benchmark?.criteria ?? [])
    .filter((item) => item.passed === false)
    .map((item) => {
      const minimum = contract.get(item.metric)?.absoluteMinimum;
      return typeof minimum === "number"
        ? `${item.metric} 中位 ${formatNumber(item.candidateMedian)} 低于合同下限 ${minimum}`
        : `${item.metric} 判定未通过（candidate 中位 ${formatNumber(item.candidateMedian)} vs reference ${formatNumber(item.referenceMedian)}）`;
    });
  return {
    active: true,
    status: evaluation.status ?? null,
    outcome: evaluation.outcome ?? null,
    reasons,
    issues: evaluation.issues ?? [],
  };
};

export function adaptA01xPass(passDoc, options = {}) {
  const { evidenceDoc, passFile } = options;
  if (!passDoc || !Array.isArray(passDoc.records) || passDoc.records.length === 0) {
    throw new Error("pass 文件缺少非空 records[]，不是 a01x 配对 pass 产物。");
  }
  if (passDoc.records.length > 1) {
    throw new Error(`records 含 ${passDoc.records.length} 条 benchmark 记录，当前适配层只支持单 record 的 pass 文件（实际 a01x 每 pass 一条）。`);
  }
  const record = passDoc.records[0];
  const sourceRounds = record.rounds ?? [];
  if (!Array.isArray(sourceRounds) || sourceRounds.length === 0) {
    throw new Error("record.rounds 为空，没有可聚合的配对轮次。");
  }

  const rounds = sourceRounds.map((round) => ({
    round: round.round ?? null,
    candidate: {
      ...mapSideMetrics(round.candidate),
      // 宽松比较覆盖 undefined/null：缺测量不注入；0 是有效测量值，如实透传。
      ...(round[VISUAL_SIMILARITY_SOURCE] == null
        ? {}
        : { [VISUAL_SIMILARITY_METRIC]: round[VISUAL_SIMILARITY_SOURCE] }),
    },
    reference: mapSideMetrics(round.reference),
  }));

  const firstRound = sourceRounds[0];
  return {
    schema: "deep-monkey.a01x-paired-adapter.v1",
    source: {
      passFile: passFile ?? null,
      passSchema: passDoc.schema ?? null,
      passDate: passDoc.date ?? null,
      passBuildSha256: passDoc.buildSha256 ?? null,
      recordAction: record.action ?? null,
      // evidence.json 侧溯源信息（可选）：schema/阶段/源码版本/工作树是否带脏。
      ...(evidenceDoc
        ? {
            evidenceFile: options.evidenceFile ?? null,
            evidenceSchema: evidenceDoc.schema ?? null,
            evidencePhase: evidenceDoc.phase ?? null,
            evidenceSourceRevision: evidenceDoc.source?.revision ?? null,
            evidenceSourceWorkingTreeDirty: evidenceDoc.source?.workingTreeDirty ?? null,
          }
        : {}),
    },
    case: {
      id: record.case?.id ?? null,
      track: record.case?.track ?? null,
      // 引擎名从轮次提取：paired-summary 报告头以 case.reference 标注对手引擎。
      candidateEngine: firstRound.candidate?.engine ?? null,
      reference: firstRound.reference?.engine ?? null,
      referenceVersion: evidenceDoc?.versions?.babylonjs ?? null,
      environmentHash: record.case?.environmentHash ?? null,
      fixtureHash: record.case?.fixtureHash ?? null,
      settingsHash: record.case?.settingsHash ?? null,
    },
    rounds,
    suppression: buildSuppression(record),
    // 稳定性口径如实透传（如 measured=false + 原因），paired-summary 有则展示。
    ...(evidenceDoc?.stability ? { stability: evidenceDoc.stability } : {}),
    // 记录级 processMetrics 原样透传（缺采样不带键）：Chrome 树共享口径——Deep 与
    // Babylon 同页同树渲染，peak/mean 为双侧共享总量，不可按引擎拆分，因此不作轮级
    // 指标注入（防止覆盖度虚标），由 paired-summary 作块级标注。
    ...(record.processMetrics ? { processMetrics: record.processMetrics } : {}),
    // 记录级 longRun 元数据透传（时长/口径/样本量）：表内 long-run-frame-p99 行来自
    // 收尾轮指标映射，这里补充口径说明防止把短跑长稳误读为正式 30 分钟口径。
    ...(record.longRun ? { longRun: record.longRun } : {}),
  };
}

const USAGE = "用法: node scripts/benchmarks/a01x-paired-adapter.mjs <pass.json> [--evidence <evidence.json>] [--out <adapted.json>] [--summary <out.md>]";

const parseArgs = (argv) => {
  const parsed = { positional: [] };
  const withValue = new Set(["--evidence", "--out", "--summary"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (withValue.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} 需要一个文件路径参数。`);
      parsed[arg.slice(2)] = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`未知参数 ${arg}。`);
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
};

const readJson = async (file, label) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`读取/解析${label}失败: ${file}\n${error.message}`);
  }
};

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exit(2);
  }
  const [passFile] = args.positional;
  if (!passFile) {
    console.error(USAGE);
    process.exit(2);
  }
  const passDoc = await readJson(passFile, "pass 文件");
  const evidenceDoc = args.evidence ? await readJson(args.evidence, "evidence 文件") : null;
  let adapted;
  try {
    adapted = adaptA01xPass(passDoc, { evidenceDoc, passFile, evidenceFile: args.evidence });
  } catch (error) {
    console.error(`适配失败: ${error.message}`);
    process.exit(1);
  }

  const adaptedJson = `${JSON.stringify(adapted, null, 2)}\n`;
  if (args.out) {
    await writeFile(args.out, adaptedJson, "utf8");
    console.log(`适配后 JSON 已写入 ${args.out}`);
  } else if (!args.summary) {
    process.stdout.write(adaptedJson);
  }
  if (args.summary) {
    await writeFile(args.summary, `${summarizeEvidence(adapted, passFile)}\n`, "utf8");
    console.log(`聚合报告已写入 ${args.summary}`);
  }
}

// 直接执行时跑 CLI；被其他脚本 import（复用 adaptA01xPass）时不触发。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
