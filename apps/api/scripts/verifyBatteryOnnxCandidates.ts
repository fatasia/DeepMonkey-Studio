import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseCsv } from "csv-parse/sync";
import type {
  BatteryOnnxEquivalenceManifest,
  FormalBatteryPrimaryModelId,
} from "@bim-studio/contracts";
import type {
  BatteryOnnxDeployment,
  BatteryOnnxModelDeployment,
} from "../src/batteryOnnxDeployment.js";
import type {
  BatteryPredictionInput,
  FormalBatteryModel,
} from "../src/batteryModelGateway.js";
import { BatteryProductionOnnxRuntime } from "../src/batteryProductionOnnxRuntime.js";

interface CandidateModelResult {
  modelId: FormalBatteryPrimaryModelId;
  passed: boolean;
}

interface CandidateReport {
  schemaVersion: 1;
  passed: boolean;
  models: CandidateModelResult[];
}

const argumentsByName = parseArguments(process.argv.slice(2));
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const artifactRoot = resolveInputPath(
  argumentsByName.get("artifact-root") ?? "test-output/battery-onnx",
);
const reportFile = resolve(artifactRoot, "candidate-report.json");
const manifestsFile = resolve(artifactRoot, "candidate-manifests.json");
const requestedRecordFile = argumentsByName.get("record-file");
if (!requestedRecordFile) throw new Error("请用 --record-file 显式指定本项目的电池 CSV 文件");
const recordFile = resolveInputPath(requestedRecordFile);

/** pnpm --filter 会把 cwd 切到包目录；命令行相对路径仍按仓库根解释，和 README 示例保持一致。 */
function resolveInputPath(value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(repositoryRoot, value);
}
const candidate = JSON.parse(
  await readFile(reportFile, "utf8"),
) as CandidateReport;
const manifests = JSON.parse(
  await readFile(manifestsFile, "utf8"),
) as BatteryOnnxEquivalenceManifest[];
if (!candidate.passed || candidate.models.length !== 3) {
  throw new Error("候选报告未覆盖并通过三个正式模型");
}
if (manifests.length !== 3) throw new Error("候选清单未覆盖三个正式模型");

const records = parseCsv(await readFile(recordFile, "utf8"), {
  columns: true,
  skip_empty_lines: true,
  bom: true,
}) as Array<Record<string, string>>;
if (records.length === 0) throw new Error("业务回放文件没有记录");

// 候选验证器只复用身份与运行合同，不伪造 production-approved 批准结论。
const deployment = await createCandidateDeployment(
  candidate,
  manifests,
  artifactRoot,
);
const runtime = new BatteryProductionOnnxRuntime(deployment);
const firstCycle = records[0]?.cycle;
const socRecords = records.filter((record) => record.cycle === firstCycle);
const inputs: BatteryPredictionInput[] = [
  {
    model: "bmsformer",
    fileName: basename(recordFile),
    records,
    chemistry: "lfp",
  },
  {
    model: "socformer",
    fileName: basename(recordFile),
    records: socRecords,
    nominalCapacityAh: numeric(
      records[0]?.nominalCapacityAh,
      "nominalCapacityAh",
    ),
    chemistry: "lfp",
  },
  {
    model: "batterymformer",
    fileName: basename(recordFile),
    records,
    chemistry: "lfp",
    targetCapacityRetention: 80,
  },
];

