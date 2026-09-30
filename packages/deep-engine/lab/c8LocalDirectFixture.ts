import * as THREE from "three";
import { createSharedSceneFixture, type SharedStage } from "./c8SharedSceneFixture.js";
import { resolvePbrSceneLighting } from "../src/lighting/pbrSceneLighting.js";

export const localDirectCases = ["point-only", "spot-only", "secondary-directional"] as const;
export type LocalDirectCase = typeof localDirectCases[number];

/** Reuses the existing author root and production light projection. */
export function createLocalDirectFixture(kind: LocalDirectCase) {
  if (!localDirectCases.includes(kind)) throw Error("Unknown local direct fixture");
  const fixture = createSharedSceneFixture();
  for (const object of [...fixture.scene.children]) if (object instanceof THREE.DirectionalLight) {
    fixture.scene.remove(object, object.target);
  }
  const color = new THREE.Color(1, .95, .9);
  const light = kind === "point-only" ? new THREE.PointLight(color, 0, 20, 2)
    : kind === "spot-only" ? new THREE.SpotLight(color, 0, 20, .8, .2, 2)
      : new THREE.DirectionalLight(color, 0);
  light.position.set(-3, 4, 5); light.castShadow = false;
  const intensity = kind === "secondary-directional" ? 3 : 120;
  if (kind === "secondary-directional") {
    const disabled = new THREE.DirectionalLight(color, 0); disabled.position.set(-3, 4, 5);
    disabled.castShadow = false; fixture.scene.add(disabled, disabled.target);
  }
  fixture.scene.add(light);
  if (light instanceof THREE.SpotLight || light instanceof THREE.DirectionalLight) fixture.scene.add(light.target);
  function setStage(stage: SharedStage) {
    fixture.setStage(stage); light.intensity = stage === "direct-diagnostic" ? intensity : 0;
    fixture.scene.updateMatrixWorld(true);
  }
  const view = (camera: number, exposure: number) => {
    const result = fixture.view(camera, exposure), lighting = resolvePbrSceneLighting(result.lights);
    if (lighting.primary.intensity !== 0) throw Error("Local direct fixture unexpectedly enabled primary light");
    return result;
  };
  setStage("strict-emissive");
  return { ...fixture, setStage, view };
}
