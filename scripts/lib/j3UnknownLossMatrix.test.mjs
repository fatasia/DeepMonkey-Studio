import test from "node:test";
import assert from "node:assert/strict";
import { domainAssertions, expandUnknownLossMatrix, validateUnknownLossMatrixEvidence,
  HDR_RELATIVE_DRIFT_MAX } from "./j3UnknownLossMatrix.mjs";

const identity = { sourceHash: "j5-source-snapshot-sha" };
const WEB = "web-chrome-webgpu", NATIVE = "native-wgpu-vulkan";

function legalReceipt(cell) {
  const receipt = { rowId: cell.rowId, host: cell.host, status: "measured", actualDriverFault: false,
    strategy: cell.strategy, identityBefore: "renderer-1", identityAfter: "renderer-2",
    lossCallbacks: cell.expect.lossCallbacks, recoveryAttempts: cell.expect.attemptsMax,
    presentedAfterRecovery: cell.expect.presentedAfterRecovery, staleEventsRejected: true,
    editorDomains: {} };
  for (const domain of cell.expect.editorDomains) {
    if (domain.tier === "exempt") continue;
    receipt.editorDomains[domain.id] = { verified: true,
      method: domain.tier === "observable" ? "hdr-readback" : "evidence-field" };
  }
  if (cell.expect.hdrGate === "relative") receipt.relativeHdrDrift = 0;
  if (cell.expect.hdrGate === "digest") { receipt.readbackDigestBefore = "digest-1"; receipt.readbackDigestAfter = "digest-1"; }
  if (cell.expect.terminal) { receipt.terminalState = cell.expect.terminal; receipt.lateLossDidNotRevive = true; }
  if (cell.expect.fullHostReplacement)
    receipt.fullHostReplacement = { pipelineIdentityChanged: true, staleCacheRehydration: false };
  return receipt;
}
const legalReceipts = () => expandUnknownLossMatrix().cells.map(legalReceipt);
const find = (receipts, rowId, host = WEB) => receipts.find(entry => entry.rowId === rowId && entry.host === host);
const firstReason = (validation, rowId, host = WEB) =>
  validation.rows.find(row => row.rowId === rowId && row.host === host)?.reasons.join("; ") ?? "row missing";

function timingWindow(runId, sample) {
  return { schema: "deep-engine.benchmark-sample-window", schemaVersion: 1, runId, clockId: "host-monotonic",
    windowStartMs: 0, windowEndMs: 10,
    channels: [{ channel: "present", clockId: "host-monotonic", windowStartMs: 0, windowEndMs: 10,
      availability: "measured", sampleCount: 4, samplesMs: Array.from({ length: 4 }, () => sample) }] };
}
function withTiming(receipt, candidateMs, referenceMs) {
  receipt.timing = { pairs: Array.from({ length: 5 }, (_, index) => ({ round: index + 1,
    candidate: timingWindow(`${receipt.rowId}-${receipt.host}-c${index}`, candidateMs),
    reference: timingWindow(`${receipt.rowId}-${receipt.host}-r${index}`, referenceMs) })) };
  return receipt;
}

test("matrix expands 11 cells with per-host strategies and 21-domain assertions", () => {
  const expansion = expandUnknownLossMatrix();
  assert.equal(expansion.cells.length, 11);
  assert.ok(expansion.cells.every(cell => cell.strategy));
  const split = expansion.cells.filter(cell => cell.rowId === "destroyed-strategy-split");
  assert.notEqual(split.find(cell => cell.host === WEB).strategy, split.find(cell => cell.host === NATIVE).strategy);
  const webReplacement = expansion.cells.filter(cell => cell.rowId === "web-unknown-full-host-replacement");
  assert.equal(webReplacement.length, 1);
  for (const host of [WEB, NATIVE]) {
    const assertions = domainAssertions(host);
    assert.equal(assertions.length, 21);
    assert.ok(assertions.every(entry => ["observable", "structural", "exempt"].includes(entry.tier)));
  }
  assert.throws(() => domainAssertions("unknown-host"), /Unknown host/);
});

test("empty evidence can never measure the matrix", async () => {
  const validation = await validateUnknownLossMatrixEvidence(identity, []);
  assert.equal(validation.matrixComplete, false);
  assert.equal(validation.rows.length, 11);
  assert.ok(validation.rows.every(row => row.status === "missing"));
  assert.equal(validation.actualDriverFaultAccepted, false);
});

