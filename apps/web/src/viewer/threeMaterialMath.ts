import * as THREE from "three";
import { threeFresnelShader, threeGgxVisibilityShader } from "@bim-studio/deep-engine/three-bridge";

type MaterialChunks = { common: string; lights_physical_pars_fragment: string };
const installed = new WeakMap<MaterialChunks, { common: string; physical: string }>();

/** Per-realm installation before material compilation; no material hooks. */
export function installThreeMaterialMath(chunks: MaterialChunks = THREE.ShaderChunk): void {
  const previous = installed.get(chunks);
  if (previous !== undefined) {
    if (chunks.common !== previous.common || chunks.lights_physical_pars_fragment !== previous.physical) throw Error("Installed Three material math source drifted");
    return;
  }
  if ([...chunks.common.matchAll(/^#define EPSILON 1e-6$/gm)].length !== 1) throw Error("Three material GGX epsilon source changed");
  const adapted = threeFresnelShader(chunks.common);
  const physical = threeGgxVisibilityShader(chunks.lights_physical_pars_fragment);
  chunks.common = adapted; chunks.lights_physical_pars_fragment = physical;
  installed.set(chunks, { common: adapted, physical });
}
