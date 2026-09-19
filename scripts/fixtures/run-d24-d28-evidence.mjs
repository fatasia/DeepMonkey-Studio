import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// D24–D28 项目后验收证据绑定器：把真实运行产物（长稳、故障注入、在线全链路、Native 对手）
// 绑定成机器可读卡 V01–V05。只做内容校验与汇总，不产生任何新事实；
// 缺哪类证据就如实保留 unverified/partial，禁止用文档文本冒充运行证据。

const root = process.cwd();

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? resolve(root, args[index + 1]) : null;
};

const nativeOpponentPath = option("native-opponent") ?? resolve(root, "test-output/d24-d28-native-opponent/evidence.json");
const visualPath = option("visual");
const signoffPath = option("signoff");

const webglSoakPath = resolve(root, "test-output/viewer-soak/report-webgl.json");
const webgpuSoakPath = resolve(root, "test-output/viewer-soak/report-webgpu.json");
const faultWebglPath = resolve(root, "test-output/post-acceptance-fault/report-webgl.json");
const faultWebgpuPath = resolve(root, "test-output/post-acceptance-fault/report-webgpu.json");
const onlineFlowPath = resolve(root, "test-output/online-flow/report.json");

// 长稳门槛：绑定到 V03 至少 15 分钟实测；生产级 480 分钟才能让 V03 通过。
const SOAK_BIND_MINUTES = 15;
const SOAK_PRODUCTION_MINUTES = 480;

