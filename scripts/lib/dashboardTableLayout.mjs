import { dashboardTableInteractionPlan } from "../../apps/web/src/delivery/dashboardTableInteractionPlan.ts";
import { captureDashboardMeasuredLayout, verifyDashboardMeasuredLayout } from "../../apps/api/src/dashboardMeasuredLayout.ts";
import { dashboardDataRequestId } from "../../apps/api/src/dashboardDataRequestId.ts";
import { dashboardCanonicalJsonSha256 } from "../../apps/api/src/dashboardPublicationFreeze.ts";

/** Each view is measured by the real Web component with the same frozen fonts and report semantics. */
export async function measureDashboardTableViews(source, input, host, signal) {
  const tables = []; let viewCount = 0;
  for (const node of input.document.application.pages.flatMap(page => page.nodes)) {
    if (node.kind !== "data-widget" || node.widget.type !== "table" || node.visible === false || node.widget.semanticBinding) continue;
    if (!host) throw new Error("Interactive tables require the trusted layout capture host");
    const variants = input.filterData?.length ? input.filterData.map(option => option.data[node.id] ?? input.data[node.id]) : [input.data[node.id]];
    const families = [];
    for (const data of variants) {
      signal?.throwIfAborted();
      if (!data) throw new Error(`Frozen table data missing: ${node.id}`);
      const orders = await dashboardTableInteractionPlan(node.widget, data.metric, signal);
      viewCount += orders.reduce((sum, order) => sum + order.pages.length, 0);
      if (viewCount > 512) throw new Error("Frozen table view budget exceeded (512)");
      const derived = structuredClone(source), dataId = dashboardDataRequestId(node.id);
      const entry = derived.freezeManifest.data.find(item => item.id === dataId);
      if (!entry) throw new Error(`Frozen table binding missing: ${node.id}`);
      derived.data[dataId] = data; entry.sha256 = dashboardCanonicalJsonSha256(data);
      entry.bytes = Buffer.byteLength(JSON.stringify(data));
      const { manifestSha256: _, ...body } = derived.freezeManifest;
      derived.freezeManifest.manifestSha256 = dashboardCanonicalJsonSha256(body);
      const candidate = { authority: derived.freezeManifest.authority, manifest: derived.freezeManifest,
        document: derived.document, resources: derived.resources, data: derived.data };
      const measured = [];
      for (const order of orders) {
        const pages = [];
        for (const state of order.pages) {
          signal?.throwIfAborted();
          const table = { page: state.page, scrollLeft: 0, ...(state.sort ? { sort: state.sort } : {}) };
          const orderedHost = { ...host, capture: (request, abort) => host.capture({ ...request,
            fonts: input.nodeAssets[node.id].fonts.map(id => request.fonts.find(font => font.id === id)) }, abort) };
          const record = await captureDashboardMeasuredLayout({ candidate, nodeId: node.id, host: orderedHost, locale: input.locale, table, signal });
          const value = verifyDashboardMeasuredLayout(record, candidate);
          // Empty state has no table DOM, but still carries the compiler-owned initial state.
          if (data.metric.rows?.length !== 0 && dashboardCanonicalJsonSha256(value.table) !== dashboardCanonicalJsonSha256(table))
            throw new Error(`Captured table view differs from requested state: ${node.id}`);
          signal?.throwIfAborted();
          pages.push({ ...data, ...value, table });
        }
        measured.push({ ...order, pages });
      }
      families.push(measured);
    }
    tables.push({ nodeId: node.id, families });
  }
  // No partial table plan becomes visible if capture or cancellation fails.
  return tables;
}
