import * as THREE from "three";
import { threeFresnelShader } from "@bim-studio/deep-engine/three-bridge";

type CommonChunks = { common: string };
const installed = new WeakMap<CommonChunks, string>();

/** Per-realm installation before material compilation; no material hooks. */
export function installThreeMaterialMath(chunks: CommonChunks = THREE.ShaderChunk): void {
  const previous = installed.get(chunks);
  if (previous !== undefined) {
    if (chunks.common !== previous) throw Error("Installed Three material math source drifted");
    return;
  }
  const adapted = threeFresnelShader(chunks.common);
  chunks.common = adapted; installed.set(chunks, adapted);
}
