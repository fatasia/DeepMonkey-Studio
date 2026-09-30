import * as THREE from "three";
import { threeToneMappingShader } from "@bim-studio/deep-engine/three-bridge";

type ToneChunks = { tonemapping_pars_fragment: string };
const installed = new WeakMap<ToneChunks, { original: string; adapted: string }>();

/** Install once in this Three realm, before renderer/material program creation. */
export function installThreeDisplayToneMapping(chunks: ToneChunks = THREE.ShaderChunk): void {
  const previous = installed.get(chunks);
  if (previous) {
    if (chunks.tonemapping_pars_fragment !== previous.adapted) throw Error("Installed Three display tone-mapping source drifted");
    return;
  }
  const original = chunks.tonemapping_pars_fragment;
  const adapted = threeToneMappingShader(original);
  chunks.tonemapping_pars_fragment = adapted;
  installed.set(chunks, { original, adapted });
}
