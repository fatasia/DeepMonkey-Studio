/**
 * J3-E unknown-loss 自动化 runner —— CPU 侧骨架（矩阵声明 + 展开 + 证据校验），无 GPU 依赖。
 *
 * 对齐 scripts/lib/j2DeviceMatrix.mjs 模式；验证方案与 GPU 命令见
 * docs/specs/j3-e-gpu-runner-prep-20261001.md。GPU 实跑（Chrome/`cargo test --ignored`）
 * 由主线串行执行并产出 receipts；本文件不启动任何进程。
 *
 * 口径纪律（沿 Gate E 既有证据链）：
 * - unknown 全部为合成注入，receipt 必须 `actualDriverFault:false`，报 true 即拒绝；
 * - HDR 门：native/web-unknown 行 relative ≤1e-6；web destroyed 行读回摘要相等（两端渲染器不同）；
 * - 驱动显存字段禁止用 Web 所有权账本字节冒充；伪 0 / 无原因 unavailable 一律拒绝；
 * - 21 编辑器域沿用 j3-e-editor-state-cpu 矩阵：observable/structural 必须 verified，exempt 禁止 verified。
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const UNKNOWN_LOSS_MATRIX_SCHEMA = "deep-engine.j3-e-unknown-loss-matrix.v1";
export const HDR_RELATIVE_DRIFT_MAX = 1e-6;
export const RECOVERY_REGRESSION_FLAG_RATIO = 0.1;

const WEB = "web-chrome-webgpu";
const NATIVE = "native-wgpu-vulkan";
const HOST_IDS = [WEB, NATIVE];
const RECOVERY_STRATEGY = { [WEB]: "c13-auto-recovery-full-host-replacement", [NATIVE]: "window-retry-auto-rebuild" };
const TERMINAL_STATE = { [WEB]: "webgl-author-canvas-restored-once", [NATIVE]: "failure-diagnostic-and-manual-r-preserved" };
const OBSERVABLE_METHODS = new Set(["hdr-readback", "screenshot-diff", "engine-channel-readback"]);
const TIERS = new Set(["observable", "structural", "exempt"]);

const STRATEGIES = {
  "single-unknown-mid-run": RECOVERY_STRATEGY,
  "unknown-retry-backoff": RECOVERY_STRATEGY,
  "unknown-pre-present-loss": RECOVERY_STRATEGY,
  "unknown-exhaustion-fatal": { [WEB]: "recovery-exhausted-fatal-fallback-once", [NATIVE]: "retry-budget-exhausted-manual-r-preserved" },
  "destroyed-strategy-split": { [WEB]: "destroyed-fatal-webgl-fallback-once", [NATIVE]: "actual-destroyed-auto-rebuild" },
  "web-unknown-full-host-replacement": { [WEB]: RECOVERY_STRATEGY[WEB] },
};

/** 注入行：lossCallbacks/attempts 为精确/区间期望；presented=false 的行必须带 terminalState。 */
const ROWS = [
  { id: "single-unknown-mid-run", injection: "synthetic-unknown-once", hosts: HOST_IDS,
    lossCallbacks: 1, attempts: [1, 1], presentedAfterRecovery: true, hdrGate: "relative" },
  { id: "unknown-retry-backoff", injection: "synthetic-unknown+first-creation-injected-failure", hosts: HOST_IDS,
    lossCallbacks: 1, attempts: [2, 2], presentedAfterRecovery: true, hdrGate: "relative" },
  { id: "unknown-pre-present-loss", injection: "synthetic-unknown-before-present", hosts: HOST_IDS,
    lossCallbacks: 2, attempts: [2, 2], presentedAfterRecovery: true, hdrGate: "relative" },
  { id: "unknown-exhaustion-fatal", injection: "three-consecutive-creation-failures", hosts: HOST_IDS,
    lossCallbacks: 1, attempts: [3, 3], presentedAfterRecovery: false, hdrGate: "none", terminal: true },
  { id: "destroyed-strategy-split", injection: "destroyed-control-row", hosts: HOST_IDS,
    lossCallbacks: 1, attempts: [0, 1], presentedAfterRecovery: true, hdrGate: "per-host" },
  { id: "web-unknown-full-host-replacement", injection: "synthetic-unknown-full-host-replacement", hosts: [WEB],
    lossCallbacks: 1, attempts: [1, 1], presentedAfterRecovery: true, hdrGate: "relative", fullHostReplacement: true },
];