test("full legal receipts pass and count every declared cell", async () => {
  const receipts = legalReceipts();
  const replacement = find(receipts, "web-unknown-full-host-replacement");
  withTiming(replacement, 0.21, 0.2);
  const validation = await validateUnknownLossMatrixEvidence(identity, receipts);
  assert.equal(validation.matrixComplete, true);
  assert.equal(validation.countedCells, 11);
  const present = validation.performance.find(entry => entry.channel === "present");
  assert.equal(present?.regressionSuspected, false);
});

test("synthetic-injection and strategy expectations are enforced", async () => {
  for (const mutation of [receipt => { receipt.actualDriverFault = true; },
    receipt => { receipt.strategy = "some-other-strategy"; },
    receipt => { receipt.identityAfter = receipt.identityBefore; },
    receipt => { receipt.staleEventsRejected = false; },
    receipt => { receipt.status = "unavailable"; delete receipt.reason; }]) {
    const receipts = legalReceipts();
    mutation(find(receipts, "single-unknown-mid-run"));
    const validation = await validateUnknownLossMatrixEvidence(identity, receipts);
    assert.equal(validation.matrixComplete, false);
    assert.ok(validation.rows.some(row => row.status === "invalid"));
  }
});

test("callback counts, attempt budgets and present expectations are exact", async () => {
  const receipts = legalReceipts();
  find(receipts, "single-unknown-mid-run").lossCallbacks = 0;
  find(receipts, "unknown-retry-backoff").recoveryAttempts = 1;
  find(receipts, "unknown-exhaustion-fatal").presentedAfterRecovery = true;
  find(receipts, "unknown-exhaustion-fatal").relativeHdrDrift = 0;
  const validation = await validateUnknownLossMatrixEvidence(identity, receipts);
  assert.match(firstReason(validation, "single-unknown-mid-run"), /lossCallbacks/);
  assert.match(firstReason(validation, "unknown-retry-backoff"), /recoveryAttempts/);
  assert.match(firstReason(validation, "unknown-exhaustion-fatal"), /presentedAfterRecovery/);
  assert.match(firstReason(validation, "unknown-exhaustion-fatal"), /hdrGate is none/);
});

test("hdr gates are per row: relative threshold, webGL digest, none", async () => {
  const receipts = legalReceipts();
  find(receipts, "single-unknown-mid-run").relativeHdrDrift = HDR_RELATIVE_DRIFT_MAX * 1000;
  find(receipts, "destroyed-strategy-split").readbackDigestAfter = "digest-drift";
  find(receipts, "destroyed-strategy-split", NATIVE).relativeHdrDrift = HDR_RELATIVE_DRIFT_MAX * 1000;
  const validation = await validateUnknownLossMatrixEvidence(identity, receipts);
  assert.match(firstReason(validation, "single-unknown-mid-run"), /relativeHdrDrift/);
  assert.match(firstReason(validation, "destroyed-strategy-split"), /digest/);
  assert.match(firstReason(validation, "destroyed-strategy-split", NATIVE), /relativeHdrDrift/);
});

test("exhaustion rows must record terminal state and late-loss non-revival", async () => {
  const receipts = legalReceipts();
  const exhausted = find(receipts, "unknown-exhaustion-fatal");
  delete exhausted.terminalState;
  const validation = await validateUnknownLossMatrixEvidence(identity, receipts);
  assert.match(firstReason(validation, "unknown-exhaustion-fatal"), /terminalState/);
});

