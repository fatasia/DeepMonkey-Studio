import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { expandDeviceMatrix, parseDeviceMatrix, parseNativeAdapterInfo,
  validateDeviceMatrixEvidence } from "./j2DeviceMatrix.mjs";

const matrixText = await readFile(new URL("../../packages/deep-engine/fixtures/j2-b4-device-matrix-v1.json", import.meta.url), "utf8");
const matrix = JSON.parse(matrixText);
const plan = { cases: [{ id: "inactive-uniform" }, { id: "inactive-mixed" }, { id: "blend-uniform" },
  { id: "blend-mixed" }, { id: "last-uniform" }, { id: "last-mixed" }], pairedRounds: 5, sampleFrames: 16 };
const identity = { fixtureHash: "fixture", planHash: "plan" };

const NATIVE_ADAPTER = "AdapterInfo { name: \"NVIDIA GeForce RTX 4060 Laptop GPU\", vendor: 4318, device: 10400, "
  + "device_type: DiscreteGpu, device_pci_bus_id: \"0000:01:00.0\", driver: \"NVIDIA\", driver_info: \"595.79\", backend: Vulkan }";
const WEB_ADAPTER = { vendor: "nvidia", architecture: "lovelace", device: "", description: "", isFallbackAdapter: false };

function windowSamples(count = 16) { return Array.from({ length: count }, () => 0.2); }
function timingWindow(runId) {
  return { schema: "deep-engine.benchmark-sample-window", schemaVersion: 1, runId, clockId: "gpu-timestamp",
    windowStartMs: 0, windowEndMs: 10,
    channels: [{ channel: "gpu-timestamp", clockId: "gpu-timestamp", windowStartMs: 0, windowEndMs: 10,
      availability: "measured", sampleCount: 16, samplesMs: windowSamples() }] };
}
function hostReceipt(rowId, host, adapter, overrides = {}) {
  const correctness = ["reference", "candidate"].map(id => ({ id, sourceHash: id, libraryHash: id,
    values: Array.from({ length: 21 }, (_, index) => index * 0.01), maxError: 0 }));
  return { rowId, host, status: "measured", adapter, fixtureHash: "fixture", planHash: "plan",
    passed: true, errors: [],
    results: plan.cases.map(item => ({ id: item.id, correctness,
      pairs: Array.from({ length: 5 }, (_, index) => ({ round: index + 1,
        order: index % 2 === 0 ? ["reference", "candidate"] : ["candidate", "reference"],
        candidate: timingWindow(`${rowId}-${host}-c${index}`), reference: timingWindow(`${rowId}-${host}-r${index}`) })) })),
    ...overrides };
}
const fullReceipts = () => [
  hostReceipt("rtx4060-laptop", "web-chrome-webgpu", WEB_ADAPTER),
  hostReceipt("rtx4060-laptop", "native-wgpu-vulkan", NATIVE_ADAPTER),
];

test("matrix fixture parses and expands one row into two API-host cells", () => {
  parseDeviceMatrix(matrix);
  const expanded = expandDeviceMatrix(matrix, plan);
  assert.equal(expanded.cells.length, 2);
  assert.deepEqual(expanded.cells[0].expect.caseIds, plan.cases.map(item => item.id));
  assert.equal(expanded.cells[1].expect.pairedWindows, 5);
  assert.equal(expanded.cells[1].expect.sampleFramesPerWindow, 16);
});

test("malformed matrix fixtures are rejected instead of silently expanded", () => {
  assert.throws(() => parseDeviceMatrix({ ...matrix, schema: "other" }), /schema mismatch/);
  assert.throws(() => parseDeviceMatrix({ ...matrix, families: ["ts-built-in"] }), /three CSM sampling families/);
  assert.throws(() => parseDeviceMatrix({ ...matrix, devices: [] }), /at least one device row/);
  assert.throws(() => parseDeviceMatrix({ ...matrix, devices: [{ ...matrix.devices[0], id: null }] }), /row id invalid/);
  assert.throws(() => parseDeviceMatrix({ ...matrix, devices: [{ ...matrix.devices[0], hosts: ["native-wgpu-metal"] }] }), /unknown host/);
  assert.throws(() => parseDeviceMatrix({ ...matrix, devices: [matrix.devices[0], matrix.devices[0]] }), /duplicated/);
  assert.throws(() => expandDeviceMatrix(matrix, { cases: [], pairedRounds: 5, sampleFrames: 16 }), /cases missing/);
  assert.throws(() => expandDeviceMatrix(matrix, { cases: plan.cases, pairedRounds: 3, sampleFrames: 16 }), /five paired windows/);
});

