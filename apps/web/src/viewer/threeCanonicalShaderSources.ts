/// <reference path="../types/three-shader-chunks.d.ts" />
import toneSource from "three/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js";
import commonSource from "three/src/renderers/shaders/ShaderChunk/common.glsl.js";
import physicalSource from "three/src/renderers/shaders/ShaderChunk/lights_physical_pars_fragment.glsl.js";

// Match Three r185 utils/build/rollup.config.js glsl(), before adaptation.
// These exports stay independent of the mutable global THREE.ShaderChunk.
function publishedSource(source: string): string {
  return source.trim().replace(/\r/g, "")
    .replace(/[ \t]*\/\/.*\n/g, "")
    .replace(/[ \t]*\/\*[\s\S]*?\*\//g, "")
    .replace(/\n{2,}/g, "\n");
}

export const canonicalToneSource = publishedSource(toneSource);
export const canonicalCommonSource = publishedSource(commonSource);
export const canonicalPhysicalSource = publishedSource(physicalSource);
