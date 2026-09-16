import {
  CpuVisibleWorkingSet,
  spatialAabb,
  type CpuVisibleWorkingSetFrame,
  type SpatialFrustum,
  type VisibleObjectLodLevel,
} from "@bim-studio/deep-engine";
import { ResourceResidencyController, type ResidencyFramePlan } from "@bim-studio/deep-engine/streaming";

export const COMBINED_LOAD_SCENARIOS = ["open", "occluded", "dynamic"] as const;
export type CombinedLoadScenario = typeof COMBINED_LOAD_SCENARIOS[number];

export interface CombinedLoadBenchmarkProfile {
  readonly objectCount: number;
  readonly maxQueryCandidates: number;
  readonly maxRenderedObjects: number;
  readonly maxTriangles: number;
  readonly dynamicUpdates: number;
  readonly maxResidentBytes: number;
  readonly maxUploadBytesPerFrame: number;
  readonly samplesPerScenario: number;
}

export interface CombinedLoadScenarioPlan {
  readonly scenario: CombinedLoadScenario;
  readonly frame: number;
  readonly registryGeneration: number;
  readonly matchedObjects: number;
  readonly submittedObjects: number;
  readonly renderedObjects: number;
  readonly renderedTriangles: number;
  readonly batchCount: number;
  readonly postOcclusionDemandCount: number;
  readonly gpuStages: readonly ("gpu-lod" | "hi-z" | "meshlet-indirect" | "residency")[];
  readonly residency: Readonly<Pick<ResidencyFramePlan,
    "uploadBytes" | "transitionPeakBytes" | "residentBytesBefore" | "residentBytesAfter"> & {
      readonly uploads: number; readonly evictions: number;
    }>;
}

export interface CombinedLoadBenchmarkPlan {
  readonly schema: 1;
  readonly profile: Readonly<CombinedLoadBenchmarkProfile>;
  readonly scenarios: readonly CombinedLoadScenarioPlan[];
  readonly unload: Readonly<{ residentBytesBefore: number; residentBytesAfter: number; evictions: number }>;
}

export const DEFAULT_COMBINED_LOAD_PROFILE: Readonly<CombinedLoadBenchmarkProfile> = Object.freeze({
  objectCount: 10_000,
  maxQueryCandidates: 2_048,
  maxRenderedObjects: 1_024,
  maxTriangles: 32_768,
  dynamicUpdates: 512,
  maxResidentBytes: 512 * 1024,
  maxUploadBytesPerFrame: 256 * 1024,
  samplesPerScenario: 5,
});

const FRUSTUM: SpatialFrustum = Object.freeze({ planes: Object.freeze([
  [1, 0, 0, 64], [-1, 0, 0, 64], [0, 1, 0, 64],
  [0, -1, 0, 64], [0, 0, 1, 0], [0, 0, -1, 160],
] as const) });
const LEVELS: readonly VisibleObjectLodLevel[] = Object.freeze([
  Object.freeze({ geometryId: "benchmark-high", minProjectedDiameterPixels: 90, geometricError: 0, triangles: 512 }),
  Object.freeze({ geometryId: "benchmark-mid", minProjectedDiameterPixels: 30, geometricError: 0.5, triangles: 128 }),
  Object.freeze({ geometryId: "benchmark-coarse", minProjectedDiameterPixels: 0, geometricError: 2, triangles: 32 }),
]);

