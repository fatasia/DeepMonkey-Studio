import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { compactDashboardTables } from "../apps/web/src/delivery/compactDashboardTables.ts";
import { dashboardTablePrimitives } from "../apps/web/src/delivery/dashboardTablePrimitives.ts";
import { buildDashboardCompositionRuntimePackage } from "../packages/deep-engine/src/runtimePackage/dashboardComposition.ts";
const file = process.argv[2]!;
const value = JSON.parse(await readFile(file, "utf8"));
const pixels = (atlas: any) => createHash("sha256").update(atlas.dataBase64, "base64").digest("hex");
const shift = (value: any, dx: number, dy: number) => {
  if (!value) return value;
  const next = [...value];
  next[0] += dx; next[1] += dy;
  return next;
};
/** Reduced per-part geometry; identities stripped, placement and pixels kept.
 *  Quads shift by destination only, commands by transform translation — mirroring placeCanonical. */
function reducePart(content: any, clip: any, dx = 0, dy = 0) {
  const pathIds = new Map(content.displayList.resources.map((resource: any, index: number) => [resource.id, index]));
  return {
    quads: content.quads.map((quad: any) => ({ ...(quad.destination !== undefined ? { destination: shift(quad.destination, dx, dy) } : {}),
      ...(quad.transform !== undefined ? { transform: quad.transform } : {}),
      ...(quad.source !== undefined ? { source: quad.source } : {}), ...(quad.color !== undefined ? { color: quad.color } : {}) })),
    commands: content.displayList.commands.map((command: any) => ({ pathIndex: pathIds.get(command.pathId),
      transform: command.transform ? shift(command.transform, dx, dy) : command.transform })),
    pathResources: content.displayList.resources.map(({ id, ...resource }: any) => resource),
    pixels: content.atlases.map(pixels), clip: clip ? shift(clip, dx, dy) : clip,
  };
}
function streams(raw: boolean) {
  const content = new Map<string, any>(value.deep2d.map((item: any) => [item.id, item]));
  return value.dashboard.tables.map((table: any) =>
    table.families.flatMap((family: any) => family.orders.flatMap((order: any) => order.pages.map((page: any) => {
      if (raw) return dashboardTablePrimitives(page.layers.map((layer: any) =>
        ({ content: content.get(layer.deep2d), clip: layer.clip }))).map(part => reducePart(part.content, part.clip));
      return page.layers.map((layer: any) => {
        const packed = content.get(layer.deep2d);
        return reducePart(packed, layer.clip, layer.origin?.[0] ?? 0, layer.origin?.[1] ?? 0);
      });
    }))));
}
const before = streams(true);
compactDashboardTables(value.dashboard, value.deep2d, value.producerEvidence, value.nodeBindings);
assert.deepEqual(streams(false), before);
const result = buildDashboardCompositionRuntimePackage({ packageId: "table.compaction-proof", packageVersion: "1.0.0",
  dashboard: value.dashboard, deep2d: value.deep2d, charts: value.charts, chartSims: [] });
await writeFile(`${file}.compacted.json`, JSON.stringify(result));
const evidence = { views: before.flat().length, exactDrawStreams: true, resources: result.resources.length,
  nodes: value.dashboard.pages.flatMap((page: any) => page.nodes).length, packageHash: result.packageHash.value };
await writeFile(`${file}.compaction-proof.json`, JSON.stringify(evidence, null, 2)); console.log(evidence);
