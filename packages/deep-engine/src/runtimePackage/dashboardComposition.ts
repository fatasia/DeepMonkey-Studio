import { buildDeepRuntimePackage } from "./builder.js";
import { runtimeContentSha256, runtimePackageSha256 } from "./hash.js";
import { requireValue, snapshotJson } from "./primitives.js";
import { validateDeepRuntimePackage } from "./validation.js";
import { DEEP_RUNTIME_PACKAGE_DASHBOARD_VERSION, type BuildDashboardCompositionRuntimePackageInput } from "./dashboardCompositionTypes.js";
import type { DeepRuntimePackageV5, RuntimeJson, RuntimeResourceKind } from "./types.js";

/** Compose already-lowered resources without changing the legacy static dashboard producer. */
export function buildDashboardCompositionRuntimePackage(input: BuildDashboardCompositionRuntimePackageInput): DeepRuntimePackageV5 {
  const base = buildDeepRuntimePackage({ packageId: input.packageId, packageVersion: input.packageVersion,
    renderPacket: { id: `dashboard.scene.${runtimeContentSha256([input.packageId, input.dashboard.id])}`,
      revision: input.dashboard.revision, value: { geometries: [], materials: [], instances: [], textures: [] } },
  });
  const payloads: Record<string, RuntimeJson> = Object.assign(Object.create(null), base.payloads);
  const resources = [...base.resources];
  const add = (value: { readonly id: string; readonly revision: number }, kind: RuntimeResourceKind) => {
    requireValue(!Object.hasOwn(payloads, value.id), "$.resources", "Duplicate resource id.");
    const payload = snapshotJson(value);
    payloads[value.id] = payload;
    resources.push({ id: value.id, revision: value.revision, kind,
      contentHash: { algorithm: "sha256", value: runtimeContentSha256(payload) } });
  };
  add(input.dashboard, "dashboard-runtime");
  for (const value of input.deep2d) add(value, "deep2d-runtime");
  for (const value of input.charts) add(value, "chart-runtime");
  for (const value of input.chartSims) add(value, "chart-sim-runtime");
  resources.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const core = { ...base, schemaVersion: DEEP_RUNTIME_PACKAGE_DASHBOARD_VERSION, materialBindings: [],
    entrypoints: { ...base.entrypoints, chart: null, chartSim: null, dashboard: input.dashboard.id }, resources, payloads };
  const result = validateDeepRuntimePackage({ ...core, packageHash: { algorithm: "sha256", value: runtimePackageSha256(core) } });
  if (!result.valid) {
    const dashboard = payloads[input.dashboard.id] as { pages?: readonly { nodes?: readonly unknown[] }[] } | undefined;
    const nodes = dashboard?.pages?.reduce((sum, page) => sum + (page.nodes?.length ?? 0), 0) ?? 0;
    const issue = result.issues[0];
    throw new Error(
      `${issue?.message ?? "Invalid dashboard composition."}${issue?.path ? ` at ${issue.path}` : ""} ` +
        `resources=${resources.length}, nodes=${nodes}`
    );
  }
  return result.value as DeepRuntimePackageV5;
}