/** 21 编辑器域 × 宿主 tier；对齐 docs/specs/j3-e-editor-state-cpu-20261001.md 覆盖矩阵，如实不升格。 */
export const EDITOR_RECOVERY_DOMAINS = Object.freeze([
  { id: "camera-pose-mode-avatar", web: "observable", native: "observable" },
  { id: "camera-constraints-navigation", web: "structural", native: "exempt", note: "Native 协议不含" },
  { id: "camera-views-default-views", web: "structural", native: "exempt" },
  { id: "model-primitive-pose-author-material", web: "observable", native: "observable" },
  { id: "selection-model-layer-annotation", web: "structural", native: "structural" },
  { id: "measurements-annotations", web: "structural", native: "exempt" },
  { id: "environment-lights-weather-floors-postfx-physics-section-axis", web: "observable", native: "observable" },
  { id: "animation-policy", web: "structural", native: "exempt" },
  { id: "animation-playhead", web: "observable", native: "exempt", note: "P3 不适用；P4 未恢复如实保留" },
  { id: "undo-stack", web: "structural", native: "exempt" },
  { id: "organization-panel-selection", web: "exempt", native: "exempt", note: "未恢复，如实声明" },
  { id: "panel-tool-ui-state", web: "exempt", native: "exempt", note: "设计豁免" },
  { id: "data-binding-runtime-cache", web: "exempt", native: "exempt", note: "transient 重建" },
  { id: "interaction-scripts-bindings-selectionSets-rootLayerOrder", web: "structural", native: "exempt" },
  { id: "publication-metadata-thumbnail-simulationEntities", web: "structural", native: "exempt" },
  { id: "dashboard-engineering-analysis", web: "structural", native: "exempt" },
  { id: "scene-name-project", web: "structural", native: "structural" },
  { id: "deep-display-state", web: "exempt", native: "exempt", note: "P1 按作者状态重建；P2 豁免" },
  { id: "play-mode-active", web: "exempt", native: "exempt", note: "Play×Recovery 未裁决" },
  { id: "behavior-graph-draft", web: "structural", native: "exempt" },
  { id: "native-ui-domains", web: "exempt", native: "structural", note: "已验范围仅 view/selection/package" },
]);

/** GPU probe 的逐域断言清单：observable/structural 必须 verified，exempt 必须缺席或 verified:false。 */
export function domainAssertions(host) {
  if (!HOST_IDS.includes(host)) throw Error(`Unknown host ${String(host)}`);
  return EDITOR_RECOVERY_DOMAINS.map(domain => ({ id: domain.id, tier: domain[host === WEB ? "web" : "native"],
    ...(domain.note ? { note: domain.note } : {}) }));
}

export function expandUnknownLossMatrix() {
  const cells = [];
  for (const row of ROWS) {
    for (const host of row.hosts) {
      cells.push({ rowId: row.id, host, injection: row.injection, strategy: STRATEGIES[row.id][host],
        expect: { lossCallbacks: row.lossCallbacks, attemptsMin: row.attempts[0], attemptsMax: row.attempts[1],
          presentedAfterRecovery: row.presentedAfterRecovery,
          hdrGate: row.hdrGate === "per-host" ? (host === WEB ? "digest" : "relative") : row.hdrGate,
          terminal: row.terminal === true ? TERMINAL_STATE[host] : null,
          fullHostReplacement: row.fullHostReplacement === true,
          editorDomains: domainAssertions(host) } });
    }
  }
  return Object.freeze({ schema: UNKNOWN_LOSS_MATRIX_SCHEMA, cells,
    scope: "synthetic unknown-loss auto-recovery matrix, native window event/present timing, editor-state domain assertions",
    excluded: ["real unknown driver fault", "physical driver VRAM leak threshold (first-run calibration pending)",
      "GPU timestamp channels without measured timestamp-query support"] });
}