/** Builds the same 10k-object octree/LOD/residency workload on every machine; it records plans, not throughput claims. */
export function createCombinedLoadBenchmarkPlan(
  profile: Readonly<CombinedLoadBenchmarkProfile> = DEFAULT_COMBINED_LOAD_PROFILE,
): CombinedLoadBenchmarkPlan {
  validateProfile(profile);
  const workingSet = new CpuVisibleWorkingSet<string>({
    bounds: spatialAabb([-64, -64, 0], [64, 64, 160]),
    maxEntries: profile.objectCount,
    maxNodes: Math.max(1_024, profile.objectCount * 8),
  });
  for (let index = 0; index < profile.objectCount; index += 1) {
    const x = index % 100 - 50, y = Math.floor(index / 100) % 100 - 50;
    const z = 48 + Math.floor(index / 10_000) * 8;
    workingSet.register({ id: `object-${index.toString().padStart(5, "0")}`, instanceId: index,
      bounds: spatialAabb([x, y, z], [x + 0.5, y + 0.5, z + 0.5]),
      materialId: `material-${index % 8}`, levels: LEVELS, priority: index % 17 });
  }
  const controller = new ResourceResidencyController({
    maxResidentBytes: profile.maxResidentBytes,
    maxUploadBytesPerFrame: profile.maxUploadBytesPerFrame,
    maxResources: profile.objectCount,
    retainFrames: 0,
  });
  for (let index = 0; index < profile.objectCount; index += 1) controller.register({
    id: `object-${index.toString().padStart(5, "0")}`, revision: 1, kind: "geometry",
    levels: [{ level: 0, byteLength: 4_096 }, { level: 1, byteLength: 1_024 },
      { level: 2, byteLength: 256 }],
  });

  const openFrame = buildFrame(workingSet, profile, false);
  const plans: CombinedLoadScenarioPlan[] = [];
  plans.push(scenarioPlan("open", openFrame, residencyPlan(controller, 1,
    openFrame.candidates.map(candidate => String(candidate.objectId))), openFrame.candidates.length));

  // Static checkerboard occluders leave half the CPU candidates for residency feedback.
  const occludedIds = openFrame.candidates.filter((_, index) => index % 2 === 0)
    .map(candidate => String(candidate.objectId));
  const occludedFrame = buildFrame(workingSet, profile, false);
  plans.push(scenarioPlan("occluded", occludedFrame,
    residencyPlan(controller, 2, occludedIds), occludedIds.length));

  for (let index = 0; index < profile.dynamicUpdates; index += 1) {
    const x = index % 64 - 32, y = Math.floor(index / 64) - 4;
    workingSet.update(`object-${index.toString().padStart(5, "0")}`, {
      bounds: spatialAabb([x + 0.25, y, 40], [x + 0.75, y + 0.5, 40.5]),
    });
  }
  workingSet.resetForCameraJump();
  const dynamicFrame = buildFrame(workingSet, profile, true);
  plans.push(scenarioPlan("dynamic", dynamicFrame, residencyPlan(controller, 3,
    dynamicFrame.candidates.map(candidate => String(candidate.objectId))), dynamicFrame.candidates.length));

  const unloadPlan = controller.planFrame(10, []);
  controller.commit(unloadPlan, new Set());
  const unload = Object.freeze({ residentBytesBefore: unloadPlan.residentBytesBefore,
    residentBytesAfter: controller.residentBytes, evictions: unloadPlan.evictions.length });
  return Object.freeze({ schema: 1, profile: Object.freeze({ ...profile }),
    scenarios: Object.freeze(plans), unload });
}

function buildFrame(set: CpuVisibleWorkingSet<string>, profile: CombinedLoadBenchmarkProfile,
  cameraJump: boolean): CpuVisibleWorkingSetFrame<string> {
  return set.buildFrame({ frustum: FRUSTUM, camera: { projection: "perspective",
    position: cameraJump ? [0.5, 0, 0] : [0, 0, 0], forward: [0, 0, 1],
    verticalFovRadians: Math.PI / 2, near: 0.1, far: 200 }, viewport: { width: 1_920, height: 1_080 },
  maxQueryCandidates: profile.maxQueryCandidates,
  budget: { maxObjects: profile.maxRenderedObjects, maxTriangles: profile.maxTriangles } });
}

function residencyPlan(controller: ResourceResidencyController, frame: number,
  ids: readonly string[]): ResidencyFramePlan {
  const plan = controller.planFrame(frame, ids.map((id, index) => ({ id, desiredLevel: 0,
    priority: ids.length - index })));
  controller.commit(plan, new Set(plan.uploads.map(upload => upload.id)));
  return plan;
}

function scenarioPlan(scenario: CombinedLoadScenario, frame: CpuVisibleWorkingSetFrame<string>,
  residency: ResidencyFramePlan, postOcclusionDemandCount: number): CombinedLoadScenarioPlan {
  const stages = scenario === "occluded"
    ? ["gpu-lod", "hi-z", "meshlet-indirect", "residency"] as const
    : ["gpu-lod", "meshlet-indirect", "residency"] as const;
  return Object.freeze({ scenario, frame: frame.revision, registryGeneration: frame.generation,
    matchedObjects: frame.query.matchedEntries, submittedObjects: frame.query.submittedToLod,
    renderedObjects: frame.candidates.length, renderedTriangles: frame.renderedTriangles,
    batchCount: frame.batches.length, postOcclusionDemandCount, gpuStages: Object.freeze(stages),
    residency: Object.freeze({ uploadBytes: residency.uploadBytes,
      transitionPeakBytes: residency.transitionPeakBytes,
      residentBytesBefore: residency.residentBytesBefore, residentBytesAfter: residency.residentBytesAfter,
      uploads: residency.uploads.length, evictions: residency.evictions.length }) });
}

function validateProfile(profile: CombinedLoadBenchmarkProfile): void {
  const integers = [profile.objectCount, profile.maxQueryCandidates, profile.maxRenderedObjects,
    profile.maxTriangles, profile.dynamicUpdates, profile.maxResidentBytes,
    profile.maxUploadBytesPerFrame, profile.samplesPerScenario];
  if (!integers.every(value => Number.isSafeInteger(value) && value > 0)
    || profile.maxQueryCandidates > profile.objectCount
    || profile.maxRenderedObjects > profile.maxQueryCandidates
    || profile.dynamicUpdates > profile.objectCount
    || profile.maxUploadBytesPerFrame > profile.maxResidentBytes) {
    throw new RangeError("Combined load benchmark profile is invalid.");
  }
}
