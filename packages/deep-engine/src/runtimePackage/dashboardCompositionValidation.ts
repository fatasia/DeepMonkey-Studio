import { validateRuntimeChartPackage, validateRuntimeChartSimPackage } from "./chartPackage.js";
import { validateRuntimeDeep2d } from "./deep2d.js";
import { DASHBOARD_RUNTIME_BUDGETS as LIMITS } from "./dashboardCompositionTypes.js";
import { array, fields, integer, record, requireValue, revision, string } from "./primitives.js";
import type { RuntimeResourceKind } from "./types.js";
import { ChartSimulationSource } from "../chartSimulation.js";
import type { ChartIR } from "../chartIr.js";

type ResourceIndex = ReadonlyMap<string, { readonly revision: number }>;
type UseResource = (value: unknown, kind: RuntimeResourceKind) => string;
const MAX_COORDINATE = 16_777_216;
function positive(value: unknown, path: string): void {
  requireValue(typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_COORDINATE, path, "Invalid logical dimension.");
}
function rect(value: unknown, path: string): void {
  const values = array(value, path, 4);
  requireValue(values.length === 4 && values.every(v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_COORDINATE), path, "Invalid logical rectangle.");
  positive(values[2], `${path}[2]`); positive(values[3], `${path}[3]`);
}
function identity(value: unknown, prefix: "page" | "node", path: string): string {
  const result = string(value, path);
  requireValue(new RegExp(`^${prefix}\\.[a-f0-9]{64}$`).test(result), path, "Expected a stable compiled identity.");
  return result;
}

/** References are consumed through the envelope's ownership set, including across pages. */
export function validateDashboardComposition(payload: unknown, id: string, index: ResourceIndex,
  payloads: Readonly<Record<string, unknown>>, use: UseResource): void {
  const path = `$.payloads.${id}`, root = record(payload, path);
  fields(root, ["schema", "schemaVersion", "id", "revision", "documentId", "documentRevision", "entryPageId", "pages"], [], path);
  requireValue(root.schema === "deep-engine.dashboard-runtime" && root.schemaVersion === 1, path, "Unsupported dashboard schema or version.");
  requireValue(root.id === id && revision(root.revision, `${path}.revision`) === index.get(id)!.revision, path, "Dashboard identity differs from index.");
  revision(root.documentRevision, `${path}.documentRevision`);
  const documentId = string(root.documentId, `${path}.documentId`);
  requireValue(documentId.length > 0 && new TextEncoder().encode(documentId).length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(documentId), path, "Invalid document identity.");
  const entry = identity(root.entryPageId, "page", `${path}.entryPageId`);
  const pages = array(root.pages, `${path}.pages`, LIMITS.pages);
  requireValue(pages.length > 0, path, "Dashboard requires a page.");
  const pageIds = new Set<string>(), nodeIds = new Set<string>(), chartIds = new Set<string>();
  let atlasBytes = 0, chartCount = 0;
  for (const [pageIndex, pageValue] of pages.entries()) {
    const p = `${path}.pages[${pageIndex}]`, page = record(pageValue, p);
    fields(page, ["id", "width", "height", "nodes"], [], p);
    const pageId = identity(page.id, "page", `${p}.id`);
    requireValue(!pageIds.has(pageId), p, "Duplicate page identity."); pageIds.add(pageId);
    positive(page.width, `${p}.width`); positive(page.height, `${p}.height`);
    let previousZ = -Infinity, previousId = "";
    for (const [nodeIndex, nodeValue] of array(page.nodes, `${p}.nodes`, LIMITS.nodes).entries()) {
      const n = `${p}.nodes[${nodeIndex}]`, node = record(nodeValue, n);
      fields(node, ["id", "revision", "frame", "clip", "zOrder", "visible", "hitId", "deep2d", "chart", "chartSim"], [], n);
      const nodeId = identity(node.id, "node", `${n}.id`);
      requireValue(!nodeIds.has(nodeId), n, "Duplicate node identity."); nodeIds.add(nodeId);
      requireValue(nodeIds.size <= LIMITS.nodes, path, "Dashboard node budget exceeded.");
      revision(node.revision, `${n}.revision`); rect(node.frame, `${n}.frame`);
      if (node.clip !== null) rect(node.clip, `${n}.clip`);
      const z = integer(node.zOrder, -2_147_483_648, 2_147_483_647, `${n}.zOrder`);
      requireValue(z > previousZ || z === previousZ && nodeId > previousId, n, "Nodes must be sorted by zOrder then id.");
      previousZ = z; previousId = nodeId;
      requireValue(typeof node.visible === "boolean", n, "Expected visible boolean.");
      requireValue(node.hitId === null || node.hitId === nodeId, n, "Hit identity must belong to this node.");
      requireValue(node.deep2d !== null || node.chart !== null, n, "Node requires static or chart content.");
      requireValue(node.chartSim === null || node.chart !== null, n, "Simulation requires this node's chart.");
      if (node.deep2d !== null) {
        const resource = use(node.deep2d, "deep2d-runtime"), content = payloads[resource];
        validateRuntimeDeep2d(content, resource, index.get(resource)!.revision, `$.payloads.${resource}`);
        const atlases = (content as { atlases: { dataBase64: string }[] }).atlases;
        for (const atlas of atlases) {
          const text = atlas.dataBase64;
          atlasBytes += text.length / 4 * 3 - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0);
          requireValue(atlasBytes <= LIMITS.atlasBytes, path, "Dashboard aggregate atlas budget exceeded.");
        }
      }
      if (node.chart !== null) {
        requireValue(++chartCount <= LIMITS.charts, path, "Dashboard chart budget exceeded.");
        const resource = use(node.chart, "chart-runtime");
        const chart = validateRuntimeChartPackage(payloads[resource], resource, index.get(resource)!.revision, `$.payloads.${resource}`);
        const chartId = (chart as { id: string }).id;
        requireValue(!chartIds.has(chartId), n, "Duplicate internal ChartIR identity."); chartIds.add(chartId);
        if (node.chartSim !== null) {
          const sim = use(node.chartSim, "chart-sim-runtime");
          validateRuntimeChartSimPackage(payloads[sim], sim, index.get(sim)!.revision, chart, `$.payloads.${sim}`);
          const fixture = record(payloads[sim], `$.payloads.${sim}`).fixture;
          // v5 validates all replay rows and dataset bindings, not only the sampled first row.
          ChartSimulationSource.fromJson(JSON.stringify(fixture), chart as ChartIR);
        }
      }
    }
  }
  requireValue(pageIds.has(entry), path, "Entry page is missing.");
}