function cellReasons(receipt, cell) {
  if (!receipt) return ["receipt missing"];
  if (receipt.status === "unavailable") return receipt.reason ? [`unavailable: ${receipt.reason}`] : ["unavailable without reason"];
  if (receipt.status !== "measured") return [`unknown receipt status ${String(receipt.status)}`];
  const reasons = [];
  if (receipt.actualDriverFault !== false) reasons.push("actualDriverFault must be false (synthetic injection only)");
  if (receipt.strategy !== cell.strategy) reasons.push(`strategy ${String(receipt.strategy)} != declared ${cell.strategy}`);
  if (!receipt.identityBefore || !receipt.identityAfter || receipt.identityBefore === receipt.identityAfter)
    reasons.push("renderer/device identity must change");
  if (receipt.lossCallbacks !== cell.expect.lossCallbacks)
    reasons.push(`lossCallbacks ${String(receipt.lossCallbacks)} != ${cell.expect.lossCallbacks}`);
  if (!Number.isSafeInteger(receipt.recoveryAttempts) || receipt.recoveryAttempts < cell.expect.attemptsMin
    || receipt.recoveryAttempts > cell.expect.attemptsMax)
    reasons.push(`recoveryAttempts ${String(receipt.recoveryAttempts)} outside [${cell.expect.attemptsMin},${cell.expect.attemptsMax}]`);
  if (typeof receipt.presentedAfterRecovery !== "boolean" || receipt.presentedAfterRecovery !== cell.expect.presentedAfterRecovery)
    reasons.push(`presentedAfterRecovery must be ${cell.expect.presentedAfterRecovery}`);
  reasons.push(...hdrGateReasons(receipt, cell));
  if (receipt.staleEventsRejected !== true) reasons.push("stale-event negative control must be rejected");
  if (cell.expect.terminal) {
    if (receipt.terminalState !== cell.expect.terminal) reasons.push(`terminalState must be ${cell.expect.terminal}`);
    if (receipt.lateLossDidNotRevive !== true) reasons.push("late loss/dispose must not revive the recovery path");
  }
  if (cell.expect.fullHostReplacement) {
    const replacement = receipt.fullHostReplacement;
    if (!replacement || replacement.pipelineIdentityChanged !== true || replacement.staleCacheRehydration !== false)
      reasons.push("full host replacement must rebuild pipelines on the new device without stale-cache rehydration");
  } else if (receipt.fullHostReplacement !== undefined) {
    reasons.push("fullHostReplacement claim on a row that does not declare it");
  }
  reasons.push(...domainReasons(receipt, cell));
  reasons.push(...driverVramReasons(receipt));
  return reasons;
}

function hdrGateReasons(receipt, cell) {
  const gate = cell.expect.hdrGate;
  if (gate === "relative") {
    const drift = receipt.relativeHdrDrift;
    if (!Number.isFinite(drift) || drift < 0 || drift > HDR_RELATIVE_DRIFT_MAX)
      return [`relativeHdrDrift ${String(drift)} must be finite and <= ${HDR_RELATIVE_DRIFT_MAX}`];
    return [];
  }
  if (gate === "digest")
    return typeof receipt.readbackDigestBefore === "string" && receipt.readbackDigestBefore.length > 0
      && receipt.readbackDigestBefore === receipt.readbackDigestAfter ? [] : ["webGL readback digest must be preserved"];
  return receipt.relativeHdrDrift !== undefined && receipt.relativeHdrDrift !== null
    ? ["hdrGate is none; drift must not be reported"] : [];
}

function domainReasons(receipt, cell) {
  const claims = receipt.editorDomains ?? {};
  const reasons = [];
  for (const assertion of cell.expect.editorDomains) {
    const claim = claims[assertion.id];
    if (assertion.tier === "exempt") {
      if (claim?.verified === true) reasons.push(`exempt domain ${assertion.id} must not claim verified`);
    } else if (!claim || claim.verified !== true
      || (assertion.tier === "observable" && !OBSERVABLE_METHODS.has(claim.method))) {
      reasons.push(`${assertion.tier} domain ${assertion.id} lacks a verified claim`
        + (assertion.tier === "observable" ? ` with method in {${[...OBSERVABLE_METHODS].join(",")}}` : ""));
    }
  }
  for (const id of Object.keys(claims)) if (!cell.expect.editorDomains.some(entry => entry.id === id))
    reasons.push(`unknown editor domain ${id}`);
  return reasons;
}

function driverVramReasons(receipt) {
  const vram = receipt.driverVram;
  if (vram === undefined) return [];
  if (typeof vram !== "object" || vram === null) return ["driverVram must be an object"];
  if ("ledgerBytes" in vram) return ["web ownership ledger bytes are not driver VRAM"];
  if (vram.availability === "unavailable")
    return vram.unavailableReason ? [] : ["driverVram unavailable without reason"];
  if (vram.availability !== "measured") return ["driverVram availability must be measured or unavailable"];
  if (!vram.counterIdentity) return ["measured driverVram needs the Windows counter identity"];
  const bytes = [vram.beforeBytes, vram.afterBytes];
  return bytes.every(value => Number.isFinite(value) && value > 0) ? [] : ["driverVram bytes must be finite and non-zero"];
}

const nodeRequire = createRequire(import.meta.url);

/** 复用生产 compareBenchmarkWindows（esbuild 动态加载 TS 源），不复制实现。 */
async function loadWindowComparison() {
  const { build } = nodeRequire("../../packages/deep-engine/node_modules/esbuild");
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../../packages/deep-engine/src/benchmarkWindowComparison.ts", import.meta.url))],
    bundle: true, format: "esm", platform: "node", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
}

