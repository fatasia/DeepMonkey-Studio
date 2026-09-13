import type { PlantLiteReplicationTrace, PlantLiteTraceEvent, PlantLiteTraceOptions } from "./modelTypes.js";

const DEFAULT_MAX_TRACE_EVENTS = 2_000;
const DEFAULT_MAX_TRACE_ITEMS = 100;
const MAX_TRACE_EVENTS = 10_000;
const MAX_TRACE_ITEMS = 500;

export interface PlantLiteTraceRecorder {
  item(
    type: "item-enter" | "item-changeover-start" | "item-changeover-complete" | "item-start" | "item-complete" | "item-scrap" | "item-exit",
    atMinute: number,
    itemId: string,
    nodeId: string,
    productTypeId?: string,
    orderId?: string,
    changeover?: Extract<PlantLiteTraceEvent, { itemId: string }>["changeover"],
    quality?: Extract<PlantLiteTraceEvent, { itemId: string }>["quality"],
    transport?: Extract<PlantLiteTraceEvent, { itemId: string }>["transport"],
  ): void;
  resource(
    type: Extract<PlantLiteTraceEvent, { resourceId: string }>["type"],
    atMinute: number,
    resourceId: string,
    unitIndex: number,
    unavailableUnits: number,
  ): void;
  finish(): PlantLiteReplicationTrace;
}

export interface NormalizedPlantLiteTraceOptions {
  replication: number;
  maxEvents: number;
  maxItems: number;
}

type PendingTraceEvent =
  | Omit<Extract<PlantLiteTraceEvent, { itemId: string }>, "sequence">
  | Omit<Extract<PlantLiteTraceEvent, { resourceId: string }>, "sequence">;

export function normalizeTraceOptions(input: PlantLiteTraceOptions | undefined, replications: number): NormalizedPlantLiteTraceOptions | undefined {
  if (!input) return undefined;
  const replication = input.replication ?? 0;
  if (!Number.isSafeInteger(replication) || replication < 0 || replication >= replications) {
    throw new RangeError(`trace.replication must be 0..${replications - 1}`);
  }
  return {
    replication,
    maxEvents: boundedInteger(input.maxEvents, DEFAULT_MAX_TRACE_EVENTS, 1, MAX_TRACE_EVENTS, "trace.maxEvents"),
    maxItems: boundedInteger(input.maxItems, DEFAULT_MAX_TRACE_ITEMS, 1, MAX_TRACE_ITEMS, "trace.maxItems"),
  };
}

export function createTraceRecorder(replication: number, seed: number, limits: Pick<NormalizedPlantLiteTraceOptions, "maxEvents" | "maxItems">): PlantLiteTraceRecorder {
  const events: PlantLiteTraceEvent[] = [];
  const capturedItems = new Set<string>();
  let sequence = 0;
  let omittedEventCount = 0;
  const append = (event: PendingTraceEvent) => {
    if (events.length >= limits.maxEvents) {
      omittedEventCount += 1;
      return;
    }
    events.push({ sequence: sequence++, ...event } as PlantLiteTraceEvent);
  };
  return {
    item(type, atMinute, itemId, nodeId, productTypeId, orderId, changeover, quality, transport) {
      if (events.length >= limits.maxEvents) {
        omittedEventCount += 1;
        return;
      }
      if (!capturedItems.has(itemId)) {
        if (capturedItems.size >= limits.maxItems) {
          omittedEventCount += 1;
          return;
        }
        capturedItems.add(itemId);
      }
      append({
        atMinute,
        type,
        itemId,
        nodeId,
        ...(productTypeId ? { productTypeId } : {}),
        ...(orderId ? { orderId } : {}),
        ...(changeover ? { changeover } : {}),
        ...(quality ? { quality } : {}),
        ...(transport ? { transport } : {}),
      });
    },
    resource(type, atMinute, resourceId, unitIndex, unavailableUnits) {
      append({ atMinute, type, resourceId, unitIndex, unavailableUnits });
    },
    finish() {
      return {
        engineId: "plant-lite-des",
        engineVersion: "1.0.0",
        replication,
        seed,
        events,
        capturedItemCount: capturedItems.size,
        omittedEventCount,
        truncated: omittedEventCount > 0,
        limits: { maxEvents: limits.maxEvents, maxItems: limits.maxItems },
      };
    },
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const numeric = value ?? fallback;
  if (!Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw new RangeError(`${label} must be ${minimum}..${maximum}`);
  }
  return numeric;
}
