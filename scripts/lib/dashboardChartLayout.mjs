import { captureDashboardMeasuredLayout, verifyDashboardMeasuredLayout } from "../../apps/api/src/dashboardMeasuredLayout.ts";

/** Measurements are derived server-side, never accepted from the author client. */
export async function measureFrozenDashboardCharts(source, input, host, signal) {
  if (!host) return;
  const candidate = { authority: source.freezeManifest.authority, manifest: source.freezeManifest,
    document: source.document, resources: source.resources, data: source.data };
  for (const node of input.document.application.pages.flatMap(page => page.nodes)) {
    signal?.throwIfAborted();
    if (node.kind !== "data-widget" || node.visible === false || node.widget.semanticBinding
      || !["bar", "line", "scatter", "pie"].includes(node.widget.type) || !input.data[node.id]
      || !input.nodeAssets[node.id]?.fonts?.length) continue;
    const orderedHost = { ...host, capture: (request, abort) => host.capture({ ...request,
      fonts: input.nodeAssets[node.id].fonts.map(id => request.fonts.find(font => font.id === id)) }, abort) };
    const record = await captureDashboardMeasuredLayout({ candidate, nodeId: node.id, host: orderedHost, locale: input.locale, signal });
    const measured = verifyDashboardMeasuredLayout(record, candidate);
    signal?.throwIfAborted();
    input.data[node.id] = { ...input.data[node.id], ...measured };
  }
}
