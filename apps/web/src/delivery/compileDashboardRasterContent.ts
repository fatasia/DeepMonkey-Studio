import { buildDashboardCompositionRuntimePackage, runtimeContentSha256,
  type DashboardRuntimePageV1, type Deep2dRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { compileDashboardLayout } from "./compileDashboardLayout";
import { rasterNode } from "./dashboardRasterNode";
import { assetIdentity, snapshotRasterInput, RASTER_BYTES_LIMIT } from "./dashboardRasterValidation";
import type { DashboardRasterCompileInput, DashboardRasterEvidence, DashboardRasterHost } from "./dashboardRasterTypes";

/** A frozen pixel compilation pass; publication authorization remains a separate operation. */
export async function compileDashboardRasterContent(source: DashboardRasterCompileInput, host: DashboardRasterHost) {
  const input = snapshotRasterInput(source);
  const first = compileDashboardLayout(input.document);
  const document = first.source, revision = document.application.metadata.revision;
  const pages: DashboardRuntimePageV1[] = [], deep2d: Deep2dRuntimePackage[] = [];
  const objects: Array<Awaited<ReturnType<typeof rasterNode>>["report"]> = [];
  const producerEvidence: DashboardRasterEvidence[] = [];
  const nodeBindings: Array<{ nodeId: string; runtimeNodeId: string; pageId: string; runtimePageId: string }> = [];
  const sourceSemanticHash = runtimeContentSha256({ document, locale: input.locale, nodeAssets: input.nodeAssets,
    assets: Object.fromEntries(Object.entries(input.assets).map(([id, asset]) => [id, assetIdentity(asset)])) });
  let atlasBytes = 0;
  for (const page of document.application.pages) {
    const layout = compileDashboardLayout(document, page.id);
    const nodes: DashboardRuntimePageV1["nodes"][number][] = [];
    for (const [index, node] of page.nodes.entries()) {
      const id = layout.nodeBindings[index]!.layoutId;
      nodeBindings.push({ nodeId: node.id, runtimeNodeId: id, pageId: page.id, runtimePageId: layout.tree.id });
      let content: Deep2dRuntimePackage;
      if (node.kind === "data-widget") {
        const result = await rasterNode(node, `${id}.content`, revision, input, host);
        content = result.content; objects.push(result.report);
        if (result.evidence) producerEvidence.push(result.evidence);
      } else {
        content = { schema: "deep-engine.deep2d-runtime", schemaVersion: 2, id: `${id}.content`, revision,
          composition: "z-ordered", displayList: { schemaVersion: 1, id: `${id}.paths`, revision,
            logicalWidth: node.frame.width, logicalHeight: node.frame.height, scaleFactor: 1, resources: [], commands: [] },
          atlases: [], quads: [] };
        objects.push({ nodeId: node.id, status: "blocked", contentCompiled: false,
          compiledFields: ["id", "frame", "zIndex", "visible"], deferredFields: Object.keys(node),
          reasons: ["Scene viewport requires the 3D compiler"] });
      }
      atlasBytes += content.atlases.reduce((sum, atlas) => sum + atlas.width * atlas.height * 4, 0);
      if (atlasBytes > RASTER_BYTES_LIMIT) throw new Error("Dashboard atlas byte budget exceeded");
      deep2d.push(content);
      nodes.push({ id, revision, frame: [node.frame.x, node.frame.y, node.frame.width, node.frame.height],
        clip: null, zOrder: node.zIndex, visible: node.visible !== false, hitId: null,
        deep2d: content.id, chart: null, chartSim: null });
    }
    nodes.sort((a, b) => a.zOrder - b.zOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    pages.push({ id: layout.tree.id, width: page.width, height: page.height, nodes });
  }
  const dashboard = { schema: "deep-engine.dashboard-runtime" as const, schemaVersion: 1 as const,
    id: `dashboard.${runtimeContentSha256(document.application.metadata.id)}`, revision,
    documentId: document.application.metadata.id, documentRevision: revision, entryPageId: first.tree.id, pages };
  const packageValue = buildDashboardCompositionRuntimePackage({ packageId: input.packageId,
    packageVersion: input.packageVersion, dashboard, deep2d, charts: [], chartSims: [] });
  const compileGraphHash = runtimeContentSha256({ sourceSemanticHash, pass: "dashboard-frozen-raster-v1", producerEvidence });
  return { schemaVersion: 1 as const, scope: "dashboard-frozen-raster" as const, publicationReady: false as const,
    sourceSemanticHash, compileGraphHash, targetArtifactHash: runtimeContentSha256(packageValue), package: packageValue,
    producerEvidence, nodeBindings, capabilityReport: { objects, contentCompiled: objects.filter(o => o.contentCompiled).length,
      degraded: objects.filter(o => o.status === "degraded").length, blocked: objects.filter(o => o.status === "blocked").length },
    deferredPageFields: document.application.pages.map(page => ({ pageId: page.id,
      fields: compileDashboardLayout(document, page.id).deferredPageFields })) };
}
