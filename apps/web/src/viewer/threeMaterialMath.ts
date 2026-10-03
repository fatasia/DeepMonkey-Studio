import * as THREE from "three";
import { threeFresnelShader, threeGgxVisibilityShader } from "@bim-studio/deep-engine/three-bridge";
import { canonicalCommonSource, canonicalPhysicalSource } from "./threeCanonicalShaderSources";

type MaterialChunks = { common: string; lights_physical_pars_fragment: string };
const installed = new WeakMap<MaterialChunks, { common: string; physical: string }>();
let canonical: { common: string; physical: string } | undefined;

/** Per-realm installation before material compilation; no material hooks. */
export function installThreeMaterialMath(chunks: MaterialChunks = THREE.ShaderChunk): void {
  const previous = installed.get(chunks);
  if (previous !== undefined) {
    if (chunks.common !== previous.common || chunks.lights_physical_pars_fragment !== previous.physical) throw Error("Installed Three material math source drifted");
    return;
  }
  canonical ??= { common: threeFresnelShader(canonicalCommonSource), physical: threeGgxVisibilityShader(canonicalPhysicalSource) };
  // Reclaim only a complete current pair, never a marker or partial installation.
  if (chunks.common === canonical.common && chunks.lights_physical_pars_fragment === canonical.physical) {
    installed.set(chunks, canonical);
    return;
  }
  if ([...chunks.common.matchAll(/^#define EPSILON 1e-6$/gm)].length !== 1) throw Error("Three material GGX epsilon source changed");
  const adapted = threeFresnelShader(chunks.common);
  const physical = threeGgxVisibilityShader(chunks.lights_physical_pars_fragment);
  if (adapted !== canonical.common || physical !== canonical.physical) throw Error("Three material math source drifted");
  chunks.common = adapted; chunks.lights_physical_pars_fragment = physical;
  installed.set(chunks, { common: adapted, physical });
}
