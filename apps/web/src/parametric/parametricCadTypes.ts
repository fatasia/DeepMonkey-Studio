import type { ParametricCadBuildSummary } from "@bim-studio/contracts";

export interface ParametricCadBuildResult {
  vertices: Float32Array;
  triangles: Uint32Array;
  normals: Float32Array;
  step: ArrayBuffer;
  summary: ParametricCadBuildSummary;
}

export interface ParametricCadWorkerResponse {
  id: string;
  ok: boolean;
  result?: ParametricCadBuildResult;
  error?: string;
}
