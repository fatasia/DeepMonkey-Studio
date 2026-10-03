import type { RendererBackend } from "./viewerTypes";

export function rendererBackendLabel(backend: RendererBackend, compact = false): string {
  if (backend === "wasm") return compact ? "Deep WASM" : "Deep WASM Engine";
  if (backend === "webgpu") return "Deep WebGPU";
  return compact ? "WebGL" : "WebGL 2";
}

