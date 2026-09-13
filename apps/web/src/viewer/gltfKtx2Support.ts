import type { WebGLRenderer } from "three";
import type { WebGPURenderer } from "three/webgpu";
import type { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";

const decoders = new WeakMap<GLTFLoader, KTX2Loader>();
/** 每个渲染器按真实设备能力选择 ASTC/BC/ETC 或 RGBA，全部转码文件随部署交付。 */
export function configureGltfKtx2(loader: GLTFLoader, renderer: WebGLRenderer | WebGPURenderer): void {
  if (decoders.has(loader)) return;
  const decoder = new KTX2Loader(loader.manager).setTranscoderPath(`${import.meta.env.BASE_URL}basis/`).setWorkerLimit(2).detectSupport(renderer);
  loader.setKTX2Loader(decoder); decoders.set(loader, decoder);
}
export function disposeGltfKtx2(loader: GLTFLoader): void {
  decoders.get(loader)?.dispose(); decoders.delete(loader);
}
