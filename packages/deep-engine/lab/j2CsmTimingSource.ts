import { sha256Utf8 } from "../src/shaderPackage/hash.js";

export interface CsmTimingPlan {
  schema: string; width: number; height: number; pairedRounds: number;
  warmupFrames: number; sampleFrames: number; drawsPerSample: number;
  cases: Array<{ id: string; depths: number[] }>;
}

export function csmTimingReference(source: string): string {
  const guarded = "return blendStart >= split || viewDepth <= blendStart;";
  if (source.split(guarded).length !== 2) throw Error("Expected exactly one production CSM inactive helper");
  return source.replace(guarded, "return blendStart >= split;");
}

export function csmTimingShader(source: string, entry: string, depths: readonly number[], uvs: readonly number[]) {
  if (depths.length !== 3 || uvs.length !== 7) throw Error("Frozen timing depth/UV shape changed");
  const boundary = source.indexOf("fn local_spot_pcss(");
  if (boundary < 0) throw Error("Native CSM source boundary changed");
  const library = `struct ProbeFrame { eye: vec4f };\nvar<private> frame: ProbeFrame;\n${source.slice(0, boundary)}`;
  const code = `${library}\n${entry.replace("TIMING_DEPTHS", depths.join(",")).replace("TIMING_UVS", uvs.join(","))}`;
  return { code, sourceHash: sha256Utf8(code), libraryHash: sha256Utf8(library) };
}

export function csmTimingOrder(round: number) {
  if (!Number.isInteger(round) || round < 1 || round > 5) throw Error("Frozen five-round timing plan changed");
  return round % 2 ? ["reference", "candidate"] as const : ["candidate", "reference"] as const;
}
