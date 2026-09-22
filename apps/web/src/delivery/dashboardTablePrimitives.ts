import type { Deep2dRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import type { RasterNodeResult } from "./dashboardRasterNode";

/** Split only the existing ordered draw stream. Runtime slot order replaces local zOrder. */
export function dashboardTablePrimitives(layers: RasterNodeResult["layers"]): RasterNodeResult["layers"] {
  return layers.flatMap(layer => {
    const content = layer.content;
    const draws = [
      ...content.displayList.commands.map(command => ({ kind: "path" as const, command, z: command.zOrder })),
      ...content.quads.map(quad => ({ kind: "quad" as const, quad, z: quad.zOrder })),
    ].sort((a, b) => a.z - b.z);
    return draws.map((draw, index) => {
      const id = `${content.id}.part.${index}`;
      const part: Deep2dRuntimePackage = draw.kind === "quad" ? {
        ...content, id, displayList: { ...content.displayList, id: `${id}.paths`, resources: [], commands: [] },
        atlases: content.atlases.filter(atlas => atlas.id === draw.quad.atlasId), quads: [{ ...draw.quad, zOrder: 0 }],
      } : {
        ...content, id, displayList: { ...content.displayList, id: `${id}.paths`,
          resources: content.displayList.resources.filter(resource => draw.command.kind === "path" && resource.id === draw.command.pathId),
          commands: [{ ...draw.command, zOrder: 0 }] }, atlases: [], quads: [],
      };
      return { content: part, clip: layer.clip };
    });
  });
}
