import type { ResourceResidencyController } from "./residencyController.js";
import type { ResidencyFramePlan, ResidencyUpload } from "./types.js";
import { GpuResidencyExecutorError, type ValidatedGpuResidencyPlan } from "./gpuResidencyExecutorTypes.js";

export function validateExecutorOptions(value: number | undefined): number {
  const resolved = value ?? 4;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 64) fail("invalid-options", "GPU upload concurrency must be an integer from 1 through 64.");
  return resolved;
}

export function validateExecutionPlan(controller: ResourceResidencyController, plan: ResidencyFramePlan): ValidatedGpuResidencyPlan {
  if (!plan || typeof plan !== "object" || !Number.isSafeInteger(plan.id) || plan.id < 1
    || !controller.isCurrentPlan(plan)
    || plan.baseRevision !== controller.revision || plan.residentBytesBefore !== controller.residentBytes
    || !Array.isArray(plan.uploads) || !Array.isArray(plan.evictions)) fail("invalid-plan", "GPU residency plan is stale or malformed.");
  const residents = new Map(controller.snapshot().map((state) => [state.id, state] as const));
  const uploads = new Map<string, ResidencyUpload>(); let uploadBytes = 0;
  for (const upload of plan.uploads) {
    if (!validUpload(upload) || uploads.has(upload.id)) fail("invalid-plan", "GPU residency plan contains an invalid or duplicate upload.");
    const profile = controller.profile(upload.id);
    const target = profile?.levels[upload.toLevel];
    if (!profile || upload.kind !== profile.kind || upload.toRevision !== profile.revision
      || !target || upload.byteLength !== target.byteLength) {
      fail("invalid-plan", `GPU residency upload target differs from its registered profile: ${upload.id}.`);
    }
    const current = residents.get(upload.id);
    if ((current?.revision ?? null) !== upload.fromRevision || (current?.level ?? null) !== upload.fromLevel) {
      fail("invalid-plan", `GPU residency upload source is stale: ${upload.id}.`);
    }
    uploads.set(upload.id, upload); uploadBytes += upload.byteLength;
  }
  if (uploadBytes !== plan.uploadBytes || uploadBytes > controller.budgets.maxUploadBytesPerFrame
    || plan.transitionPeakBytes > controller.budgets.maxResidentBytes) fail("invalid-plan", "GPU residency plan exceeds its byte budgets.");
  const beforeUpload = [], evictions = new Set<string>();
  for (const eviction of plan.evictions) {
    const key = `${eviction.phase}:${eviction.id}`;
    if (evictions.has(key)) fail("invalid-plan", `Duplicate GPU residency eviction: ${eviction.id}.`);
    evictions.add(key);
    const resident = residents.get(eviction.id);
    if (!resident || resident.kind !== eviction.kind || resident.revision !== eviction.revision
      || resident.level !== eviction.level || resident.byteLength !== eviction.byteLength) {
      fail("invalid-plan", `GPU residency eviction is stale: ${eviction.id}.`);
    }
    if (eviction.phase === "before-upload") beforeUpload.push(resident);
    else {
      const upload = uploads.get(eviction.id);
      if (!upload || upload.fromRevision === null) fail("invalid-plan", `After-swap eviction has no replacement: ${eviction.id}.`);
    }
  }
  for (const upload of uploads.values()) if (upload.fromRevision !== null && !evictions.has(`after-swap:${upload.id}`)) {
    fail("invalid-plan", `Replacement upload has no after-swap eviction: ${upload.id}.`);
  }
  return Object.freeze({ plan, beforeUpload: Object.freeze(beforeUpload) });
}

export function assertResourceHandle(value: unknown): asserts value is object {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) fail("invalid-handle", "GPU uploader returned an invalid resource handle.");
}

function validUpload(value: ResidencyUpload): boolean {
  return !!value && typeof value.id === "string" && value.id.length > 0
    && (value.kind === "geometry" || value.kind === "texture")
    && Number.isSafeInteger(value.toRevision) && value.toRevision >= 0
    && Number.isSafeInteger(value.toLevel) && value.toLevel >= 0
    && Number.isSafeInteger(value.byteLength) && value.byteLength > 0;
}
function fail(code: ConstructorParameters<typeof GpuResidencyExecutorError>[0], message: string): never {
  throw new GpuResidencyExecutorError(code, message);
}
