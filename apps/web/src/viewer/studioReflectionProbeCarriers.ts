import * as THREE from "three";
import type { SceneReflectionProbeState } from "@bim-studio/contracts";
import { packReflectionProbeRecord } from "@bim-studio/deep-engine/lighting";

const KEY = "deepStudioReflectionProbes";
export interface StudioReflectionProbeCarrier { readonly state: SceneReflectionProbeState; readonly texture?: THREE.Texture }
export interface StudioReflectionProbeCarriers { readonly probes: readonly StudioReflectionProbeCarrier[]; readonly owned: readonly THREE.Texture[]; readonly error?: string }
const EMPTY: StudioReflectionProbeCarriers = Object.freeze({ probes: [], owned: [] });

export function readStudioReflectionProbes(scene: THREE.Scene): StudioReflectionProbeCarriers {
  return scene.userData[KEY] as StudioReflectionProbeCarriers | undefined ?? EMPTY;
}
export function writeStudioReflectionProbes(scene: THREE.Scene, next: StudioReflectionProbeCarriers): void { scene.userData[KEY] = next; }
export function disposeStudioReflectionProbes(scene: THREE.Scene): void {
  const previous = readStudioReflectionProbes(scene); delete scene.userData[KEY];
  for (const texture of previous.owned) texture.dispose();
}

/** Reuses the viewer's HDR/EXR loader. One candidate shares each URL and never owns inherited textures. */
export async function loadStudioReflectionProbes(states: readonly SceneReflectionProbeState[] | undefined,
  load: (url: string) => Promise<THREE.Texture>, baseUrl?: string, base?: THREE.Texture): Promise<StudioReflectionProbeCarriers> {
  if (!states?.length) return EMPTY;
  if (states.length > 2) throw new RangeError("反射探针最多两个。");
  const current = structuredClone(states), owned = new Set<THREE.Texture>(), urls = new Map<string, THREE.Texture>();
  if (baseUrl && base) urls.set(baseUrl, base);
  const probes: StudioReflectionProbeCarrier[] = [];
  try {
    for (const state of current) {
      packReflectionProbeRecord({ center: [state.center.x, state.center.y, state.center.z],
        halfExtents: [state.halfExtents.x, state.halfExtents.y, state.halfExtents.z], blendDistance: state.blendDistance, influenceRadius: state.influenceRadius });
      if (!state.enabled) continue;
      let texture = base;
      if (state.environmentMapUrl) {
        texture = urls.get(state.environmentMapUrl);
        if (!texture) { texture = await load(state.environmentMapUrl); urls.set(state.environmentMapUrl, texture); owned.add(texture); }
      }
      probes.push(Object.freeze({ state: Object.freeze(state), ...(texture ? { texture } : {}) }));
    }
    return Object.freeze({ probes: Object.freeze(probes), owned: Object.freeze([...owned]) });
  } catch (error) {
    for (const texture of owned) texture.dispose();
    throw error;
  }
}
