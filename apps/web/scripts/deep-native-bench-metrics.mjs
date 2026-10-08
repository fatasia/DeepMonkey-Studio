import { strict as assert } from "node:assert";

/**
 * @param {string} stdout
 * @param {{frames: number, warmup: number, count: number, packageHash: string, workload?: string}} options
 */
export function parseNativeReport(stdout, { frames, warmup, count, packageHash, workload }) {
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith("native telemetry report: "));
  assert.equal(lines.length, 1, "Exactly one native report required.");
  const raw = lines[0].slice("native telemetry report: ".length);
  const report = JSON.parse(raw);
  assert.equal(report.schema, "deep-engine.native-player-report");
  assert.equal(report.build.profile, "release");
  assert.equal(report.content.runtime_package_id, `bench.native-${count}`);
  assert.equal(report.content.runtime_package_sha256, packageHash);
  assert.equal(report.sampling.sample_frames, frames);
  assert.equal(report.sampling.warmup_frames, warmup);
  assert.equal(report.metrics.frames.presented, frames);
  assert.equal(report.metrics.frames.attempted, frames);
  for (const key of ["skipped", "recoveries", "failed"]) assert.equal(report.metrics.frames[key], 0, key);
  assert.equal(report.metrics.packet_updates, workload && workload !== "static" ? frames : 0);
  const window = report.metrics.benchmark_sample_window;
  assert.equal(window.schema, "deep-engine.benchmark-sample-window");
  const channel = window.channels.find(item => item.channel === "frame-interval");
  assert.equal(channel.availability, "measured");
  assert.equal(channel.clockId, "host-monotonic");
  assert.equal(channel.sampleCount, frames - 1);
  assert.equal(channel.samplesMs.length, frames - 1);
  assert(channel.samplesMs.every(value => Number.isFinite(value) && value > 0));
  assert(window.windowEndMs > window.windowStartMs);
  assert(channel.samplesMs.reduce((sum, value) => sum + value, 0)
    <= window.windowEndMs - window.windowStartMs + 0.001, "Intervals exceed their sampling window.");
  // Confirm the actual physical surface, rather than trusting requested env vars.
  assert.match(stdout, /1440x900/);
  const values = [...channel.samplesMs].sort((a, b) => a - b);
  const percentile = ratio => values[Math.ceil(values.length * ratio) - 1];
  /** @type {{raw: string, report: any, frames: Record<string, number>, benchmark?: {gpuP50Ms: number, drawCalls: number, lastRebuildMs?: number, heapDeltaBytes?: number}}} */
  const parsed = { raw, report, frames: { samples: values.length,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maximumMs: values.at(-1),
    windowMs: window.windowEndMs - window.windowStartMs } };
  if (workload) {
    const metrics = report.metrics.benchmark;
    assert.equal(metrics.schema, "deep-engine.fixture-benchmark");
    assert.equal(metrics.version, 1);
    assert.equal(metrics.observerBuild, true);
    assert.equal(metrics.workload, workload);
    assert.equal(metrics.movingObjects, workload === "dynamic" ? 200 : 0);
    assert.equal(metrics.measuredUpdates, workload === "static" ? 0 : frames);
    assert.equal(metrics.drawCommands.length, frames);
    assert(metrics.drawCommands.every(value => Number.isInteger(value) && value > 0));
    const gpu = window.channels.find(item => item.channel === "gpu-timestamp");
    assert.equal(gpu.availability, "measured");
    assert.equal(gpu.clockId, "gpu-timestamp");
    assert.equal(gpu.sampleCount, frames);
    assert.equal(gpu.samplesMs.length, frames);
    assert(gpu.samplesMs.every(value => Number.isFinite(value) && value > 0));
    assert.equal(report.metrics.gpu.status, "supported");
    assert.equal(report.metrics.gpu.dropped, 0);
    assert.equal(report.metrics.gpu.late, 0);
    const sortedGpu = [...gpu.samplesMs].sort((a, b) => a - b);
    parsed.benchmark = { gpuP50Ms: sortedGpu[Math.ceil(frames * 0.5) - 1],
      drawCalls: metrics.drawCommands.at(-1) };
    if (workload === "rebuild") {
      assert.equal(metrics.rebuildMs.length, frames);
      assert(metrics.rebuildMs.every(value => Number.isFinite(value) && value > 0));
      assert.equal(metrics.heapBytes.length, frames + 1);
      assert(metrics.heapBytes.every(value => Number.isSafeInteger(value) && value > 0));
      parsed.benchmark.lastRebuildMs = metrics.rebuildMs.at(-1);
      parsed.benchmark.heapDeltaBytes = metrics.heapBytes.at(-1) - metrics.heapBytes[0];
    } else {
      assert.deepEqual(metrics.rebuildMs, []);
      assert.deepEqual(metrics.heapBytes, []);
    }
    const markers = stdout.split(/\r?\n/).filter(line => line.startsWith("native benchmark first present: "));
    assert.equal(markers.length, 1);
    assert.equal(JSON.parse(markers[0].slice("native benchmark first present: ".length)).workload, workload);
  }
  return parsed;
}

export function median(values) {
  assert(values.length > 0 && values.every(Number.isFinite));
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function tableCells(summary) {
  const get = (count, workload) => summary.cases.find(item => item.objectCount === count && item.workload === workload).median;
  const small = get(120, "static"), large = get(1000, "static"), dynamic = get(1000, "dynamic"), rebuild = get(1000, "rebuild");
  const worstHeap = Math.max(...summary.cases.find(item => item.workload === "rebuild").runs.map(run => run.benchmark.heapDeltaBytes));
  return [
    [["| 静置 P50(", "| Idle P50 ("], `${small.p50Ms.toFixed(2)} / ${large.p50Ms.toFixed(2)}`],
    [["| 静置 P95(", "| Idle P95 ("], `${small.p95Ms.toFixed(2)} / ${large.p95Ms.toFixed(2)}`],
    [["| 动态 P95(", "| Dynamic P95 ("], dynamic.p95Ms.toFixed(2)],
    [["| 静置最大帧(", "| Idle max frame ("], small.maximumMs.toFixed(2)],
    [["| 首帧(", "| First frame ("], large.firstFrameMs.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })],
    [["| GPU 帧时 P50(", "| GPU frame time P50 ("], large.gpuP50Ms.toFixed(2)],
    [["| 20 轮重建(", "| 20 rebuild cycles ("], rebuild.lastRebuildMs.toFixed(2)],
    [["| Draw Calls(", "| Draw calls ("], large.drawCalls.toLocaleString("en-US")],
    [["| 重建堆增最差(", "| Rebuild heap growth worst ("], (worstHeap / 1024 / 1024).toFixed(2)],
  ];
}
