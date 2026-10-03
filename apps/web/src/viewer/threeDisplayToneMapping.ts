import * as THREE from "three";
import { threeToneMappingShader } from "@bim-studio/deep-engine/three-bridge";
import { canonicalToneSource } from "./threeCanonicalShaderSources";

type ToneChunks = { tonemapping_pars_fragment: string };
const installed = new WeakMap<ToneChunks, { original: string; adapted: string }>();
let canonical: string | undefined;

/** Install once in this Three realm, before renderer/material program creation. */
export function installThreeDisplayToneMapping(chunks: ToneChunks = THREE.ShaderChunk): void {
  const previous = installed.get(chunks);
  if (previous) {
    if (chunks.tonemapping_pars_fragment !== previous.adapted) throw Error("Installed Three display tone-mapping source drifted");
    return;
  }
  const original = chunks.tonemapping_pars_fragment;
  // HMR can replace this registry while the global Three chunks survive.
  canonical ??= threeToneMappingShader(canonicalToneSource);
  const adapted = original === canonical ? canonical : threeToneMappingShader(original);
  if (adapted !== canonical) throw Error("Three display tone-mapping source drifted");
  chunks.tonemapping_pars_fragment = adapted;
  installed.set(chunks, { original, adapted });
}
