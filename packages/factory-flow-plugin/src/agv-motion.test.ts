import { describe, expect, it, vi } from "vitest";
import { AgvMotionSourceRouter, type AgvMotionSource } from "./agv-motion.js";

function source(mode: AgvMotionSource["mode"], x: number, reset = vi.fn()): AgvMotionSource {
  return {
    mode,
    reset,
    read: (_agvId, clockMs) => ({ timestampMs: clockMs, position: { x, y: 0, z: 0 } })
  };
}

describe("AgvMotionSourceRouter", () => {
  it("switches deterministically between simulation, realtime and replay sources", () => {
    const simulation = source("simulation", 1);
    const realtime = source("realtime", 2);
    const replay = source("replay", 3);
    const router = new AgvMotionSourceRouter([realtime, replay, simulation]);

    expect(router.availableModes).toEqual(["realtime", "replay", "simulation"]);
    expect(router.read("agv-1", 100)?.position.x).toBe(1);
    router.switchMode("realtime");
    expect(router.read("agv-1", 200)?.position.x).toBe(2);
    router.switchMode("replay");
    expect(router.read("agv-1", 300)?.position.x).toBe(3);
    expect(realtime.reset).toHaveBeenCalledOnce();
    expect(replay.reset).toHaveBeenCalledOnce();
  });

  it("returns a defensive pose and rejects unavailable modes", () => {
    const router = new AgvMotionSourceRouter([source("simulation", 4)]);
    const pose = router.read("agv-1", 100)!;
    pose.position.x = 99;
    expect(router.read("agv-1", 100)?.position.x).toBe(4);
    expect(() => router.switchMode("realtime")).toThrow("is not registered");
  });
});
