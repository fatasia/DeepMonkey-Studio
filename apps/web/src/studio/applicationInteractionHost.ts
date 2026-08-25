import type { ApplicationInteractionEffect } from "@bim-studio/studio-core";

export const APPLICATION_INTERACTION_EFFECT_EVENT = "bim-studio:application-interaction-effect";

export function publishApplicationInteractionEffects(
  effects: readonly ApplicationInteractionEffect[],
  target: EventTarget = window
): void {
  for (const effect of effects) {
    target.dispatchEvent(new CustomEvent(APPLICATION_INTERACTION_EFFECT_EVENT, { detail: structuredClone(effect) }));
  }
}

export function subscribeApplicationInteractionEffects(
  listener: (effect: ApplicationInteractionEffect) => void,
  target: EventTarget = window
): () => void {
  const handle = (event: Event) => {
    const effect = (event as CustomEvent<ApplicationInteractionEffect | undefined>).detail;
    if (effect?.flowId && effect.action) listener(effect);
  };
  target.addEventListener(APPLICATION_INTERACTION_EFFECT_EVENT, handle);
  return () => target.removeEventListener(APPLICATION_INTERACTION_EFFECT_EVENT, handle);
}