const results = [];
for (const input of inputs) {
  const startedAt = performance.now();
  const output = await runtime.predict(input);
  const latencyMs = performance.now() - startedAt;
  validateOutput(input.model, output, socRecords.length);
  results.push({
    model: input.model,
    latencyMs: Number(latencyMs.toFixed(2)),
    summary: summarize(input.model, output),
  });
  console.log(`[battery-node] ${input.model} · ${latencyMs.toFixed(1)}ms`);
}

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  decisionStatus: "candidate-node-runtime",
  productionApproved: false,
  recordFile: basename(recordFile),
  recordCount: records.length,
  passed: true,
  models: results,
};
await writeFile(
  resolve(artifactRoot, "candidate-node-runtime-report.json"),
  `${JSON.stringify(result, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(result, null, 2));

async function createCandidateDeployment(
  report: CandidateReport,
  manifests: BatteryOnnxEquivalenceManifest[],
  root: string,
): Promise<BatteryOnnxDeployment> {
  const deployments: Partial<
    Record<FormalBatteryModel, BatteryOnnxModelDeployment>
  > = {};
  for (const manifest of manifests) {
    const evidence = report.models.find(
      (model) => model.modelId === manifest.modelId,
    );
    if (!evidence?.passed)
      throw new Error(`${manifest.modelId} 候选验证未通过`);
    if (
      manifest.approval.decisionStatus !== "candidate" ||
      manifest.approval.independentDatasetSplit ||
      manifest.approval.externalLockboxCases !== 0
    ) {
      throw new Error(`${manifest.modelId} 候选工具不接受伪造的生产批准状态`);
    }
    const artifactPath = resolve(root, manifest.artifact.fileName);
    const runtimeAdapterPath = resolve(root, manifest.runtimeAdapter.fileName);
    await Promise.all([
      verifyFile(
        artifactPath,
        manifest.artifact.sizeBytes,
        manifest.artifact.sha256,
      ),
      verifyFile(
        runtimeAdapterPath,
        manifest.runtimeAdapter.sizeBytes,
        manifest.runtimeAdapter.sha256,
      ),
    ]);
    const shortId = manifest.modelId.replace(
      "battery.",
      "",
    ) as FormalBatteryModel;
    deployments[shortId] = {
      artifactPath,
      runtimeAdapterPath,
      manifest,
    };
  }
  return {
    enabled: true,
    artifactRoot: root,
    requestedModels: ["bmsformer", "socformer", "batterymformer"],
    manifests,
    models: deployments,
    diagnostics: ["候选工具运行时；不进入生产配置"],
  };
}

async function verifyFile(
  path: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<void> {
  const information = await stat(path);
  if (!information.isFile() || information.size !== expectedBytes) {
    throw new Error(`候选制品体积不一致：${basename(path)}`);
  }
  const digest = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  if (digest !== expectedSha256.toLowerCase()) {
    throw new Error(`候选制品哈希不一致：${basename(path)}`);
  }
}

function validateOutput(
  model: FormalBatteryModel,
  output: Record<string, unknown>,
  socSamples: number,
): void {
  if (model === "bmsformer") {
    finite(output.currentSoh, "BMSFormer currentSoh");
    return;
  }
  if (model === "socformer") {
    finite(output.finalSoc, "SOCFormer finalSoc");
    if (!Array.isArray(output.points) || output.points.length !== socSamples) {
      throw new Error("SOCFormer 输出点数与输入记录不一致");
    }
    return;
  }
  finite(output.predictedCycleLife, "BatteryMFormer predictedCycleLife");
  if (!Array.isArray(output.sohCurve) || output.sohCurve.length < 10) {
    throw new Error("BatteryMFormer SOH 轨迹无效");
  }
}

function summarize(
  model: FormalBatteryModel,
  output: Record<string, unknown>,
): Record<string, unknown> {
  if (model === "bmsformer") {
    return { currentSoh: output.currentSoh, confidence: output.confidence };
  }
  if (model === "socformer") {
    return {
      initialSoc: output.initialSoc,
      finalSoc: output.finalSoc,
      points: Array.isArray(output.points) ? output.points.length : 0,
      confidence: output.confidence,
    };
  }
  return {
    predictedCycleLife: output.predictedCycleLife,
    curvePoints: Array.isArray(output.sohCurve) ? output.sohCurve.length : 0,
    confidence: output.confidence,
  };
}

function parseArguments(values: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || !value) {
      throw new Error(
        "参数格式应为 --artifact-root <目录> --record-file <CSV>",
      );
    }
    result.set(name.slice(2), value);
  }
  return result;
}

function numeric(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${label} 无效`);
  return result;
}

function finite(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} 不是有限数值`);
  }
}
