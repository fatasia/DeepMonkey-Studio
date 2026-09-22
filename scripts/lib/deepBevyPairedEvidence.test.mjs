import assert from "node:assert/strict";
import test from "node:test";
import { measurements, pairedReport, parseDeepTelemetry } from "./deepBevyPairedEvidence.mjs";

test("parses measured Deep frame and GPU channels", () => {
  const window = { schema: "deep-engine.benchmark-sample-window", channels: [
    { channel: "frame-interval", availability: "measured", samplesMs: [2, 3] },
    { channel: "gpu-timestamp", availability: "measured", samplesMs: [1, 1.5] }] };
  const parsed = parseDeepTelemetry(`native telemetry report: ${JSON.stringify({ metrics: { benchmark_sample_window: window } })}`);
  assert.deepEqual(parsed.frame, [2, 3]); assert.deepEqual(parsed.gpu, [1, 1.5]);
});

test("paired report keeps absent formal metrics incomplete", () => {
  const observed = measurements([1, 2, 3], [0.5, 0.6]);
  const rounds = Array.from({ length: 5 }, (_, index) => ({ round: index + 1,
    order: index % 2 ? ["reference", "candidate"] : ["candidate", "reference"],
    candidate: observed, reference: observed }));
  const environment = { candidate: { backend: "Vulkan", vendor_id: 4318, device_id: 1, name: "GPU" },
    reference: { backend: "Vulkan", vendor: 4318, device: 1, name: "GPU" } };
  const report = pairedReport({ rounds, fixture: { id: "fixture" }, settings: {}, environment, provenance: {} });
  assert.equal(report.readiness.pairedAlternatingRounds, 5);
  assert.equal(report.readiness.status, "incomplete");
  assert.ok(report.readiness.missingRequiredMetrics.includes("visual-similarity"));
  assert.equal(report.claim.passed, false);
});

test("fails closed when GPU backends differ", () => {
  const observed = measurements([1, 2, 3], [0.5, 0.6]);
  const rounds = Array.from({ length: 5 }, (_, index) => ({ round: index + 1,
    order: index % 2 ? ["reference", "candidate"] : ["candidate", "reference"],
    candidate: observed, reference: observed }));
  const environment = { candidate: { backend: "Vulkan", vendor_id: 4318, device_id: 1, name: "GPU" },
    reference: { backend: "Dx12", vendor: 4318, device: 1, name: "GPU" } };
  const report = pairedReport({ rounds, fixture: { id: "fixture" }, settings: {}, environment, provenance: {} });
  assert.match(report.readiness.environmentIssues[0], /backend differs/);
  assert.equal(report.readiness.status, "incomplete");
});

test("rejects non-alternating evidence", () => {
  const rounds = Array.from({ length: 5 }, (_, index) => ({ round: index + 1,
    order: ["candidate", "reference"], candidate: {}, reference: {} }));
  assert.throws(() => pairedReport({ rounds, fixture: {}, settings: {}, environment: {}, provenance: {} }), /alternate/);
});
