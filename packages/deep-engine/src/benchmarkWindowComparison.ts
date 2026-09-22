import { validateSampleWindow, type SampleChannel, type SampleWindow } from "./benchmarkSampleSchema.js";

export interface BenchmarkWindowPair {
  readonly round: number;
  readonly candidate: SampleWindow;
  readonly reference: SampleWindow;
}

export interface BenchmarkChannelGap {
  readonly channel: SampleChannel;
  readonly status: "measured" | "unverified";
  readonly issues: readonly string[];
  readonly pairedRounds: number;
  readonly candidateP95MedianMs: number | null;
  readonly referenceP95MedianMs: number | null;
  /** Paired bootstrap of round-level P95 differences; milliseconds, candidate minus reference. */
  readonly deltaMeanMs: number | null;
  readonly delta95IntervalMs: readonly [number, number] | null;
}

const CHANNELS: readonly SampleChannel[] = ["authoring-bridge", "scene-update", "upload", "cpu-submit",
  "gpu-timestamp", "present", "frame-interval", "input-latency"];

/** Descriptive differences only. A performance verdict still requires identity and fidelity gates. */
export function compareBenchmarkWindows(pairs: readonly BenchmarkWindowPair[]): readonly BenchmarkChannelGap[] {
  const invalid: string[] = [];
  if (pairs.length < 5) invalid.push("at least five paired rounds required");
  const runIds = new Set<string>();
  pairs.forEach((pair, index) => {
    if (pair.round !== index + 1) invalid.push("rounds must be consecutive from one");
    for (const window of [pair.candidate, pair.reference]) {
      if (!window.runId.trim() || runIds.has(window.runId)) invalid.push("run IDs must be nonempty and unique");
      runIds.add(window.runId);
      invalid.push(...validateSampleWindow(window).map(issue => `${window.runId}: ${issue.message}`));
    }
  });
  return CHANNELS.map(channel => compareChannel(channel, pairs, invalid));
}

function compareChannel(channel: SampleChannel, pairs: readonly BenchmarkWindowPair[], invalid: readonly string[]): BenchmarkChannelGap {
  const issues = [...invalid], candidate: number[] = [], reference: number[] = [];
  let clock: string | undefined;
  for (const pair of pairs) {
    const left = pair.candidate.channels.find(entry => entry.channel === channel);
    const right = pair.reference.channels.find(entry => entry.channel === channel);
    if (!left || !right || left.availability !== "measured" || right.availability !== "measured") {
      issues.push(`round ${pair.round}: ${left?.unavailableReason ?? right?.unavailableReason ?? "channel missing"}`);
      continue;
    }
    if (left.clockId !== right.clockId || (clock !== undefined && clock !== left.clockId)) {
      issues.push(`round ${pair.round}: channel clocks differ`);
      continue;
    }
    clock = left.clockId;
    candidate.push(percentile(left.samplesMs, 0.95));
    reference.push(percentile(right.samplesMs, 0.95));
  }
  if (issues.length) return { channel, status: "unverified", issues: [...new Set(issues)], pairedRounds: candidate.length,
    candidateP95MedianMs: null, referenceP95MedianMs: null, deltaMeanMs: null, delta95IntervalMs: null };
  const deltas = candidate.map((value, index) => value - reference[index]!);
  return { channel, status: "measured", issues: [], pairedRounds: pairs.length,
    candidateP95MedianMs: median(candidate), referenceP95MedianMs: median(reference),
    deltaMeanMs: mean(deltas), delta95IntervalMs: bootstrapInterval(deltas) };
}

// Same nearest-rank definition as the existing competitive runner; raw windows permit recomputation.
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(values.length / 2);
  return values.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
function mean(values: readonly number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }

function bootstrapInterval(deltas: readonly number[]): readonly [number, number] {
  let state = 0xdec026;
  const means: number[] = [];
  for (let iteration = 0; iteration < 2_000; iteration++) {
    let sum = 0;
    for (let draw = 0; draw < deltas.length; draw++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      sum += deltas[Math.floor((state / 0x100000000) * deltas.length)]!;
    }
    means.push(sum / deltas.length);
  }
  return [percentile(means, 0.025), percentile(means, 0.975)];
}
