import { describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import type { RenderView } from "../webgpu/pbrRenderer.js";
import { DeepWebGpuProbeClipmapSession } from "./DeepWebGpuProbeClipmapSession.js";

const PACKET = Object.freeze({ geometries: [], materials: [],
  instances: [{ id: "instance", geometry: "geometry", material: "material",
    transform: new Float32Array(16) }] }) as unknown as RenderPacket;
const VIEW = Object.freeze({ width: 64, height: 64, pixelRatio: 1, eye: [0, 0, 4], target: [0, 0, 0],
  extent: 4, background: [0, 0, 0], floor: [0, 0, 0], exposure: 1, roughness: 1 }) as RenderView;

interface FakeSurfaceCache { pendingCount: number }
interface FakeController { radianceSource: string; sceneBounds: unknown;
  syncRenderPacket: ReturnType<typeof vi.fn>; beginFrame: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>; surfaceCache: FakeSurfaceCache;
  current: { frameStats: { deferredCount: number } } | undefined }

function fixture() {
  const controller: FakeController = { radianceSource: "scene",
    sceneBounds: { min: [0, 0, 0], max: [1, 1, 1] },
    syncRenderPacket: vi.fn(), beginFrame: vi.fn().mockResolvedValue({ status: "committed" }),
    dispose: vi.fn(), surfaceCache: { pendingCount: 0 }, current: undefined };
  const session = new DeepWebGpuProbeClipmapSession({} as never, (() => controller) as never);
  session.syncPacket(PACKET);
  session.setEnabled(true);
  return { session, controller };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
}

describe("DeepWebGpuProbeClipmapSession capture pump (F5-L4)", () => {
  it("reports unavailable without an active controller and never reports work", () => {
    const idle = new DeepWebGpuProbeClipmapSession({} as never);
    expect(idle.captureTick()).toBe("unavailable");
    expect(idle.hasPendingWork()).toBe(false);
  });

  it("is busy while a capture is in flight and re-drives with the same view afterwards", async () => {
    let release!: (value: { status: string }) => void;
    const { session, controller } = fixture();
    controller.beginFrame.mockImplementationOnce(() => new Promise(done => { release = done; }));
    session.beginFrame(VIEW);
    expect(session.captureTick()).toBe("busy");
    release({ status: "committed" });
    await settle();

    // Still initial fill (no committed snapshot in this fake): capture debt persists and the
    // tick re-submits the SAME view snapshot — still scenes keep capturing without a frame.
    expect(session.hasPendingWork()).toBe(true);
    expect(session.captureTick()).toBe("submitted");
    expect(controller.beginFrame).toHaveBeenCalledTimes(2);
    const secondCall = controller.beginFrame.mock.calls[1]![0] as { cameraPosition: number[] };
    expect(secondCall.cameraPosition).toEqual([0, 0, 4]);
    expect(session.captureTick()).toBe("busy");
  });

  it("goes idle exactly when surface cache and scheduler both report no capture debt", async () => {
    const { session, controller } = fixture();
    session.beginFrame(VIEW);
    await settle();

    controller.current = { frameStats: { deferredCount: 3 } };
    expect(session.captureTick()).toBe("submitted");
    await settle();

    controller.current = { frameStats: { deferredCount: 0 } };
    expect(session.hasPendingWork()).toBe(false);
    expect(session.captureTick()).toBe("idle");
    const calls = controller.beginFrame.mock.calls.length;
    // Deferred probes alone keep the pump alive.
    controller.current = { frameStats: { deferredCount: 1 } };
    expect(session.captureTick()).toBe("submitted");
    await settle();
    controller.current = { frameStats: { deferredCount: 0 } };
    expect(session.captureTick()).toBe("idle");
    expect(controller.beginFrame.mock.calls.length).toBe(calls + 1);

    // A dirty surface re-arms the pump even before the next plan runs.
    controller.surfaceCache.pendingCount = 2;
    expect(session.hasPendingWork()).toBe(true);
    expect(session.captureTick()).toBe("submitted");
  });

  it("latches a failed capture so the pump cannot idle-loop on a persistent error", async () => {
    let reject!: (reason: Error) => void;
    const { session, controller } = fixture();
    controller.beginFrame.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    session.beginFrame(VIEW);
    reject(new Error("Probe scene radiance capture is unavailable (no opaque scene geometry)."));
    await settle();
    expect(session.diagnostics).toMatchObject({ failure: /no opaque scene geometry/ });
    expect(session.hasPendingWork()).toBe(true);
    // Persistent for this packet: tick stays unavailable so the host pump self-terminates.
    expect(session.captureTick()).toBe("unavailable");
    expect(controller.beginFrame).toHaveBeenCalledTimes(1);
  });

  it("stops reporting work after dispose", async () => {
    const { session } = fixture();
    session.beginFrame(VIEW);
    await settle();
    session.dispose();
    expect(session.captureTick()).toBe("unavailable");
    expect(session.hasPendingWork()).toBe(false);
  });
});