async function performanceReasons(receipt, cellKey) {
  const timing = receipt.timing;
  if (timing === undefined) return { reasons: [], channels: [] };
  const { compareBenchmarkWindows } = await loadWindowComparison();
  const reasons = [], channels = [];
  if (!Array.isArray(timing.pairs) || timing.pairs.length < 5)
    return { reasons: [`${cellKey}: at least five paired windows required`], channels };
  for (const [index, pair] of timing.pairs.entries()) {
    for (const side of ["candidate", "reference"]) {
      for (const channel of pair[side]?.channels ?? []) {
        if (channel.availability === "unavailable" && !channel.unavailableReason)
          reasons.push(`${cellKey}: ${side} round ${index + 1}: ${channel.channel} unavailable without reason`);
      }
    }
  }
  // 统计门只作用于声明且双端 measured 的通道；显式 unavailable（带原因）记 unverified，不判失败。
  const declared = new Set();
  for (const pair of timing.pairs) for (const side of ["candidate", "reference"])
    for (const channel of pair[side]?.channels ?? []) declared.add(channel.channel);
  for (const gap of compareBenchmarkWindows(timing.pairs)) {
    if (!declared.has(gap.channel)) continue;
    const measuredBoth = timing.pairs.every(pair => ["candidate", "reference"]
      .every(side => pair[side]?.channels?.find(entry => entry.channel === gap.channel)?.availability === "measured"));
    if (!measuredBoth) {
      channels.push({ channel: gap.channel, pairedRounds: gap.pairedRounds, status: "unverified",
        note: "declared unavailable on at least one side; reason recorded per benchmarkSampleSchema" });
      continue;
    }
    if (gap.issues.length) { reasons.push(`${cellKey}: ${gap.channel} ${gap.issues[0]}`); continue; }
    const [low, high] = gap.delta95IntervalMs;
    const reference = gap.referenceP95MedianMs;
    const suspected = reference !== null && Math.sign(low) === Math.sign(high) && Math.sign(low) !== 0
      && Math.abs(gap.deltaMeanMs) / Math.max(reference, 1e-9) > RECOVERY_REGRESSION_FLAG_RATIO;
    channels.push({ channel: gap.channel, pairedRounds: gap.pairedRounds, status: "measured",
      deltaMeanMs: gap.deltaMeanMs, delta95IntervalMs: gap.delta95IntervalMs, regressionSuspected: suspected });
  }
  return { reasons, channels };
}

/**
 * 证据校验（纯 CPU + 可选 timing 复用）：receipts = [{rowId, host, status, reason?, strategy?,
 * actualDriverFault?, identityBefore/After?, lossCallbacks?, recoveryAttempts?, presentedAfterRecovery?,
 * relativeHdrDrift?|readbackDigest{Before,After}?, staleEventsRejected?, terminalState?, lateLossDidNotRevive?,
 * fullHostReplacement?, editorDomains?, timing?, driverVram?}]。identity.sourceHash 为 J5 源码快照身份。
 */
export async function validateUnknownLossMatrixEvidence(identity, receipts) {
  if (!identity?.sourceHash) throw Error("Unknown-loss evidence identity missing sourceHash");
  const cells = expandUnknownLossMatrix().cells;
  const byKey = new Map();
  for (const receipt of receipts ?? []) {
    const key = `${receipt.rowId}\n${receipt.host}`;
    if (byKey.has(key)) throw Error(`Duplicate receipt for ${String(receipt.rowId)}/${String(receipt.host)}`);
    if (!ROWS.some(row => row.id === receipt.rowId)) throw Error(`Receipt references undeclared row ${String(receipt.rowId)}`);
    const row = ROWS.find(entry => entry.id === receipt.rowId);
    if (!row.hosts.includes(receipt.host)) throw Error(`Receipt host ${String(receipt.host)} not covered by row ${receipt.rowId}`);
    byKey.set(key, receipt);
  }
  const rows = [], performance = [];
  for (const cell of cells) {
    const receipt = byKey.get(`${cell.rowId}\n${cell.host}`);
    const missing = !receipt;
    const reasons = missing ? ["receipt missing"] : cellReasons(receipt, cell);
    const timing = missing ? { reasons: [], channels: [] } : await performanceReasons(receipt, `${cell.rowId}/${cell.host}`);
    reasons.push(...timing.reasons);
    performance.push(...timing.channels.map(channel => ({ rowId: cell.rowId, host: cell.host, ...channel })));
    rows.push({ rowId: cell.rowId, host: cell.host, status: reasons.length ? (missing ? "missing" : "invalid") : "measured", reasons });
  }
  return {
    matrixComplete: rows.every(row => row.status === "measured"),
    rows, performance,
    declaredCells: cells.length,
    countedCells: rows.filter(row => row.status === "measured").length,
    actualDriverFaultAccepted: false,
    scope: "synthetic unknown-loss auto-recovery evidence matrix",
    excluded: ["real unknown driver fault", "cross-host pixel equality", "physical driver VRAM leak threshold before calibration"],
  };
}
