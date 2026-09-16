import { buildDashboardCompositionRuntimePackage, runtimeContentSha256,
  type DashboardRuntimePageV1, type Deep2dRuntimePackage, type ChartIrRuntimeValue } from "@bim-studio/deep-engine/runtime-package";
import { lowerDashboardChart } from "./lowerDashboardChart";
import { compileDashboardLayout } from "./compileDashboardLayout";
import { rasterNode } from "./dashboardRasterNode";
import { assetIdentity, snapshotRasterInput, RASTER_BYTES_LIMIT } from "./dashboardRasterValidation";
import type { DashboardRasterCompileInput, DashboardRasterEvidence, DashboardRasterHost } from "./dashboardRasterTypes";

/** A frozen pixel compilation pass; publication authorization remains a separate operation. */
export async function compileDashboardRasterContent(source: DashboardRasterCompileInput, host: DashboardRasterHost) {
  const input = snapshotRasterInput(source);
  const first = compileDashboardLayout(input.document);
  const document = first.source, revision = document.application.metadata.revision;
  const pages: DashboardRuntimePageV1[] = [], deep2d: Deep2dRuntimePackage[] = [], charts: ChartIrRuntimeValue[] = [];
  const objects: Array<Awaited<ReturnType<typeof rasterNode>>["report"]> = [];
  const producerEvidence: DashboardRasterEvidence[] = [];
  const nodeBindings: Array<{ nodeId: string; runtimeNodeId: string; runtimeNodeIds: string[]; pageId: string; runtimePageId: string }> = [];
  const sourceSemanticHash = runtimeContentSha256({ document, locale: input.locale, nodeAssets: input.nodeAssets,
    ...(input.data ? { data: input.data } : {}),
    assets: Object.fromEntries(Object.entries(input.assets).map(([id, asset]) => [id, assetIdentity(asset)])) });
  let atlasBytes = 0;
  for (const page of document.application.pages) {
    const layout = compileDashboardLayout(document, page.id);
    const nodes: DashboardRuntimePageV1["nodes"][number][] = [];
    const ordered = page.nodes.map((node, index) => ({ node, id: layout.nodeBindings[index]!.layoutId }))
      .sort((a, b) => a.node.zIndex - b.node.zIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const { node, id } of ordered) {
      const mapping = { nodeId: node.id, runtimeNodeId: id, runtimeNodeIds: [] as string[], pageId: page.id, runtimePageId: layout.tree.id };
      nodeBindings.push(mapping);
      let content: Deep2dRuntimePackage, chart: string | null = null;
      let layers: Array<{ content: Deep2dRuntimePackage; clip: readonly [number, number, number, number] | null }> | undefined;
      if (node.kind === "data-widget") {
        const result = await rasterNode(node, `${id}.content`, revision, input, host);
        content = result.content; layers = result.layers;
        if (!["text", "image", "shape", "value", "table"].includes(node.widget.type)) {
          const data = input.data?.[node.id];
          const lowered = lowerDashboardChart({ nodeId: id, revision, widget: node.widget, ...(data ? { data } : {}) });
          result.report.reasons.push(...lowered.diagnostics.map(diagnostic => `${diagnostic.path}: ${diagnostic.message}`));
          if (lowered.chart) { charts.push({ schema: "deep-engine.chart-runtime", schemaVersion: 1, id: lowered.chart.id,
              revision: lowered.chart.revision, chart: JSON.parse(JSON.stringify(lowered.chart.value)) }); chart = lowered.chart.id;
            result.report.contentCompiled = true;
            result.report.status = "degraded";
            result.report.reasons = result.report.reasons.filter(reason => !reason.startsWith("图表内容经 ChartIR"));
            result.report.reasons.push("Frozen chart data is compiled into ChartIR; Web appearance and interactions remain deferred");
          }
        }
        objects.push(result.report);
        producerEvidence.push(...result.evidence);
      } else {
        content = { schema: "deep-engine.deep2d-runtime", schemaVersion: 2, id: `${id}.content`, revision,
          composition: "z-ordered", displayList: { schemaVersion: 1, id: `${id}.paths`, revision,
            logicalWidth: node.frame.width, logicalHeight: node.frame.height, scaleFactor: 1, resources: [], commands: [] },
          atlases: [], quads: [] };
        objects.push({ nodeId: node.id, status: "blocked", contentCompiled: false,
          compiledFields: ["id", "frame", "zIndex", "visible"], deferredFields: Object.keys(node),
          reasons: ["Scene viewport requires the 3D compiler"] });
      }
      for (const [layerIndex, layer] of (layers ?? [{ content, clip: null }]).entries()) {
        atlasBytes += layer.content.atlases.reduce((sum, atlas) => sum + atlas.width * atlas.height * 4, 0);
        if (atlasBytes > RASTER_BYTES_LIMIT) throw new Error("Dashboard atlas byte budget exceeded");
        const runtimeId = layerIndex === 0 ? id : `node.${runtimeContentSha256([id, "content-layer", layerIndex])}`;
        mapping.runtimeNodeIds.push(runtimeId); deep2d.push(layer.content);
        nodes.push({ id: runtimeId, revision, frame: [node.frame.x, node.frame.y, node.frame.width, node.frame.height],
          clip: layer.clip, zOrder: nodes.length, visible: node.visible !== false, hitId: null,
          deep2d: layer.content.id, chart: layerIndex === 0 ? chart : null, chartSim: null });
      }
    }
    pages.push({ id: layout.tree.id, width: page.width, height: page.height, nodes });
  }
  const dashboard = { schema: "deep-engine.dashboard-runtime" as const, schemaVersion: 1 as const,
    id: `dashboard.${runtimeContentSha256(document.application.metadata.id)}`, revision,
    documentId: document.application.metadata.id, documentRevision: revision, entryPageId: first.tree.id, pages };
  const packageValue = buildDashboardCompositionRuntimePackage({ packageId: input.packageId,
    packageVersion: input.packageVersion, dashboard, deep2d, charts, chartSims: [] });
  const compileGraphHash = runtimeContentSha256({ sourceSemanticHash, pass: "dashboard-frozen-raster-v3", producerEvidence });
  return { schemaVersion: 1 as const, scope: "dashboard-frozen-raster" as const, publicationReady: false as const,
    sourceSemanticHash, compileGraphHash, targetArtifactHash: runtimeContentSha256(packageValue), package: packageValue,
    producerEvidence, nodeBindings, capabilityReport: { objects, contentCompiled: objects.filter(o => o.contentCompiled).length,
      degraded: objects.filter(o => o.status === "degraded").length, blocked: objects.filter(o => o.status === "blocked").length },
    deferredPageFields: document.application.pages.map(page => ({ pageId: page.id,
      fields: compileDashboardLayout(document, page.id).deferredPageFields })) };
}
