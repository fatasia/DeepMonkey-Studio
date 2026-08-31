import {
  assertPlantLiteModel,
  type PlantLiteExperiment,
  type PlantLiteExperimentResult,
  type SimulationLimits,
} from "./model.js";
import { replicationMetrics, summarizeExperiment } from "./metrics.js";
import { mixSeed, seedNumber } from "./random.js";
import { runReplication } from "./runtime.js";

const DEFAULT_DURATION_MINUTES = 480;
const DEFAULT_MAX_EVENTS = 100_000;
const DEFAULT_MAX_RESOURCES = 100;
const MAX_DURATION_MINUTES = 52_560;
const MAX_EVENTS = 1_000_000;
const MAX_REPLICATIONS = 1_000;

/** 同步内核不发起 I/O；服务端应在 Worker 中调用它，并传入协作取消回调。 */
export function runPlantLiteExperiment(input: PlantLiteExperiment, options: { shouldCancel?: () => boolean } = {}): PlantLiteExperimentResult {
  const model = assertPlantLiteModel(input.model);
  const replications = normalizeReplications(input.replications);
  const limits = normalizeLimits(input.limits, model.resources?.reduce((sum, resource) => sum + resource.capacity, 0) ?? 0);
  const rootSeed = seedNumber(input.seed);
  const runs = [];
  for (let index = 0; index < replications; index += 1) {
    if (options.shouldCancel?.()) break;
    const seed = mixSeed(rootSeed, index);
    runs.push(runReplication(model, index, seed, limits, options.shouldCancel, (runtime, termination, reason) => replicationMetrics(runtime, index, seed, termination, reason)));
  }
  return summarizeExperiment(input.seed, runs);
}

function normalizeReplications(value: number | undefined): number {
  const replications = value ?? 10;
  if (!Number.isSafeInteger(replications) || replications < 1 || replications > MAX_REPLICATIONS) {
    throw new RangeError(`replications must be 1..${MAX_REPLICATIONS}`);
  }
  return replications;
}

function normalizeLimits(input: SimulationLimits | undefined, resourceUnits: number): Required<SimulationLimits> {
  const limits = {
    durationMinutes: input?.durationMinutes ?? DEFAULT_DURATION_MINUTES,
    maxEvents: input?.maxEvents ?? DEFAULT_MAX_EVENTS,
    maxResources: input?.maxResources ?? DEFAULT_MAX_RESOURCES,
  };
  if (!Number.isFinite(limits.durationMinutes) || limits.durationMinutes <= 0 || limits.durationMinutes > MAX_DURATION_MINUTES) {
    throw new RangeError(`durationMinutes must be 0..${MAX_DURATION_MINUTES}`);
  }
  if (!Number.isSafeInteger(limits.maxEvents) || limits.maxEvents < 1 || limits.maxEvents > MAX_EVENTS) {
    throw new RangeError(`maxEvents must be 1..${MAX_EVENTS}`);
  }
  if (!Number.isSafeInteger(limits.maxResources) || limits.maxResources < 1) {
    throw new RangeError("maxResources must be a positive integer");
  }
  if (resourceUnits > limits.maxResources) {
    throw new RangeError(`resource capacity ${resourceUnits} exceeds maxResources ${limits.maxResources}`);
  }
  return limits;
}
