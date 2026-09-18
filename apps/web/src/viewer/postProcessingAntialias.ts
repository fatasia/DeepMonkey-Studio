import type * as THREE from "three";

const PREFERRED_SAMPLES = 4;

/** HDR color and depth must support the same sample count. Canvas AA does not apply to composer targets. */
export function configurePostProcessingAntialias(renderer: THREE.WebGLRenderer,
  targets: readonly THREE.WebGLRenderTarget[]): number {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const color = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES) as Int32Array | null;
  const depth = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, gl.SAMPLES) as Int32Array | null;
  const samples = selectPostProcessingSamples(color ?? [], depth ?? [], renderer.capabilities.maxSamples);
  for (const target of targets) target.samples = samples;
  return samples;
}

export function selectPostProcessingSamples(color: ArrayLike<number>, depth: ArrayLike<number>, maximum: number): number {
  const depthSamples = new Set(Array.from(depth));
  return Array.from(color).reduce((best, count) => Number.isInteger(count) && count > best
    && count <= PREFERRED_SAMPLES && count <= maximum && depthSamples.has(count) ? count : best, 0);
}
