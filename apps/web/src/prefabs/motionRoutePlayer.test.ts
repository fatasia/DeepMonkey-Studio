import { describe, expect, it } from "vitest";
import type { SceneMotionRouteState } from "@bim-studio/contracts";
import { buildMotionRoutePlan, sampleMotionRoute } from "./motionRoutePlayer";

function route(loopMode: SceneMotionRouteState["loopMode"] = "once"): SceneMotionRouteState {
  return {
    enabled: true,
    points: [
      { id: "start", position: { x: 0, y: 0, z: 0 } },
      { id: "station", position: { x: 10, y: 0, z: 0 }, waitSeconds: 1 },
    ],
    speedMps: 2,
    accelerationMps2: 1,
    loopMode,
    orientToPath: true,
    startOffsetSeconds: 0,
  };
}

describe("motionRoutePlayer", () => {
  it("uses acceleration and wait time in a deterministic once route", () => {
    const plan = buildMotionRoutePlan(route())!;
    expect(plan.durationSeconds).toBeCloseTo(8);
    expect(sampleMotionRoute(plan, 1).position.x).toBeCloseTo(0.5);
    expect(sampleMotionRoute(plan, 7.2)).toMatchObject({
      position: { x: 10, y: 0, z: 0 },
      completed: false,
      lastArrival: { pointId: "station", token: "0:0" },
    });
    expect(sampleMotionRoute(plan, 8).completed).toBe(true);
  });

  it("creates a continuous loop instead of teleporting from end to start", () => {
    const plan = buildMotionRoutePlan(route("loop"))!;
    expect(plan.legs).toHaveLength(2);
    const returnLeg = plan.legs[1]!;
    const sample = sampleMotionRoute(plan, returnLeg.startSeconds + 1);
    expect(sample.position.x).toBeLessThan(10);
    expect(sample.direction.x).toBeLessThan(0);
  });

  it("plays ping-pong routes forward and backward and emits stable arrival tokens", () => {
    const plan = buildMotionRoutePlan(route("ping-pong"))!;
    expect(plan.legs.map((leg) => [leg.fromPointId, leg.toPointId])).toEqual([
      ["start", "station"],
      ["station", "start"],
    ]);
    const firstCycleEnd = sampleMotionRoute(plan, plan.durationSeconds);
    const nextCycle = sampleMotionRoute(plan, plan.durationSeconds + 0.01);
    expect(firstCycleEnd.lastArrival?.pointId).toBe("start");
    expect(nextCycle.lastArrival?.token).toBe("0:1");
  });
});
