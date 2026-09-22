import type { DashboardDataWidgetNode } from "@bim-studio/contracts";
import { runtimeContentSha256, type DashboardFrozenTableV1, type DashboardRuntimePageV1,
  type DashboardRuntimeNodeV1, type Deep2dRuntimePackage, type DashboardTableOrderV1 } from "@bim-studio/deep-engine/runtime-package";
import { rasterNode } from "./dashboardRasterNode";
import { prepareDashboardDataRaster } from "./dashboardDataRaster";
import { dashboardTableLayerIdentity } from "./dashboardTableLayerIdentity";
import { base64, RASTER_BYTES_LIMIT } from "./dashboardRasterValidation";
import type { DashboardFrozenData } from "./dashboardDataRasterTypes";
import type { DashboardRasterCompileInput, DashboardRasterHost, DashboardRasterEvidence } from "./dashboardRasterTypes";

export async function compileDashboardTables(input: DashboardRasterCompileInput, host: DashboardRasterHost,
  pages: DashboardRuntimePageV1[], deep2d: Deep2dRuntimePackage[],
  bindings: Array<{ nodeId: string; runtimeNodeIds: string[]; runtimePageId: string }>, evidence: DashboardRasterEvidence[]): Promise<DashboardFrozenTableV1[]> {
  const tables: DashboardFrozenTableV1[] = [];
  const pooled = new Map<string, Deep2dRuntimePackage>();
  let bytes = deep2d.reduce((sum, content) => sum + atlasBytes(content), 0), views = 0;
  for (const plan of input.tableViews ?? []) {
    const node = input.document.application.pages.flatMap(page => page.nodes).find(node => node.id === plan.nodeId) as DashboardDataWidgetNode;
    const binding = bindings.find(binding => binding.nodeId === plan.nodeId);
    const page = pages.find(page => page.id === binding?.runtimePageId);
    if (!node || node.kind !== "data-widget" || node.widget.type !== "table" || !binding || !page) throw new Error("Table runtime binding missing");
    const requests = new Map<string, NonNullable<ReturnType<typeof prepareDashboardDataRaster>["requests"][number]>>();
    for (const family of plan.families) for (const order of family) for (const data of order.pages) {
      for (const request of prepareDashboardDataRaster(node, { ...input, data: { ...input.data, [node.id]: data } }).requests)
        if (request) requests.set(request.requestHash, request);
    }
    if (requests.size > 512) throw new Error("Table unique text batch exceeds 512 requests");
    await host.prewarmText?.([...requests.values()]);
    const nodes = page.nodes as DashboardRuntimeNodeV1[], slots = [...binding.runtimeNodeIds];
    const baseline = slots.map(id => nodes.find(node => node.id === id)!);
    const baselineHash = runtimeContentSha256(input.data?.[node.id]);
    const compiled = new Map<string, DashboardTableOrderV1["pages"][number]["layers"]>();
    compiled.set(baselineHash, baseline.map(node => ({ nodeId: node.id, deep2d: node.deep2d!, clip: node.clip })));
    const families: DashboardFrozenTableV1["families"][number][] = [];
    for (const [familyIndex, family] of plan.families.entries()) {
      const orders: DashboardTableOrderV1[] = [];
      for (const [orderIndex, order] of family.entries()) {
        const viewPages: DashboardTableOrderV1["pages"][number][] = [];
        for (const [pageIndex, data] of order.pages.entries()) {
          if (++views > 512) throw new Error("Frozen table view budget exceeded (512)");
          const identity = runtimeContentSha256(data);
          let layers = compiled.get(identity);
          if (!layers) {
            const id = `node.${runtimeContentSha256([node.id, "table-view", identity])}`;
            const result = await rasterNode(node, `${id}.content`, input.document.application.metadata.revision,
              { ...input, data: { ...input.data, [node.id]: data } }, host);
            if (!result.report.contentCompiled) throw new Error(`Table view unavailable: ${result.report.reasons.join("; ")}`);
            const identities = result.layers.map(layer => dashboardTableLayerIdentity(layer.content, node.id));
            const atlasIds = new Map(identities.flatMap(identity => [...identity.atlasIds]));
            evidence.push(...result.evidence.map(item => ({ ...item, atlasId: atlasIds.get(item.atlasId) ?? item.atlasId,
              tableView: { nodeId: node.id, family: familyIndex, order: orderIndex, page: pageIndex } })));
            while (slots.length < result.layers.length) {
              if (pages.reduce((sum, page) => sum + page.nodes.length, 0) >= 128) throw new Error("Table content slots exceed Dashboard node budget");
              const slotId = `node.${runtimeContentSha256([node.id, "table-slot", slots.length])}`;
              const template = baseline[0]!;
              const empty = emptyContent(slotId, node, input.document.application.metadata.revision);
              deep2d.push(empty);
              const insert = Math.max(...slots.map(id => nodes.findIndex(node => node.id === id))) + 1;
              nodes.splice(insert, 0, { ...template, id: slotId, deep2d: empty.id, clip: null, visible: true });
              slots.push(slotId); binding.runtimeNodeIds.push(slotId);
            }
            layers = result.layers.map((layer, index) => {
              const content = identities[index]!.content;
              if (!pooled.has(content.id)) {
              bytes += atlasBytes(content);
              if (bytes > RASTER_BYTES_LIMIT) throw new Error("Frozen table atlases exceed Dashboard byte budget");
              deep2d.push(content); pooled.set(content.id, content);
              }
              return { nodeId: slots[index]!, deep2d: content.id, clip: layer.clip };
            });
            compiled.set(identity, layers);
          }
          viewPages.push({ layers, controls: controls(data, order.pages.length) });
        }
        orders.push({ column: order.sort?.column ?? null, direction: order.sort?.direction ?? null,
          exports: { csv: base64(order.exports.csv), xlsx: base64(order.exports.xlsx) }, pages: viewPages });
      }
      families.push({ orders });
    }
    tables.push({ id: node.id, title: node.widget.title, pageId: page.id, nodeIds: slots, families });
  }
  for (const page of pages) (page.nodes as DashboardRuntimeNodeV1[]).splice(0, page.nodes.length,
    ...page.nodes.map((node, zOrder) => ({ ...node, zOrder })));
  return tables;
}
function atlasBytes(content: Deep2dRuntimePackage) { return content.atlases.reduce((sum, atlas) => sum + atlas.width * atlas.height * 4, 0); }
function controls(data: DashboardFrozenData, pageCount: number): DashboardTableOrderV1["pages"][number]["controls"] {
  return data.layout.textBoxes.flatMap(box => {
    const role = box.role;
    const action = role.kind === "tool" ? role.tool === "excel" ? "xlsx" : "csv"
      : role.kind === "header" ? "sort" : role.kind === "previous" || role.kind === "next" ? role.kind : null;
    if (!action) return [];
    return [{ action, column: role.kind === "header" ? role.column : null, rect: box.buttonGroup?.rect ?? box.rect,
      enabled: action === "previous" ? (data.table?.page ?? 0) > 0 : action === "next" ? (data.table?.page ?? 0) + 1 < pageCount : true }];
  });
}
function emptyContent(id: string, node: DashboardDataWidgetNode, revision: number): Deep2dRuntimePackage {
  return { schema: "deep-engine.deep2d-runtime", schemaVersion: 2, id: `${id}.empty`, revision, composition: "z-ordered",
    displayList: { schemaVersion: 1, id: `${id}.paths`, revision, logicalWidth: node.frame.width, logicalHeight: node.frame.height,
      scaleFactor: 1, resources: [], commands: [] }, atlases: [], quads: [] };
}
