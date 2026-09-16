import { describe, expect, it } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { PbrPostProcessChain } from "./pbrPostProcessChain.js";

describe("PBR post-process construction", () => {
  it("does not touch the GPU when every allocative effect is disabled", () => {
    const session = new Proxy({}, {
      get: (_target, property) => {
        throw new Error(`Disabled post-process accessed session.${String(property)}.`);
      },
    }) as DeviceSession;
    const chain = new PbrPostProcessChain(session, {
      ambientOcclusion: false,
      temporalAa: false,
      occlusionCulling: false,
      bloom: false,
    });
    expect(() => chain.dispose()).not.toThrow();
  });
});
