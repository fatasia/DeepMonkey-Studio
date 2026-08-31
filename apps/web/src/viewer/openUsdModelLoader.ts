import * as THREE from "three";
import { loadViewerAssetBuffer } from "./viewerAssetTransport";

export interface OpenUsdModelLoadResult {
  object: THREE.Group;
  animations: THREE.AnimationClip[];
}

/**
 * 使用 Three.js 官方 USDLoader 读取 USD/USDA/USDC/USDZ。
 * 加载器按需拆包，避免常规 glTF/IFC 首屏承担 USDC 解析器体积。
 */
export async function loadOpenUsdModel(url: string): Promise<OpenUsdModelLoadResult> {
  const [{ USDLoader }, source] = await Promise.all([
    import("three/addons/loaders/USDLoader.js"),
    loadViewerAssetBuffer(url, "OpenUSD"),
  ]);
  const loader = new USDLoader();
  const object = await new Promise<THREE.Group>((resolve, reject) => {
    try {
      loader.parse(source, resourceBase(url), resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
  object.name ||= fileName(url) || "OpenUSD 场景";
  return { object, animations: object.animations };
}

function resourceBase(url: string): string {
  const cleanUrl = url.split(/[?#]/, 1)[0] ?? url;
  const index = cleanUrl.lastIndexOf("/");
  return index >= 0 ? cleanUrl.slice(0, index + 1) : "";
}

function fileName(url: string): string {
  const cleanUrl = url.split(/[?#]/, 1)[0] ?? url;
  return decodeURIComponent(cleanUrl.slice(cleanUrl.lastIndexOf("/") + 1));
}