test("native adapter debug string is parsed into structured identity", () => {
  const adapter = parseNativeAdapterInfo(NATIVE_ADAPTER);
  assert.equal(adapter.name, "NVIDIA GeForce RTX 4060 Laptop GPU");
  assert.equal(adapter.backend, "Vulkan");
  assert.equal(adapter.pciBus, "0000:01:00.0");
  assert.equal(parseNativeAdapterInfo("not an adapter"), undefined);
  assert.equal(parseNativeAdapterInfo(undefined), undefined);
});

test("complete single-row receipts measure the row but cannot claim multi-device completion", () => {
  const result = validateDeviceMatrixEvidence(matrix, plan, identity, fullReceipts());
  assert.equal(result.rows[0].status, "measured");
  assert.equal(result.countedDeviceRows, 1);
  assert.equal(result.declaredDeviceRows, 1);
  assert.equal(result.physicalIdentity.nativeKeys.length, 1);
  assert.equal(result.physicalIdentity.webKeys.length, 1);
  assert.equal(result.matrixComplete, true);
  assert.match(result.excluded.join(";"), /cross-device/);
});

test("an undeclared second row keeps the matrix honestly incomplete", () => {
  const widened = { ...matrix, devices: [...matrix.devices, { id: "second-gpu", declared: { vendor: "amd" }, hosts: ["web-chrome-webgpu"] }] };
  const result = validateDeviceMatrixEvidence(widened, plan, identity, fullReceipts());
  assert.equal(result.matrixComplete, false);
  assert.equal(result.countedDeviceRows, 1);
  assert.equal(result.declaredDeviceRows, 2);
  assert.deepEqual(result.rows[1].reasons, ["web-chrome-webgpu: receipt missing"]);
  assert.equal(result.rows[1].status, "missing");
});

test("adapter identity mismatches are rejected per cell", () => {
  for (const [label, receipts] of Object.entries({
    vendor: [hostReceipt("rtx4060-laptop", "web-chrome-webgpu", { ...WEB_ADAPTER, vendor: "amd" }), fullReceipts()[1]],
    architecture: [hostReceipt("rtx4060-laptop", "web-chrome-webgpu", { ...WEB_ADAPTER, architecture: "hopper" }), fullReceipts()[1]],
    fallback: [hostReceipt("rtx4060-laptop", "web-chrome-webgpu", { ...WEB_ADAPTER, isFallbackAdapter: true }), fullReceipts()[1]],
    backend: [fullReceipts()[0], hostReceipt("rtx4060-laptop", "native-wgpu-vulkan", NATIVE_ADAPTER.replace("Vulkan", "Gl"))],
    unparseable: [fullReceipts()[0], hostReceipt("rtx4060-laptop", "native-wgpu-vulkan", "garbage")],
  })) {
    const result = validateDeviceMatrixEvidence(matrix, plan, identity, receipts);
    assert.equal(result.matrixComplete, false, label);
    assert.equal(result.rows[0].status, "invalid", label);
    assert.ok(result.rows[0].reasons.length >= 1, label);
  }
});

