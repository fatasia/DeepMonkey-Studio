import { PBR_DISPLAY_COLOR_WGSL } from "../webgpu/pbrDisplayColorWgsl.js";
import { sha256Utf8 } from "../shaderPackage/hash.js";
import { DISPLAY_COLOR_GLSL } from "./displayColorGlsl.js";

export type DisplayShaderBackend = "webgpu" | "native-wgpu" | "glsl-es-300";
/** Fixed libraries are cached once; backend selection does no compilation or hashing per frame. */
const libraries = Object.freeze({
  wgsl: Object.freeze({ language: "wgsl" as const, code: PBR_DISPLAY_COLOR_WGSL,
    sourceHash: sha256Utf8(PBR_DISPLAY_COLOR_WGSL), entryFunction: "deepDisplayColor" as const }),
  glsl: Object.freeze({ language: "glsl-es-300" as const, code: DISPLAY_COLOR_GLSL,
    sourceHash: sha256Utf8(DISPLAY_COLOR_GLSL), entryFunction: "deepDisplayColor" as const }),
});

/** Surface display slice only. Compute kernels continue through the existing DCIR emitters. */
export function displayColorLibrary(backend: DisplayShaderBackend) {
  switch (backend) {
    case "webgpu": case "native-wgpu": return libraries.wgsl;
    case "glsl-es-300": return libraries.glsl;
    default: throw new RangeError(`Unknown display shader backend: ${String(backend)}`);
  }
}
