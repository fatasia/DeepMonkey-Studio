import type { PlantLiteReplicationTrace, PlantLiteTraceEvent } from "@bim-studio/contracts";

export interface OrderedPlantLiteTraceEvent {
  event: PlantLiteTraceEvent;
  sequence: number;
  originalIndex: number;
}

export interface PlantLiteTraceCaptureEvidence {
  captureStatus: "complete" | "truncated" | "unknown";
  replication: number | null;
  capturedItemCount: number;
  omittedEventCount: number | null;
  limits: { maxEvents: number; maxItems: number } | null;
}

export function orderPlantLiteTraceEvents(trace: Partial<PlantLiteReplicationTrace>): {
  ordered: OrderedPlantLiteTraceEvent[];
  invalidEventCount: number;
} {
  const rawEvents = Array.isArray(trace.events) ? trace.events : [];
  let invalidEventCount = 0;
  const ordered = rawEvents.flatMap((event, originalIndex): OrderedPlantLiteTraceEvent[] => {
    if (!event || !Number.isFinite(event.atMinute) || event.atMinute < 0) {
      invalidEventCount += 1;
      return [];
    }
    const sequence = Number.isFinite(event.sequence) ? event.sequence : originalIndex;
    if (!Number.isFinite(event.sequence)) invalidEventCount += 1;
    return [{ event, sequence, originalIndex }];
  }).sort((left, right) =>
    left.event.atMinute - right.event.atMinute
    || left.sequence - right.sequence
    || left.originalIndex - right.originalIndex);
  return { ordered, invalidEventCount };
}

export function readPlantLiteTraceCaptureEvidence(
  trace: Partial<PlantLiteReplicationTrace>,
  recordedItemCount: number,
): PlantLiteTraceCaptureEvidence {
  const limits = validTraceLimits(trace.limits);
  const omittedEventCount = safeNonNegativeInteger(trace.omittedEventCount);
  const captureStatus = trace.truncated === true
    ? "truncated"
    : trace.truncated === false && limits && omittedEventCount !== null
      ? "complete"
      : "unknown";
  return {
    captureStatus,
    replication: safeNonNegativeInteger(trace.replication),
    capturedItemCount: Math.max(safeNonNegativeInteger(trace.capturedItemCount) ?? 0, recordedItemCount),
    omittedEventCount,
    limits,
  };
}

/** Keeps endpoints and the peak, then samples evenly to bound SVG path size. */
export function boundPlantLiteStepPoints<T>(
  points: T[],
  maximum: number,
  peakValue: (point: T) => number,
): T[] {
  if (points.length <= maximum) return points;
  let peakIndex = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (peakValue(points[index]!) > peakValue(points[peakIndex]!)) peakIndex = index;
  }
  const selected = new Set<number>([0, points.length - 1, peakIndex]);
  const slots = Math.max(0, maximum - selected.size);
  for (let slot = 1; slot <= slots; slot += 1) {
    selected.add(Math.round(slot * (points.length - 1) / (slots + 1)));
  }
  for (let index = 1; index < points.length - 1 && selected.size < maximum; index += 1) selected.add(index);
  return [...selected].sort((left, right) => left - right).map((index) => points[index]!);
}

export function boundedPlantLiteSeriesOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const numeric = Number.isFinite(value) ? Math.floor(value!) : fallback;
  return Math.min(maximum, Math.max(minimum, numeric));
}

function validTraceLimits(limits: PlantLiteReplicationTrace["limits"] | undefined): PlantLiteTraceCaptureEvidence["limits"] {
  if (!limits) return null;
  const maxEvents = safePositiveInteger(limits.maxEvents);
  const maxItems = safePositiveInteger(limits.maxItems);
  return maxEvents !== null && maxItems !== null ? { maxEvents, maxItems } : null;
}

function safePositiveInteger(value: number | undefined): number | null {
  return Number.isSafeInteger(value) && value! > 0 ? value! : null;
}

function safeNonNegativeInteger(value: number | undefined): number | null {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : null;
}
