import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ViewerEngine } from "./ViewerEngine";

describe("XR session lifecycle", () => {
  it("clears the XR state when end resolves even if the browser end event is missed", async () => {
    const session = { end: vi.fn(async () => undefined) } as unknown as XRSession;
    const renderer = Object.create(THREE.WebGLRenderer.prototype) as THREE.WebGLRenderer;
    Object.defineProperty(renderer, "xr", {
      value: { enabled: true, getSession: () => session, setSession: vi.fn(async () => undefined) },
      configurable: true
    });
    renderer.setAnimationLoop = vi.fn();

    const engine = Object.create(ViewerEngine.prototype) as ViewerEngine & Record<string, unknown>;
    Object.assign(engine, {
      renderer,
      xrSession: session,
      xrActive: true,
      xrMode: "immersive-vr",
      xrControllers: [],
      xrRig: { position: { set: vi.fn() }, rotation: { set: vi.fn() } },
      scene: { background: null },
      animate: vi.fn(),
      onXRSessionChange: vi.fn()
    });

    await engine.endXR();

    expect(session.end).toHaveBeenCalledOnce();
    expect(engine["xrActive"]).toBe(false);
    expect(engine.onXRSessionChange).toHaveBeenCalledWith(undefined);
  });
});