test("stale identities, host errors and correctness regressions invalidate the cell", () => {
  const patchFirstPair = (receipt, patchPair) => ({ ...receipt, results: receipt.results.map(result => ({
    ...result, pairs: result.pairs.map((pair, index) => index === 0 ? patchPair(pair) : pair) })) });
  for (const [label, patch] of Object.entries({
    fixture: receipt => ({ ...receipt, fixtureHash: "stale" }),
    plan: receipt => ({ ...receipt, planHash: "stale" }),
    errors: receipt => ({ ...receipt, errors: ["device lost"] }),
    failed: receipt => ({ ...receipt, passed: false }),
    cases: receipt => ({ ...receipt, results: receipt.results.slice(1) }),
    points: receipt => ({ ...receipt, results: receipt.results.map(result => ({ ...result,
      correctness: result.correctness.map(item => ({ ...item, values: item.values.slice(1) })) })) }),
    maxError: receipt => ({ ...receipt, results: receipt.results.map(result => ({ ...result,
      correctness: result.correctness.map(item => ({ ...item, maxError: 1e-3 })) })) }),
    windows: receipt => ({ ...receipt, results: receipt.results.map(result => ({ ...result, pairs: result.pairs.slice(1) })) }),
    zeroTiming: receipt => patchFirstPair(receipt, pair => ({ ...pair, candidate: { ...pair.candidate,
      channels: pair.candidate.channels.map(channel => ({ ...channel, samplesMs: channel.samplesMs.map(() => 0) })) } })),
    unavailableTiming: receipt => patchFirstPair(receipt, pair => ({ ...pair, reference: { ...pair.reference,
      channels: [{ ...pair.reference.channels[0], availability: "unavailable", sampleCount: 0, samplesMs: [],
        unavailableReason: "timestamp_query_unsupported" }] } })),
  })) {
    const [web, native] = fullReceipts();
    const result = validateDeviceMatrixEvidence(matrix, plan, identity, [web, patch(native)]);
    assert.equal(result.matrixComplete, false, label);
    assert.equal(result.rows[0].hosts["native-wgpu-vulkan"], "invalid", label);
    assert.ok(result.rows[0].reasons.some(reason => reason.startsWith("native-wgpu-vulkan: ")), label);
  }
});

test("unavailable receipts block the row as explicitly unavailable, never passed", () => {
  const result = validateDeviceMatrixEvidence(matrix, plan, identity, [
    fullReceipts()[0],
    { rowId: "rtx4060-laptop", host: "native-wgpu-vulkan", status: "unavailable", reason: "no Vulkan loader on this machine" },
  ]);
  assert.equal(result.rows[0].hosts["web-chrome-webgpu"], "measured");
  assert.equal(result.rows[0].hosts["native-wgpu-vulkan"], "invalid");
  assert.equal(result.rows[0].status, "invalid");
  assert.equal(result.matrixComplete, false);
  assert.match(result.rows[0].reasons.join(";"), /unavailable: no Vulkan loader/);
});

test("duplicate and out-of-matrix receipts are structurally rejected", () => {
  assert.throws(() => validateDeviceMatrixEvidence(matrix, plan, identity, [...fullReceipts(), fullReceipts()[0]]), /Duplicate receipt/);
  assert.throws(() => validateDeviceMatrixEvidence(matrix, plan, identity,
    [hostReceipt("rtx4090", "web-chrome-webgpu", WEB_ADAPTER)]), /undeclared device row/);
  assert.throws(() => validateDeviceMatrixEvidence(matrix, plan, identity,
    [hostReceipt("rtx4060-laptop", "native-wgpu-dx12", NATIVE_ADAPTER)]), /not covered by row/);
  assert.throws(() => validateDeviceMatrixEvidence(matrix, plan, { fixtureHash: "fixture" }, fullReceipts()), /identity missing/);
});

test("two native API hosts on one physical GPU collapse to a single native physical key", () => {
  const widened = { ...matrix, devices: [...matrix.devices, { id: "rtx4060-laptop-dx12", declared: { vendor: "nvidia", architecture: "lovelace" }, hosts: ["native-wgpu-dx12"] }] };
  const receipts = [...fullReceipts(),
    hostReceipt("rtx4060-laptop-dx12", "native-wgpu-dx12", NATIVE_ADAPTER.replace("Vulkan", "Dx12"))];
  const result = validateDeviceMatrixEvidence(widened, plan, identity, receipts);
  assert.equal(result.countedDeviceRows, 2);
  assert.equal(result.physicalIdentity.nativeKeys.length, 1);
  assert.equal(result.matrixComplete, true);
  assert.match(result.physicalIdentity.note, /not CPU-provable/);
});
