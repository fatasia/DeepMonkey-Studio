import * as THREE from "three";
import type { PbrEnvironmentSource } from "@bim-studio/deep-engine/webgpu";
import { prepareStudioEnvironmentTextureAsync, isStudioEnvironmentTextureCurrent,
  captureStudioEnvironmentTexture, type StudioEnvironmentTextureIdentity,
  type PreparedStudioEnvironmentTexture } from "./studioDeepEnvironmentTexture";
import { studioDeepNeutralEnvironment } from "./studioDeepNeutralEnvironment";
import { readStudioReflectionProbes, type StudioReflectionProbeCarriers } from "./studioReflectionProbeCarriers";

export interface PreparedStudioDeepEnvironment {
  readonly source: PbrEnvironmentSource;
  readonly environment: THREE.Texture | null;
  readonly background: THREE.Scene["background"];
  readonly textures: readonly PreparedStudioEnvironmentTexture[];
  readonly reflectionProbes?: StudioReflectionProbeCarriers;
}

export interface StudioDeepEnvironmentSourceIdentity {
  readonly environment: THREE.Texture | null;
  readonly background: THREE.Scene["background"];
  readonly textures: readonly { readonly identity: StudioEnvironmentTextureIdentity }[];
  readonly reflectionProbes?: StudioReflectionProbeCarriers;
}

export function captureStudioDeepEnvironmentSource(scene: THREE.Scene): StudioDeepEnvironmentSourceIdentity {
  const reflectionProbes = readStudioReflectionProbes(scene);
  const textures = [scene.environment, scene.background, ...reflectionProbes.probes.map(probe => probe.texture)]
    .filter((value): value is THREE.Texture => value instanceof THREE.Texture);
  return { environment: scene.environment, background: scene.background,
    reflectionProbes,
    textures: [...new Set(textures)].map(texture => ({ identity: captureStudioEnvironmentTexture(texture) })) };
}

/** Resolve the already-loaded author textures once; never load their URLs again. */
export async function prepareStudioDeepEnvironmentSource(scene: THREE.Scene,
  signal: AbortSignal): Promise<PreparedStudioDeepEnvironment> {
  const environment = scene.environment, background = scene.background;
  const reflectionProbes = readStudioReflectionProbes(scene);
  if (reflectionProbes.error) throw new Error(reflectionProbes.error);
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
  const ibl = environment ? await convert(environment) : undefined;
  const sky = background instanceof THREE.Texture ? await convert(background) : undefined;
  const probeSources = [];
  for (const probe of reflectionProbes.probes) {
    const pixels = probe.texture ? await convert(probe.texture) : undefined;
    if (pixels && pixels.kind !== "radiance-hdr") throw new Error("反射探针需要已解码的环境像素。");
    const state = probe.state;
    probeSources.push({ box: { center: [state.center.x, state.center.y, state.center.z] as const,
      halfExtents: [state.halfExtents.x, state.halfExtents.y, state.halfExtents.z] as const,
      blendDistance: state.blendDistance, influenceRadius: state.influenceRadius },
      ...(pixels?.kind === "radiance-hdr" ? { image: pixels.image } : {}) });
  }
  if ((ibl && ibl.kind !== "radiance-hdr") || (sky && sky.kind !== "radiance-hdr")) {
    throw new Error("Deep 作者环境必须使用已解码的真实像素。");
  }
  const baseSource = ibl
      // 作者环境在场：沿用作者像素，天空纹理仅作为背景像素叠加。
      ? { ...ibl, ...(sky ? { backgroundImage: sky.image } : {}) }
      // 作者未配置环境：中性摄影棚兜底（引擎原生 studio IBL；天空纹理存在时
      // 引擎源不带背景字段，改用确定性中性 equirect + 作者天空背景像素）。
      // 黑 IBL 兜底会把材质打回死黑并让 DDGI 捕获零辐照，禁止回归。
      : studioDeepNeutralEnvironment(sky?.image);
  const result: PreparedStudioDeepEnvironment = { environment, background, textures, reflectionProbes,
    source: probeSources.length ? { ...baseSource, reflectionProbes: probeSources } : baseSource };
  if (signal.aborted) throw new DOMException("环境准备已取消。", "AbortError");
  if (!isStudioDeepEnvironmentSourceCurrent(scene, result)) throw new Error("作者环境在准备期间已改变。");
  return result;
}

/** Color/intensity changes do not require texture upload; source changes do. */
export function isStudioDeepEnvironmentSourceCurrent(scene: THREE.Scene,
  prepared: StudioDeepEnvironmentSourceIdentity): boolean {
  return scene.environment === prepared.environment
    && (prepared.reflectionProbes === undefined || readStudioReflectionProbes(scene) === prepared.reflectionProbes)
    && (scene.background === prepared.background
      || scene.background instanceof THREE.Color && prepared.background instanceof THREE.Color)
    && prepared.textures.every(item => isStudioEnvironmentTextureCurrent(item.identity));
}
