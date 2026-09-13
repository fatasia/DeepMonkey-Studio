import type { BenchmarkFidelityCheck } from "@bim-studio/deep-engine";
import {
  BENCHMARK_FIDELITY_IDS,
  type BenchmarkFidelityId,
  type BenchmarkFidelitySnapshot,
  type BenchmarkProfile,
} from "./benchmarkProfile.js";

const HIGH_NATIVE_GAPS = new Set<BenchmarkFidelityId>([
  "environment", "shadows", "post-process", "tone-mapping",
]);

/** Compares the configuration emitted by each live backend; baseline mismatches fail closed. */
export function evaluateBenchmarkFidelity(profile: BenchmarkProfile,
  candidate: BenchmarkFidelitySnapshot, reference: BenchmarkFidelitySnapshot): readonly BenchmarkFidelityCheck[] {
  const checks: BenchmarkFidelityCheck[] = [compare("profile", profile, candidate.profile, reference.profile,
    candidate.profile === profile && reference.profile === profile, false)];
  for (const id of BENCHMARK_FIDELITY_IDS) {
    const left = candidate.categories[id], right = reference.categories[id];
    const equal = stableJson(left) === stableJson(right);
    checks.push(compare(id, profile, left, right, equal,
      profile === "high-native" && HIGH_NATIVE_GAPS.has(id)));
  }
  if (profile === "high-native") checks.push(Object.freeze({ id: "ranking-policy", state: "degraded",
    candidate: "native high-quality Deep path", reference: "Three core high-quality path",
    reason: "High-native intentionally compares unequal native feature stacks and never permits a ranking." }));
  return Object.freeze(checks);
}

function compare(id: string, profile: BenchmarkProfile, candidate: unknown, reference: unknown,
  equal: boolean, allowedHighGap: boolean): BenchmarkFidelityCheck {
  if (equal) return Object.freeze({ id, state: "equivalent", candidate: display(candidate), reference: display(reference) });
  const state = allowedHighGap ? "degraded" : "invalid";
  const reason = allowedHighGap
    ? `The ${id} configuration intentionally differs in the high-native profile.`
    : `The ${id} configuration differs; ${profile} evidence is not comparable.`;
  return Object.freeze({ id, state, candidate: display(candidate), reference: display(reference), reason });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function display(value: unknown): string {
  const encoded = stableJson(value);
  return encoded.length <= 512 ? encoded : `${encoded.slice(0, 509)}...`;
}
