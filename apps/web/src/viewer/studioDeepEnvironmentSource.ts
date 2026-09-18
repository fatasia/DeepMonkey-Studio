import * as THREE from "three";
import type { PbrEnvironmentSource } from "@bim-studio/deep-engine/webgpu";
import { prepareStudioEnvironmentTextureAsync, isStudioEnvironmentTextureCurrent,
  captureStudioEnvironmentTexture, type StudioEnvironmentTextureIdentity,
  type PreparedStudioEnvironmentTexture } from "./studioDeepEnvironmentTexture";

export interface PreparedStudioDeepEnvironment {
  readonly source: PbrEnvironmentSource;
  readonly environment: THREE.Texture | null;
  readonly background: THREE.Scene["background"];
  readonly textures: readonly PreparedStudioEnvironmentTexture[];
}

export interface StudioDeepEnvironmentSourceIdentity {
  readonly environment: THREE.Texture | null;
  readonly background: THREE.Scene["background"];
  readonly textures: readonly { readonly identity: StudioEnvironmentTextureIdentity }[];
}

export function captureStudioDeepEnvironmentSource(scene: THREE.Scene): StudioDeepEnvironmentSourceIdentity {
  const textures = [scene.environment, scene.background].filter((value): value is THREE.Texture => value instanceof THREE.Texture);
  return { environment: scene.environment, background: scene.background,
    textures: [...new Set(textures)].map(texture => ({ identity: captureStudioEnvironmentTexture(texture) })) };
}

/** Resolve the already-loaded author textures once; never load their URLs again. */
export async function prepareStudioDeepEnvironmentSource(scene: THREE.Scene,
  signal: AbortSignal): Promise<PreparedStudioDeepEnvironment> {
  const environment = scene.environment, background = scene.background;
  if (signal.aborted) throw new DOMException("环境准备已取消。", "AbortError");
  if (!(background instanceof THREE.Color) && !(background instanceof THREE.Texture)) {
    throw new Error("Deep 尚未接入透明场景背景。");
  }
  const textures: PreparedStudioEnvironmentTexture[] = [];
  const convert = async (texture: THREE.Texture) => {
    const existing = textures.find(item => item.identity.texture === texture);
    if (existing) return existing.source;
    const prepared = await prepareStudioEnvironmentTextureAsync(texture, { signal });
    textures.push(prepared);
    return prepared.source;
  };
  const ibl = environment ? await convert(environment) : blackEnvironment();
  const sky = background instanceof THREE.Texture ? await convert(background) : undefined;
  if (ibl.kind !== "radiance-hdr" || (sky && sky.kind !== "radiance-hdr")) {
    throw new Error("Deep 作者环境必须使用已解码的真实像素。");
  }
  const result: PreparedStudioDeepEnvironment = { environment, background, textures,
    source: { ...ibl, ...(sky ? { backgroundImage: sky.image } : {}) } };
  if (signal.aborted) throw new DOMException("环境准备已取消。", "AbortError");
  if (!isStudioDeepEnvironmentSourceCurrent(scene, result)) throw new Error("作者环境在准备期间已改变。");
  return result;
}

/** Color/intensity changes do not require texture upload; source changes do. */
export function isStudioDeepEnvironmentSourceCurrent(scene: THREE.Scene,
  prepared: StudioDeepEnvironmentSourceIdentity): boolean {
  return scene.environment === prepared.environment
    && (scene.background === prepared.background
      || scene.background instanceof THREE.Color && prepared.background instanceof THREE.Color)
    && prepared.textures.every(item => isStudioEnvironmentTextureCurrent(item.identity));
}

function blackEnvironment(): Extract<PbrEnvironmentSource, { kind: "radiance-hdr" }> {
  return { kind: "radiance-hdr", image: { width: 2, height: 1, data: new Float32Array(6) } };
}
