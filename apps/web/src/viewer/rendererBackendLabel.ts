import type { RendererBackend } from "./viewerTypes";

export function rendererBackendLabel(backend: RendererBackend, compact = false): string {
  if (backend === "wasm") return compact ? "Deep WASM" : "Deep WASM Engine";
  if (backend === "webgpu") return compact ? "Deep WebGPU" : "Deep WebGPU Beta";
  return compact ? "WebGL" : "WebGL 2";
}