test("editor domain tiers are enforced: observable verified, exempt never", async () => {
  const receipts = legalReceipts();
  const single = find(receipts, "single-unknown-mid-run");
  single.editorDomains["camera-pose-mode-avatar"] = { verified: true, method: "screenshot-only" };
  single.editorDomains["organization-panel-selection"] = { verified: true };
  const native = find(receipts, "single-unknown-mid-run", NATIVE);
  delete native.editorDomains["camera-pose-mode-avatar"];
  const validation = await validateUnknownLossMatrixEvidence(identity, receipts);
  assert.match(firstReason(validation, "single-unknown-mid-run"), /method in \{/);
  assert.match(firstReason(validation, "single-unknown-mid-run"), /exempt domain/);
  assert.match(firstReason(validation, "single-unknown-mid-run", NATIVE), /lacks a verified claim/);
});

test("full host replacement is required on its row and rejected elsewhere", async () => {
  const receipts = legalReceipts();
  delete find(receipts, "web-unknown-full-host-replacement").fullHostReplacement;
  find(receipts, "single-unknown-mid-run", NATIVE).fullHostReplacement = { pipelineIdentityChanged: true, staleCacheRehydration: false };
  const validation = await validateUnknownLossMatrixEvidence(identity, receipts);
  assert.match(firstReason(validation, "web-unknown-full-host-replacement"), /full host replacement/);
  assert.match(firstReason(validation, "single-unknown-mid-run", NATIVE), /does not declare it/);
});

test("driver vram rejects fake zeros, silent unavailability and ledger impersonation", async () => {
  for (const vram of [{ availability: "measured", counterIdentity: "pid_1_luid_x_phys_0", beforeBytes: 0, afterBytes: 1 },
    { availability: "measured", counterIdentity: "pid_1_luid_x_phys_0", beforeBytes: 1, afterBytes: 2, ledgerBytes: 3 },
    { availability: "unavailable" },
    { availability: "measured", beforeBytes: 1, afterBytes: 1 }]) {
    const receipts = legalReceipts();
    find(receipts, "single-unknown-mid-run").driverVram = vram;
    const validation = await validateUnknownLossMatrixEvidence(identity, receipts);
    assert.match(firstReason(validation, "single-unknown-mid-run"),
      /(driverVram|ledger)/, `vram case accepted: ${JSON.stringify(vram)}`);
  }
});

test("receipt hygiene: duplicates, undeclared rows and hosts are thrown, not downgraded", async () => {
  const receipts = legalReceipts();
  receipts.push(legalReceipts()[0]);
  await assert.rejects(() => validateUnknownLossMatrixEvidence(identity, receipts), /Duplicate receipt/);
  await assert.rejects(() => validateUnknownLossMatrixEvidence(identity, [{ ...legalReceipts()[0], host: "native-wgpu-dx12" }]),
    /not covered by row/);
  await assert.rejects(() => validateUnknownLossMatrixEvidence(identity, [{ ...legalReceipts()[0], rowId: "made-up-row" }]),
    /undeclared row/);
  await assert.rejects(() => validateUnknownLossMatrixEvidence({}, legalReceipts()), /identity missing/);
});

test("paired timing evidence reuses compareBenchmarkWindows and flags regressions", async () => {
  const quiet = legalReceipts();
  withTiming(find(quiet, "single-unknown-mid-run"), 0.21, 0.2);
  const quietRun = await validateUnknownLossMatrixEvidence(identity, quiet);
  assert.equal(quietRun.performance.find(entry => entry.channel === "present")?.regressionSuspected, false);

  const regressed = legalReceipts();
  withTiming(find(regressed, "single-unknown-mid-run"), 2, 0.2);
  const regressedRun = await validateUnknownLossMatrixEvidence(identity, regressed);
  assert.equal(regressedRun.performance.find(entry => entry.channel === "present")?.regressionSuspected, true);
});

test("incomplete or malformed timing windows are reasons, not silent passes", async () => {
  const receipts = legalReceipts();
  const receipt = find(receipts, "single-unknown-mid-run");
  receipt.timing = { pairs: [{ round: 1, candidate: timingWindow("c", 1), reference: timingWindow("r", 1) }] };
  const validation = await validateUnknownLossMatrixEvidence(identity, receipts);
  assert.match(firstReason(validation, "single-unknown-mid-run"), /five paired windows/);
});

test("declared-unavailable channels stay unverified without failing, silent ones fail", async () => {
  const receipts = legalReceipts();
  const receipt = find(receipts, "single-unknown-mid-run");
  withTiming(receipt, 0.2, 0.2);
  receipt.timing.pairs.forEach(pair => {
    for (const side of ["candidate", "reference"])
      pair[side].channels.push({ channel: "gpu-timestamp", clockId: "gpu-timestamp", windowStartMs: 0,
        windowEndMs: 10, availability: "unavailable", sampleCount: 0, samplesMs: [],
        unavailableReason: "timestamp-query unsupported" });
  });
  const validation = await validateUnknownLossMatrixEvidence(identity, receipts);
  assert.equal(validation.rows.find(row => row.rowId === "single-unknown-mid-run").status, "measured");
  assert.equal(validation.performance.find(entry => entry.channel === "gpu-timestamp")?.status, "unverified");
  receipt.timing.pairs[0].candidate.channels[1] =
    { ...receipt.timing.pairs[0].candidate.channels[1], unavailableReason: undefined };
  const silent = await validateUnknownLossMatrixEvidence(identity, receipts);
  assert.match(firstReason(silent, "single-unknown-mid-run"), /unavailable without reason/);
});
