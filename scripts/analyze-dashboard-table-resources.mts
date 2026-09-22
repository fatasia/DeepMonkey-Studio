import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dashboardTablePrimitives } from "../apps/web/src/delivery/dashboardTablePrimitives.ts";
import { dashboardTableLayerIdentity } from "../apps/web/src/delivery/dashboardTableLayerIdentity.ts";
const file = process.argv[2]!;
const value = JSON.parse(await readFile(file, "utf8"));
const contents = new Map<string, any>(value.deep2d.map((content: any) => [content.id, content]));
const tables = value.dashboard.tables.map((table: any) => {
  const ids = new Set<string>(), primitives = new Set<string>(); let maximumSlots = 0, views = 0;
  for (const family of table.families) for (const order of family.orders) for (const page of order.pages) {
    views++;
    const layers = page.layers.map((layer: any) => { ids.add(layer.deep2d); return { content: contents.get(layer.deep2d), clip: layer.clip }; });
    const split = dashboardTablePrimitives(layers); maximumSlots = Math.max(maximumSlots, split.length);
    for (const layer of split) primitives.add(dashboardTableLayerIdentity(layer.content, table.id).content.id);
  }
  const base = value.dashboard.pages.flatMap((page: any) => page.nodes).filter((node: any) => table.nodeIds.includes(node.id));
  return { id: table.id, views, currentSlots: table.nodeIds.length, currentResources: ids.size, primitiveResources: primitives.size, maximumSlots,
    baseResourcesInViews: base.filter((node: any) => ids.has(node.deep2d)).length,
    totalNodes: value.dashboard.pages.flatMap((page: any) => page.nodes).length };
});
const atlasHashes = new Map<string, number>(); let atlasCount = 0;
for (const content of contents.values()) for (const atlas of content.atlases) { atlasCount++;
  const hash = createHash("sha256").update(atlas.dataBase64).digest("hex"); atlasHashes.set(hash, (atlasHashes.get(hash) ?? 0) + 1); }
const result = { resources: { deep2d: contents.size, charts: value.charts.length, fixed: 3, total: contents.size + value.charts.length + 3 }, tables,
  atlasCount, uniqueAtlasPixels: atlasHashes.size, duplicateAtlasUses: atlasCount - atlasHashes.size };
await writeFile(`${file}.analysis.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
