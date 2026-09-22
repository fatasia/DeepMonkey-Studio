import assert from "node:assert/strict";
import test from "node:test";

import { externalCacheRoot, normalizeRawRun, quantiles } from "./bevy019BenchmarkEvidence.mjs";

test("quantiles preserve benchmark percentile semantics", () => {
  assert.deepEqual(quantiles([5, 1, 4, 2, 3]), { p50: 3, p95: 5, p99: 5 });
});

test("cache root must remain outside the repository", () => {
  assert.throws(() => externalCacheRoot("D:/repo", { LOCALAPPDATA: "D:/repo/cache" }), /outside/);
  assert.equal(externalCacheRoot("D:/repo", { LOCALAPPDATA: "C:/Users/test/AppData/Local" }),
    path("C:/Users/test/AppData/Local/bim-studio-benchmarks/bevy-0.19.1"));
});

test("raw evidence stays fail-closed when formal metrics are absent", () => {
  const raw = { schema: "deep-engine.bevy-raw-run", schemaVersion: 1,
    engine: { reference: "bevy", version: "0.19.1", renderer: "wgpu/vulkan", track: "native-wgpu" },
    environment: { os: "Windows" }, fixture: { id: "fixture" },
    settings: { sampleFrames: 5 }, samples: { cpuFrameMs: [1, 2, 3, 4, 5], gpuFrameMs: [2, 3, 4] },
    observations: { elapsedSeconds: 2, coldStartMs: 10, loadToInteractiveMs: 20, peakHostBytes: 1024 } };
  const evidence = normalizeRawRun(raw, {});
  assert.equal(evidence.readiness.status, "incomplete");
  assert.equal(evidence.readiness.eligibleForBenchmarkVerdict, false);
  assert.ok(evidence.readiness.missingRequiredMetrics.includes("visual-similarity"));
  assert.equal(evidence.claim.passed, false);
});

function path(value) { return value.replaceAll("/", process.platform === "win32" ? "\\" : "/"); }
