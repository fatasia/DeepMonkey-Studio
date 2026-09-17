import { buildDashboardCompositionRuntimePackage, runtimeContentSha256,
  type DashboardRuntimePageV1, type Deep2dRuntimePackage, type ChartIrRuntimeValue } from "@bim-studio/deep-engine/runtime-package";
import { lowerDashboardChart } from "./lowerDashboardChart";
import { compileDashboardLayouts } from "./compileDashboardLayout";
import { cssSrgbToLinearColor } from "./dashboardColor";
import { parseHexColor } from "./dashboardShapeContent";
import { rasterNode } from "./dashboardRasterNode";
import { compileDashboardPageImage } from "./dashboardPageImage";
import { assetIdentity, snapshotRasterInput, RASTER_BYTES_LIMIT } from "./dashboardRasterValidation";
import type { DashboardRasterCompileInput, DashboardRasterEvidence, DashboardRasterHost } from "./dashboardRasterTypes";

/** A frozen pixel compilation pass; publication authorization remains a separate operation. */
export async function compileDashboardRasterContent(source: DashboardRasterCompileInput, host: DashboardRasterHost) {
  const input = snapshotRasterInput(source);
  const layouts = compileDashboardLayouts(input.document);
  const document = layouts.source, revision = document.application.metadata.revision;
  const first = layouts.pages.find(page => page.pageId === document.entryPageId)!;
  const pages: DashboardRuntimePageV1[] = [], deep2d: Deep2dRuntimePackage[] = [], charts: ChartIrRuntimeValue[] = [];
  const objects: Array<Awaited<ReturnType<typeof rasterNode>>["report"]> = [];
  const producerEvidence: DashboardRasterEvidence[] = [];
  const pageImageEvidence: NonNullable<Awaited<ReturnType<typeof compileDashboardPageImage>>>["evidence"][] = [];
  const pageDeferred: Array<{ pageId: string; fields: string[] }> = [];
  const nodeBindings: Array<{ nodeId: string; runtimeNodeId: string; runtimeNodeIds: string[]; pageId: string; runtimePageId: string }> = [];
  const sourceSemanticHash = runtimeContentSha256({ document, locale: input.locale, nodeAssets: input.nodeAssets,
    ...(input.pageAssets ? { pageAssets: input.pageAssets } : {}),
    ...(input.data ? { data: input.data } : {}),
    assets: Object.fromEntries(Object.entries(input.assets).map(([id, asset]) => [id, assetIdentity(asset)])) });
  let atlasBytes = 0;
  for (const [pageIndex, page] of document.application.pages.entries()) {
    const layout = layouts.pages[pageIndex]!;
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
          clip: layer.clip, zOrder: nodes.length + 1, visible: node.visible !== false, hitId: null,
          deep2d: layer.content.id, chart: layerIndex === 0 ? chart : null, chartSim: null });
      }
    }
    const background = pageBackground(page, layout.tree.id, revision);
    const image = background ? await compileDashboardPageImage(page, background.content, input, host, atlasBytes) : null;
    if (image) { background!.content = image.content; atlasBytes += image.bytes; pageImageEvidence.push(image.evidence); }
    pageDeferred.push({ pageId: page.id, fields: deferredPageFields(page, Boolean(background), Boolean(image)) });
    if (background) {
      deep2d.push(background.content);
      nodes.unshift({ id: background.nodeId, revision, frame: [0, 0, page.width, page.height], clip: null,
        zOrder: 0, visible: true, hitId: null, deep2d: background.content.id, chart: null, chartSim: null });
    }
    pages.push({ id: layout.tree.id, width: page.width, height: page.height, nodes });
  }
  const dashboard = { schema: "deep-engine.dashboard-runtime" as const, schemaVersion: 1 as const,
    id: `dashboard.${runtimeContentSha256(document.application.metadata.id)}`, revision,
    documentId: document.application.metadata.id, documentRevision: revision, entryPageId: first.tree.id, pages };
  const packageValue = buildDashboardCompositionRuntimePackage({ packageId: input.packageId,
    packageVersion: input.packageVersion, dashboard, deep2d, charts, chartSims: [] });
  const compileGraphHash = runtimeContentSha256({ sourceSemanticHash, pass: "dashboard-frozen-raster-v5", producerEvidence, pageImageEvidence });
  return { schemaVersion: 1 as const, scope: "dashboard-frozen-raster" as const, publicationReady: false as const,
    sourceSemanticHash, compileGraphHash, targetArtifactHash: runtimeContentSha256(packageValue), package: packageValue,
    producerEvidence, pageImageEvidence, nodeBindings, capabilityReport: { objects, contentCompiled: objects.filter(o => o.contentCompiled).length,
      degraded: objects.filter(o => o.status === "degraded").length, blocked: objects.filter(o => o.status === "blocked").length },
    deferredPageFields: pageDeferred };
}

const PAGE_BACKGROUND_DEFAULT = "#12191d";

function pageBackground(page: DashboardRasterCompileInput["document"]["application"]["pages"][number], pageId: string, revision: number) {
  const color = page.appearance?.backgroundColor ?? PAGE_BACKGROUND_DEFAULT;
  if (!/^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(color)) return null;
  let fill;
  try { fill = cssSrgbToLinearColor(parseHexColor(color)); } catch { return null; }
  const id = `${pageId}.background`, pathId = `${id}.path`;
  const content: Deep2dRuntimePackage = { schema: "deep-engine.deep2d-runtime", schemaVersion: 2, id, revision,
    composition: "z-ordered", displayList: { schemaVersion: 1, id: `${id}.display-list`, revision,
      logicalWidth: page.width, logicalHeight: page.height, scaleFactor: 1,
      resources: [{ kind: "path", id: pathId, revision, verbs: [
        { op: "move", x: 0, y: 0 }, { op: "line", x: page.width, y: 0 },
        { op: "line", x: page.width, y: page.height }, { op: "line", x: 0, y: page.height }, { op: "close" },
      ] }], commands: [{ kind: "path", id: `${pathId}.draw`, pathId, zOrder: 0,
        transform: [1, 0, 0, 1, 0, 0], fill }] }, atlases: [], quads: [] };
  return { nodeId: `node.${runtimeContentSha256([pageId, "background"])}`, content };
}

function deferredPageFields(page: DashboardRasterCompileInput["document"]["application"]["pages"][number], backgroundCompiled: boolean, imageCompiled: boolean) {
  const fields = Object.keys(page).filter(field => !["id", "width", "height", "nodes", "appearance"].includes(field));
  if (page.appearance) fields.push(...Object.keys(page.appearance)
    .filter(field => !(field === "backgroundColor" && backgroundCompiled)
      && !(imageCompiled && ["backgroundImageUrl", "backgroundImageFit", "backgroundImagePosition", "backgroundImageRepeat"].includes(field)))
    .map(field => `appearance.${field}`));
  return fields;
}
