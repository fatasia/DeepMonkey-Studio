import * as THREE from "three";
import type { SceneMaterialScreenState } from "@bim-studio/contracts";

const SCREEN_TEXTURE_FLAG = "studioModelScreenTexture";
const SCREEN_VIDEO_KEY = "studioModelScreenVideo";

export function normalizeModelScreenState(state: SceneMaterialScreenState): SceneMaterialScreenState {
  return {
    enabled: Boolean(state.enabled),
    sourceType: state.sourceType === "image" ? "image" : "video",
    url: state.url.trim().slice(0, 4_096),
    ...(state.name?.trim() ? { name: state.name.trim().slice(0, 240) } : {}),
    autoplay: Boolean(state.autoplay),
    loopMode: state.loopMode === "once" ? "once" : "loop",
    // 浏览器拒绝带声音的自动播放，协议层直接固化这一约束，避免运行时反复失败。
    muted: Boolean(state.muted || state.autoplay),
    emissiveIntensity: THREE.MathUtils.clamp(state.emissiveIntensity, 0, 5),
  };
}

export function modelScreenSourceUrl(value: string, pageUrl: string): string | undefined {
  const input = value.trim();
  if (!input || input.length > 4_096 || /\p{Cc}/u.test(input)) return undefined;
  try {
    const resolved = new URL(input, pageUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return undefined;
    if (resolved.username || resolved.password) return undefined;
    if (new URL(pageUrl).protocol === "https:" && resolved.protocol === "http:") return undefined;
    return resolved.href;
  } catch {
    return undefined;
  }
}

export function createModelScreenVideoTexture(state: SceneMaterialScreenState, sourceUrl: string): THREE.VideoTexture {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.playsInline = true;
  video.preload = "auto";
  video.src = sourceUrl;
  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.userData[SCREEN_TEXTURE_FLAG] = true;
  texture.userData[SCREEN_VIDEO_KEY] = video;
  updateModelScreenVideo(texture, state);
  return texture;
}

export function updateModelScreenVideo(texture: THREE.Texture, state: SceneMaterialScreenState): void {
  const video = texture.userData[SCREEN_VIDEO_KEY] as HTMLVideoElement | undefined;
  if (!video) return;
  video.loop = state.loopMode === "loop";
  video.muted = state.muted || state.autoplay;
  if (!state.autoplay) {
    video.pause();
    return;
  }
  if (video.ended) video.currentTime = 0;
  void video.play().catch(() => undefined);
}

export function markModelScreenImageTexture(texture: THREE.Texture): void {
  texture.userData[SCREEN_TEXTURE_FLAG] = true;
}

export function isModelScreenTexture(texture: THREE.Texture | null | undefined): boolean {
  return Boolean(texture?.userData[SCREEN_TEXTURE_FLAG]);
}

export function disposeModelScreenTexture(texture: THREE.Texture | null | undefined): void {
  if (!texture || !isModelScreenTexture(texture)) return;
  const video = texture.userData[SCREEN_VIDEO_KEY] as HTMLVideoElement | undefined;
  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
  texture.dispose();
}