function readJsonSync(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function fingerprint(path) {
  const buffer = await readFile(path);
  return { bytes: buffer.byteLength, sha256: createHash("sha256").update(buffer).digest("hex") };
}

function measuredSoakMinutes(report) {
  const start = Date.parse(report.createdAt ?? "");
  const end = Date.parse(report.finishedAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, (end - start) / 60_000);
}

function evaluateSoak(path) {
  const report = readJsonSync(path);
  if (!report) return { bound: false, path, kind: "soak", reason: "report missing" };
  const measuredMinutes = measuredSoakMinutes(report);
  const completed = report.completedSamples ?? 0;
  const required = report.requiredSamples ?? Number.POSITIVE_INFINITY;
  const failureCount = (report.failures ?? []).length + (report.pageErrors ?? []).length + (report.consoleErrors ?? []).length;
  const valid = completed >= required && failureCount === 0 && measuredMinutes >= SOAK_BIND_MINUTES;
  return {
    bound: true,
    path,
    kind: "soak",
    label: `soak-${report.rendererBackend ?? "unknown"}`,
    renderer: report.rendererBackend ?? "unknown",
    valid,
    measuredMinutes: Number(measuredMinutes.toFixed(2)),
    completedSamples: completed,
    requiredSamples: report.requiredSamples ?? null,
    failureCount,
    reason: valid
      ? null
      : completed < required
        ? "samples incomplete"
        : failureCount > 0
          ? "errors recorded"
          : `measured ${measuredMinutes.toFixed(1)} min < ${SOAK_BIND_MINUTES} min`,
  };
}

function evaluateFault(path) {
  const report = readJsonSync(path);
  if (!report) return { bound: false, path, kind: "fault", reason: "report missing" };
  const cases = (report.cases ?? []).map((item) => ({ id: item.id, actual: item.actual }));
  const passed = cases.filter((item) => item.actual === "passed");
  const failed = cases.filter((item) => item.actual === "failed");
  const unsupported = cases.filter((item) => item.actual === "unsupported");
  return {
    bound: true,
    path,
    kind: "fault",
    label: `fault-${report.rendererBackend ?? "unknown"}`,
    renderer: report.rendererBackend ?? "unknown",
    valid: failed.length === 0 && passed.length >= 3 && (report.pageErrors ?? []).length === 0,
    passedIds: passed.map((item) => item.id),
    failedIds: failed.map((item) => item.id),
    unsupportedIds: unsupported.map((item) => item.id),
    reason: failed.length > 0
      ? `failed: ${failed.map((item) => item.id).join(",")}`
      : passed.length < 3
        ? "fewer than 3 passed cases"
        : (report.pageErrors ?? []).length > 0
          ? "page errors recorded"
          : null,
  };
}

function evaluateOnlineFlow(path) {
  const report = readJsonSync(path);
  if (!report) return { bound: false, path, kind: "full-channel", reason: "report missing" };
  const steps = (report.steps ?? []).map((step) => step.id ?? step.name ?? step.step ?? "");
  const publishSteps = steps.filter((id) => /publish/i.test(id));
  const failureCount = (report.failures ?? []).length + (report.pageErrors ?? []).length;
  return {
    bound: true,
    path,
    kind: "full-channel",
    label: "online-flow",
    valid: failureCount === 0 && publishSteps.length > 0,
    stepCount: steps.length,
    publishStepIds: publishSteps,
    failureCount,
    reason: failureCount > 0
      ? `${failureCount} failures recorded`
      : publishSteps.length === 0
        ? "no publish step present"
        : null,
  };
}

function evaluateNativeOpponent(path) {
  const report = readJsonSync(path);
  if (!report) return { bound: false, path, kind: "native-opponent", reason: "evidence missing" };
  const runs = Array.isArray(report.runs) ? report.runs : [];
  const independentScenes = new Set(runs.map((run) => run.sceneId ?? run.scene));
  const valid = runs.length >= 2 && independentScenes.size >= 2 && runs.every((run) => run.frameDigestSha256 && run.exitCode === 0);
  return {
    bound: true,
    path,
    kind: "native-opponent",
    label: "native-opponent",
    valid,
    runCount: runs.length,
    independentScenes: independentScenes.size,
    reason: valid ? null : "needs >=2 independent Native runs across >=2 scenes with frame digests and exit 0",
  };
}

function evaluateOptional(path, label) {
  const report = readJsonSync(path);
  if (!report) return { bound: false, path, kind: "optional", label, reason: "evidence missing" };
  return { bound: true, path, kind: "optional", label, valid: true, reason: null };
}

const soaks = [evaluateSoak(webglSoakPath), evaluateSoak(webgpuSoakPath)].filter((item) => item.bound);
const faults = [evaluateFault(faultWebglPath), evaluateFault(faultWebgpuPath)].filter((item) => item.bound);
const onlineFlow = evaluateOnlineFlow(onlineFlowPath);
const nativeOpponent = evaluateNativeOpponent(nativeOpponentPath);
const visual = evaluateOptional(visualPath, "visual-accessibility-gate");
const signoff = evaluateOptional(signoffPath, "synthesis-signoff");

const soakMinutes = Math.max(0, ...soaks.map((item) => item.measuredMinutes ?? 0));
const soakAllValid = soaks.length > 0 && soaks.every((item) => item.valid);
const faultAllValid = faults.length > 0 && faults.every((item) => item.valid);

const cards = [
  {
    id: "V01",
    status: "partial",
    independentEvidence: false,
    reason: soaks.length > 0
      ? `Web paired evidence plus ${soaks.length} renderer soak(s) (max ${soakMinutes.toFixed(1)} min) bound; full opponent matrix (Three/Babylon per-case) remains separate evidence`
      : "Web paired evidence covers fixed Deep/Three cases; no soak bound and not the full opponent matrix",
  },
  {
    id: "V02",
    status: nativeOpponent.valid ? "passed" : "unverified",
    independentEvidence: nativeOpponent.valid,
    reason: nativeOpponent.valid
      ? `Native opponent runs bound: ${nativeOpponent.runCount} runs across ${nativeOpponent.independentScenes} scenes`
      : nativeOpponent.bound
        ? nativeOpponent.reason
        : "independent Native opponent runs are not present in this evidence set",
  },
  {
    id: "V03",
    status: faultAllValid && onlineFlow.valid && soakAllValid && soakMinutes >= SOAK_PRODUCTION_MINUTES ? "passed" : "partial",
    independentEvidence: faultAllValid && onlineFlow.valid,
    reason: faultAllValid && onlineFlow.valid
      ? soakMinutes >= SOAK_PRODUCTION_MINUTES
        ? "fault injection, online full-channel and production soak all bound"
        : `fault injection (${faults.filter((item) => item.valid).length}/${faults.length} valid) and online full-channel bound; soak measured ${soakMinutes.toFixed(1)} min < ${SOAK_PRODUCTION_MINUTES} min production bar`
      : [
          faultAllValid ? null : `fault injection incomplete: ${faults.filter((item) => !item.valid).map((item) => item.reason).join("; ") || "no report"}`,
          onlineFlow.valid ? null : `online full-channel incomplete: ${onlineFlow.reason ?? "no report"}`,
        ].filter(Boolean).join("; ") || "evidence missing",
  },
  {
    id: "V04",
    status: visual.valid ? "passed" : "partial",
    independentEvidence: visual.valid,
    reason: visual.valid
      ? `visual/accessibility gate evidence bound: ${visual.path}`
      : "benchmark visual review is not the complete product visual and accessibility gate; no visual gate evidence bound",
  },
];

const othersPassed = cards.every((card) => card.status === "passed");
cards.push({
  id: "V05",
  status: othersPassed && signoff.valid ? "passed" : "unverified",
  independentEvidence: othersPassed && signoff.valid,
  reason: othersPassed && signoff.valid
    ? `synthesis sign-off bound: ${signoff.path}`
    : "no independent synthesis sign-off may be inferred from component reports",
});

const cardContractValid = cards.every((card) => ["passed", "partial", "unverified"].includes(card.status) && typeof card.reason === "string" && card.reason.trim().length > 0);
const passedCount = cards.filter((card) => card.status === "passed").length;
const verdict = passedCount === cards.length ? "passed" : "partial";

const bindings = [];
for (const item of [...soaks, ...faults, onlineFlow, nativeOpponent, visual, signoff]) {
  if (item?.bound && item?.path && existsSync(item.path)) {
    bindings.push({ label: item.label, ...await fingerprint(item.path), path: item.path });
  }
}

const report = {
  schema: "deep-engine.d24-d28-project-post-acceptance.v2",
  generatedAt: new Date().toISOString(),
  scope: "D24-D28 project post-acceptance bound evidence",
  policy: {
    soakBindMinutes: SOAK_BIND_MINUTES,
    soakProductionMinutes: SOAK_PRODUCTION_MINUTES,
    rules: [
      "V02 passes only with >=2 independent Native runs across >=2 scenes carrying frame digests and exit 0",
      `V03 passes only when fault injection, online full-channel and soak all valid with soak >= ${SOAK_PRODUCTION_MINUTES} min`,
      "V05 passes only when V01–V04 all pass and an independent synthesis sign-off is bound",
    ],
  },
  bindings,
  runs: { soak: soaks, fault: faults, onlineFlow, nativeOpponent, visual, signoff },
  checks: {
    hasIndependentNativeOpponentEvidence: nativeOpponent.valid,
    hasLongStabilityEvidence: soakAllValid,
    hasFullChannelEvidence: onlineFlow.valid,
    hasFaultInjectionEvidence: faultAllValid,
  },
  cardContract: { valid: cardContractValid, reason: null },
  postAcceptanceCards: cards,
  verdict,
  explicitGap: passedCount === cards.length
    ? null
    : `${cards.length - passedCount} of ${cards.length} post-acceptance cards below passed: ${cards.filter((card) => card.status !== "passed").map((card) => `${card.id}(${card.status})`).join(", ")}`,
};

const outDir = resolve(root, "test-output/d24-d28-evidence-20260919");
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ verdict, passedCount, cards: cards.map((card) => `${card.id}:${card.status}`), soakMinutes: Number(soakMinutes.toFixed(2)), outDir }, null, 2));
