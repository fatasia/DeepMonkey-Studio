import * as THREE from "three";
import type { GlobalLightingState, SceneLightState } from "@bim-studio/contracts";

/** Bridges persisted author state into the existing Deep projection carriers. */
export function applySceneIesProfiles(scene: THREE.Scene, lighting: GlobalLightingState): void {
  if (lighting.lightProfiles?.length) scene.userData.lightProfiles = structuredClone(lighting.lightProfiles);
  else delete scene.userData.lightProfiles;
}

export function applyLightIes(light: THREE.Light, state: SceneLightState): void {
  if (state.type === "spot" && state.ies) light.userData.ies = structuredClone(state.ies);
  else delete light.userData.ies;
}
