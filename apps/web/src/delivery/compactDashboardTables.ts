import { runtimeContentSha256, type DashboardRuntimeV1, type DashboardRuntimeNodeV1, type Deep2dRuntimePackage,
  type DashboardFrozenTableV1, type DashboardTableOrderV1 } from "@bim-studio/deep-engine/runtime-package";
import { dashboardTablePrimitives } from "./dashboardTablePrimitives";
import { dashboardTableLayerIdentity } from "./dashboardTableLayerIdentity";
import type { DashboardRasterEvidence } from "./dashboardRasterTypes";

/** Reuses identical primitive content; slot ordering and per-layer clips remain the draw contract.
 *  Placement moves into the per-view layer origin so repeated text and shapes share one resource. */
export function compactDashboardTables(dashboard: DashboardRuntimeV1, deep2d: Deep2dRuntimePackage[],
  evidence: DashboardRasterEvidence[], bindings: Array<{ nodeId: string; runtimeNodeIds: string[] }>) {
  const content = new Map(deep2d.map(item => [item.id, item]));
  const removed = new Set<string>(), added = new Map<string, Deep2dRuntimePackage>();
  const atlasIds = new Map<string, Set<string>>();
  const tables: DashboardFrozenTableV1[] = [];
  for (const table of dashboard.tables ?? []) {
    const page = dashboard.pages.find(page => page.id === table.pageId)!;
    const nodes = page.nodes as DashboardRuntimeNodeV1[];
    const baseline = nodes.filter(node => table.nodeIds.includes(node.id));
    const slotIds = [...table.nodeIds];
    baseline.forEach(node => { if (node.deep2d) removed.add(node.deep2d); });
    const families = table.families.map(family => ({ orders: family.orders.map(order => ({ ...order,
      pages: order.pages.map(view => {
        const source = view.layers.map(layer => {
          removed.add(layer.deep2d);
          return { content: content.get(layer.deep2d)!, clip: layer.clip };
        });
        const split = dashboardTablePrimitives(source);
        while (slotIds.length < split.length) slotIds.push(`node.${runtimeContentSha256([table.id, "primitive-slot", slotIds.length])}`);
        const layers: DashboardTableOrderV1["pages"][number]["layers"] = split.map((layer, index) => {
          const placed = placeCanonical(layer.content, layer.clip);
          const normalized = dashboardTableLayerIdentity(placed.content, table.id);
          added.set(normalized.content.id, normalized.content);
          for (const [before, after] of normalized.atlasIds) {
            const ids = atlasIds.get(before) ?? new Set(); ids.add(after); atlasIds.set(before, ids);
          }
          return { nodeId: slotIds[index]!, deep2d: normalized.content.id, clip: placed.clip, origin: placed.origin };
        });
        return { ...view, layers };
      }),
    })) }));
    const first = families[0]!.orders[0]!.pages[0]!;
    const used = new Set<string>();
    const replacement = slotIds.map((id, index) => {
      const layer = first.layers[index];
      let resource = layer ? added.get(layer.deep2d)! : empty(baseline[0]!, id, content);
      if (used.has(resource.id)) resource = { ...resource, id: `${resource.id}.base.${index}` };
      used.add(resource.id); added.set(resource.id, resource);
      return { ...baseline[0]!, id, deep2d: resource.id, clip: layer?.clip ?? null, visible: true };
    });
    const start = nodes.findIndex(node => node.id === table.nodeIds[0]);
    nodes.splice(start, baseline.length, ...replacement);
    const binding = bindings.find(binding => binding.nodeId === table.id)!;
    binding.runtimeNodeIds.splice(0, binding.runtimeNodeIds.length, ...slotIds);
    tables.push({ ...table, nodeIds: slotIds, families });
  }
  if (dashboard.tables) (dashboard as { tables: readonly DashboardFrozenTableV1[] }).tables = tables;
  for (const page of dashboard.pages) (page.nodes as DashboardRuntimeNodeV1[]).splice(0, page.nodes.length,
    ...page.nodes.map((node, zOrder) => ({ ...node, zOrder })));
  deep2d.splice(0, deep2d.length, ...deep2d.filter(item => !removed.has(item.id)), ...added.values());
  evidence.splice(0, evidence.length, ...evidence.flatMap(item => {
    const ids = atlasIds.get(item.atlasId);
    return ids ? [...ids].map(atlasId => ({ ...item, atlasId })) : [item];
  }));
  if (dashboard.pages.reduce((sum, page) => sum + page.nodes.length, 0) > 128) throw new Error("Table primitive slots exceed 128 nodes");
}
function empty(node: DashboardRuntimeNodeV1, id: string, contents: Map<string, Deep2dRuntimePackage>): Deep2dRuntimePackage {
  const source = contents.get(node.deep2d!)!;
  return { ...source, id: `${id}.empty`, displayList: { ...source.displayList, id: `${id}.paths`, resources: [], commands: [] }, atlases: [], quads: [] };
}
/** Translates geometry and clip into origin-relative placement; rendering re-applies the origin per view. */
export function placeCanonical(content: Deep2dRuntimePackage, clip: readonly [number, number, number, number] | null):
  { content: Deep2dRuntimePackage; clip: readonly [number, number, number, number] | null;
    origin: readonly [number, number] } {
  const xs: number[] = [], ys: number[] = [];
  // Quads are rendered as transform ∘ destination, so only translation/identity transforms keep the shift exact.
  const shiftable = content.quads.every(quad => !quad.transform
    || (quad.transform[0] === 1 && quad.transform[1] === 0 && quad.transform[2] === 0 && quad.transform[3] === 1));
  if (!shiftable) return { content, clip, origin: [0, 0] as const };
  for (const quad of content.quads) {
    // Quads are placed by destination; their transform is a local matrix, not the placement.
    const place = quad.destination ?? quad.transform;
    if (place) { xs.push(place[0]); ys.push(place[1]); }
  }
  for (const command of content.displayList.commands) if (command.transform) { xs.push(command.transform[4]); ys.push(command.transform[5]); }
  if (clip) { xs.push(clip[0]); ys.push(clip[1]); }
  const origin: readonly [number, number] = xs.length ? [Math.min(...xs), Math.min(...ys)] : [0, 0];
  return { content: {
      ...content, quads: content.quads.map(quad => ({ ...quad,
        ...(quad.destination ? { destination: [quad.destination[0] - origin[0], quad.destination[1] - origin[1],
          quad.destination[2], quad.destination[3]] as typeof quad.destination } : {}) })),
      displayList: { ...content.displayList, commands: content.displayList.commands.map(command =>
        ({ ...command, ...(command.transform ? { transform: shiftTransform(command.transform, origin) } : {}) })) } },
    clip: clip ? [clip[0] - origin[0], clip[1] - origin[1], clip[2], clip[3]] as readonly [number, number, number, number] : null,
    origin };
}
function shiftTransform<T extends readonly number[]>(transform: T, origin: readonly [number, number]) {
  return [transform[0]!, transform[1]!, transform[2]!, transform[3]!, transform[4]! - origin[0], transform[5]! - origin[1]] as unknown as T;
}
