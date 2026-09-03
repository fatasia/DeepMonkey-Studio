import type { SceneSnapshot } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

export function sceneOptionLabel(scene: SceneSnapshot, locale: AppLocale) {
  const objectCount = scene.models.length + scene.primitives.length;
  return `${scene.name} · ${tr(locale, `${objectCount} 个对象`, `${objectCount} objects`)} · #${scene.id.slice(-12)}`;
}

export function preferredUsableScene(scenes: SceneSnapshot[]) {
  return scenes.reduce<SceneSnapshot | undefined>((best, scene) => {
    const count = scene.models.length + scene.primitives.length;
    const bestCount = best ? best.models.length + best.primitives.length : -1;
    return count > bestCount ? scene : best;
  }, undefined) ?? scenes[0];
}
