import { describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import type { RenderView } from "../webgpu/pbrRenderer.js";
import { DeepWebGpuProbeClipmapSession } from "./DeepWebGpuProbeClipmapSession.js";

const EMPTY_PACKET = Object.freeze({ geometries: [], materials: [], instances: [] }) as RenderPacket;
const PACKET = Object.freeze({ geometries: [], materials: [],
  instances: [{ id: "instance", geometry: "geometry", material: "material",
    transform: new Float32Array(16) }] }) as unknown as RenderPacket;
const VIEW = Object.freeze({ width: 64, height: 64, pixelRatio: 1, eye: [0, 0, 4], target: [0, 0, 0],
  extent: 4, background: [0, 0, 0], floor: [0, 0, 0], exposure: 1, roughness: 1 }) as RenderView;

function fixture() {
  const controllers: Array<ReturnType<typeof fakeController>> = [];
  const factory = vi.fn(() => { const controller = fakeController(); controllers.push(controller); return controller; });
  const session = new DeepWebGpuProbeClipmapSession({} as never, factory as never);
  return { session, factory, controllers };
}

function fakeController() {
  return { radianceSource: "scene", sceneBounds: { min: [0, 0, 0], max: [1, 1, 1] },
    syncRenderPacket: vi.fn(), beginFrame: vi.fn().mockResolvedValue({ status: "committed" }), dispose: vi.fn() };
}

describe("DeepWebGpuProbeClipmapSession", () => {
  it("keeps requested GI at zero allocation for an empty scene and activates on the first real packet", () => {
    const f = fixture();
    f.session.syncPacket(EMPTY_PACKET); f.session.setEnabled(true);
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.session.diagnostics).toEqual({ requested: true, active: false, pending: false,
      radianceSource: "scene", packetRevision: 1, sceneInstanceCount: 0 });

    f.session.syncPacket(PACKET);
    expect(f.factory).toHaveBeenCalledOnce();
    expect(f.controllers[0]!.syncRenderPacket).toHaveBeenCalledOnce();
    expect(f.session.diagnostics).toMatchObject({ requested: true, active: true,
      packetRevision: 2, sceneInstanceCount: 1 });
  });

  it("fails closed without a real scene-radiance producer", () => {
    const setProbeClipmap = vi.fn();
    const session = new DeepWebGpuProbeClipmapSession({ setProbeClipmap } as never);
    session.syncPacket(PACKET); session.setEnabled(true); session.beginFrame(VIEW);

    expect(session.diagnostics).toEqual({ requested: true, active: false, pending: false,
      radianceSource: "unavailable", packetRevision: 1, sceneInstanceCount: 1 });
    expect(setProbeClipmap).not.toHaveBeenCalled();
  });

  it("rejects a host controller that still uses constant fallback radiance", () => {
    const fallback = { ...fakeController(), radianceSource: "fallback" };
    const session = new DeepWebGpuProbeClipmapSession({} as never, (() => fallback) as never);
    session.syncPacket(PACKET); session.setEnabled(true);

    expect(fallback.dispose).toHaveBeenCalledOnce();
    expect(session.diagnostics).toMatchObject({ requested: true, active: false,
      radianceSource: "unavailable", failure: "Studio probe GI requires a real scene-radiance encoder." });
  });

  it("retires the active GI controller when the scene becomes empty and lazily rebuilds it", () => {
    const f = fixture(); f.session.syncPacket(PACKET); f.session.setEnabled(true);
    const first = f.controllers[0]!;
    f.session.syncPacket(EMPTY_PACKET);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(f.session.active).toBe(false);
    f.session.beginFrame(VIEW);
    expect(first.beginFrame).not.toHaveBeenCalled();

    f.session.syncPacket(PACKET);
    expect(f.factory).toHaveBeenCalledTimes(2);
    expect(f.session.active).toBe(true);
  });

  it("cancels in-flight work, clears failure diagnostics and releases exactly once when disabled", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise(done => { resolve = done; });
    const f = fixture(); f.session.syncPacket(PACKET); f.session.setEnabled(true);
    const controller = f.controllers[0]!;
    controller.beginFrame.mockReturnValueOnce(pending);
    f.session.beginFrame(VIEW);
    expect(f.session.diagnostics.pending).toBe(true);
    f.session.setEnabled(false);
    expect(controller.dispose).toHaveBeenCalledOnce();
    expect(f.session.diagnostics).toMatchObject({ requested: false, active: false, pending: false });
    resolve({ status: "failed", error: new Error("late failure") });
    await Promise.resolve(); await Promise.resolve();
    expect(f.session.failure).toBeUndefined();
    f.session.dispose();
    expect(controller.dispose).toHaveBeenCalledOnce();
  });
});
