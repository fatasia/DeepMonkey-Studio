import { describe, expect, it, vi } from "vitest";
import type { ApplicationInteractionEffect } from "@bim-studio/studio-core";
import {
  publishApplicationInteractionEffects,
  subscribeApplicationInteractionEffects
} from "./applicationInteractionHost.js";

describe("application interaction host", () => {
  it("publishes immutable interaction effects and supports unsubscribe", () => {
    const target = new EventTarget();
    const listener = vi.fn();
    const effect: ApplicationInteractionEffect = {
      flowId: "flow:focus",
      source: { kind: "widget", id: "widget:line" },
      action: { id: "focus", type: "focus", enabled: true, target: { kind: "object", modelId: "machine:1" } },
      timestamp: "2026-08-25T00:00:00.000Z"
    };
    const unsubscribe = subscribeApplicationInteractionEffects(listener, target);

    publishApplicationInteractionEffects([effect], target);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(effect);
    expect(listener.mock.calls[0]?.[0]).not.toBe(effect);
    target.dispatchEvent(new CustomEvent("bim-studio:application-interaction-effect"));
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    publishApplicationInteractionEffects([effect], target);
    expect(listener).toHaveBeenCalledOnce();
  });
});
