import { buildDeepRuntimePackage } from "./builder.js";
import { runtimeContentSha256 } from "./hash.js";
import type { Deep2dRuntimePackage, DeepRuntimePackage } from "./types.js";

/** Packages compiled 2D pixels/paths; source widgets and scripts require prior lowering. */
export function buildDashboardRuntimePackage(input: {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly deep2d: Deep2dRuntimePackage;
}): DeepRuntimePackage {
  if (!input.deep2d) throw new Error("Compiled Deep2D runtime content is required.");
  const packetId = `dashboard.scene.${runtimeContentSha256([input.packageId, input.deep2d.id])}`;
  return buildDeepRuntimePackage({
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    deep2d: input.deep2d,
    renderPacket: { id: packetId, revision: input.deep2d.revision,
      value: { geometries: [], materials: [], instances: [], textures: [] } },
  });
}
