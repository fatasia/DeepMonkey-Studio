import { expect, it } from "vitest";
import { dashboardTableLayerIdentity } from "./dashboardTableLayerIdentity";
import { fixture } from "./dashboardDataRaster.testUtils";
import { rasterNode } from "./dashboardRasterNode";

it("deduplicates only names while preserving all pixels, geometry, draw order and references", async () => {
  const value = fixture();
  const node = value.input.document.application.pages[0]!.nodes[0]!;
  if (node.kind !== "data-widget") throw new Error("fixture");
  const result = await rasterNode(node, "test", 1, value.input, value.host);
  for (const layer of result.layers) {
    const a = dashboardTableLayerIdentity(layer.content, "table");
    const b = structuredClone(layer.content);
    (b as { id: string }).id = "other"; (b.displayList as { id: string }).id = "other.paths";
    const atlasIds = new Map(b.atlases.map((atlas, index) => [atlas.id, `changed.${index}`]));
    b.atlases.forEach(atlas => { (atlas as { id: string }).id = atlasIds.get(atlas.id)!; });
    b.quads.forEach(quad => { (quad as { id: string; atlasId: string }).id += ".other"; (quad as { atlasId: string }).atlasId = atlasIds.get(quad.atlasId)!; });
    expect(dashboardTableLayerIdentity(b, "table").content).toEqual(a.content);
    expect(a.content.atlases.map(atlas => atlas.dataBase64)).toEqual(layer.content.atlases.map(atlas => atlas.dataBase64));
    expect(dashboardTableLayerIdentity(b, "other-table").content.id).not.toEqual(a.content.id);
  }
});
