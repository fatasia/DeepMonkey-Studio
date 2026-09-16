import { DASHBOARD_RUNTIME_BUDGETS, type DashboardRuntimeV1 } from "./dashboardCompositionTypes.js";
import type { DashboardCandidateIdentity, DashboardCandidateOptions } from "./dashboardCandidateTypes.js";
import { RuntimePackageError, snapshotJson } from "./primitives.js";
import { validateDeepRuntimePackage } from "./validation.js";

/** Snapshot and reject stale events before any loader or host allocation. */
export function prepareDashboardCandidateRequest(input: unknown, requested: DashboardCandidateOptions,
  source?: DashboardCandidateIdentity) {
  const checked = validateDeepRuntimePackage(input);
  if (!checked.valid) throw new RuntimePackageError(checked.issues[0]!.path, checked.issues[0]!.message);
  if (checked.value.schemaVersion !== 5) throw new Error("Dashboard candidates require runtime package v5.");
  const value = checked.value, options = snapshotOptions(requested);
  const root = value.payloads[value.entrypoints.dashboard] as unknown as DashboardRuntimeV1;
  // Updates belong to their captured page; only an unbound publication starts at the entry page.
  const page = root.pages.find(page => page.id === (options.pageId ?? options.expectedSource?.pageId ?? root.entryPageId));
  if (!page) throw new Error("Unknown dashboard page.");
  if (options.updates !== undefined || options.elapsedMs !== undefined || options.expectedSource !== undefined) {
    const expected = options.expectedSource;
    if (!source || !expected || source.packageHash !== value.packageHash.value || source.pageId !== page.id
      || source.packageHash !== expected.packageHash || source.pageId !== expected.pageId
      || source.generation !== expected.generation || source.deviceEpoch !== expected.deviceEpoch) {
      throw new Error("Dashboard update source identity does not match the active publication.");
    }
  }
  if (!Number.isSafeInteger(options.deviceEpoch) || options.deviceEpoch < 0) throw new Error("Invalid device epoch.");
  return { value, options, page };
}

function snapshotOptions(options: DashboardCandidateOptions): DashboardCandidateOptions {
  if ((options.updates?.length ?? 0) > DASHBOARD_RUNTIME_BUDGETS.nodes) throw new Error("Too many dashboard updates.");
  return { ...options, ...(options.updates ? { updates: options.updates.map(update => ({
    nodeId: update.nodeId, message: snapshotJson(update.message),
  })) } : {}) };
}
