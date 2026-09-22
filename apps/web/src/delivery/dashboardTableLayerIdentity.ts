import { runtimeContentSha256, type Deep2dRuntimePackage } from "@bim-studio/deep-engine/runtime-package";

/** Content addressing removes per-view names only; pixels, geometry, draw order and clips stay unchanged. */
export function dashboardTableLayerIdentity(source: Deep2dRuntimePackage, owner: string) {
  const paths = new Map(source.displayList.resources.map((resource, index) => [resource.id, `path.${index}`]));
  const atlases = new Map(source.atlases.map((atlas, index) => [atlas.id, `atlas.${index}`]));
  const normalized = { ...source, id: "table-layer", displayList: { ...source.displayList, id: "paths",
    resources: source.displayList.resources.map(resource => ({ ...resource, id: paths.get(resource.id)! })),
    commands: source.displayList.commands.map((command, index) => {
      if (command.kind !== "path") throw new Error("Table layers require baked path/atlas commands");
      return { ...command, id: `draw.${index}`, pathId: paths.get(command.pathId)! };
    }) }, atlases: source.atlases.map(atlas => ({ ...atlas, id: atlases.get(atlas.id)! })),
    quads: source.quads.map((quad, index) => ({ ...quad, id: `quad.${index}`, atlasId: atlases.get(quad.atlasId)! })) };
  const id = `table-layer.${runtimeContentSha256([owner, normalized])}`;
  const content = { ...normalized, id, displayList: { ...normalized.displayList, id: `${id}.paths` },
    atlases: normalized.atlases.map(atlas => ({ ...atlas, id: `${id}.${atlas.id}` })),
    quads: normalized.quads.map(quad => ({ ...quad, atlasId: `${id}.${quad.atlasId}` })) } as Deep2dRuntimePackage;
  return { content, atlasIds: new Map([...atlases].map(([before, after]) => [before, `${id}.${after}`])) };
}
