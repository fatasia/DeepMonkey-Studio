import { dashboardFilterDataVariants } from "../../apps/web/src/delivery/dashboardFilterDataVariants.ts";
import { dashboardDataRequestId } from "../../apps/api/src/dashboardDataRequestId.ts";
import { dashboardCanonicalJsonSha256 } from "../../apps/api/src/dashboardPublicationFreeze.ts";
import { measureFrozenDashboardCharts } from "./dashboardChartLayout.mjs";

/** Derived measurements remain compiler-owned and bind the exact variant bytes, not the original metric. */
export async function measureDashboardFilterVariants(source, input, host, signal) {
  const variants = dashboardFilterDataVariants(input);
  if (!variants.some(option => Object.keys(option.data).length)) return;
  if (!host) throw new Error("Filter data views require the trusted layout capture host");
  for (const option of variants) {
    signal?.throwIfAborted();
    if (process.env.DASHBOARD_COMPILER_TRACE === "1") console.info("filter layout start", option.value, Object.keys(option.data));
    const derived = structuredClone(source);
    for (const [nodeId, data] of Object.entries(option.data)) {
      const id = dashboardDataRequestId(nodeId), entry = derived.freezeManifest.data.find(item => item.id === id);
      if (!entry) throw new Error(`Filter source binding missing: ${nodeId}`);
      derived.data[id] = data;
      entry.sha256 = dashboardCanonicalJsonSha256(data);
      // The record hash is re-bound below; the original authority/source never changes.
      entry.bytes = Buffer.byteLength(JSON.stringify(data));
    }
    const { manifestSha256: _, ...body } = derived.freezeManifest;
    derived.freezeManifest.manifestSha256 = dashboardCanonicalJsonSha256(body);
    const variantInput = { ...input, data: option.data };
    await measureFrozenDashboardCharts(derived, variantInput, host, signal);
    if (process.env.DASHBOARD_COMPILER_TRACE === "1") console.info("filter layout done", option.value);
  }
  input.filterData = variants;
}
