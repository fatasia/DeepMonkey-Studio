import type { SceneMotionRouteState, Vector3Value } from "@bim-studio/contracts";

export interface MotionRouteLeg {
  from: Vector3Value;
  to: Vector3Value;
  fromPointId: string;
  toPointId: string;
  startSeconds: number;
  arrivalSeconds: number;
  endSeconds: number;
  distance: number;
  accelerationMps2: number;
  cruiseSpeedMps: number;
  rampSeconds: number;
  triangular: boolean;
}

export interface MotionRoutePlan {
  legs: MotionRouteLeg[];
  durationSeconds: number;
  repeating: boolean;
}

export interface MotionRouteSample {
  position: Vector3Value;
  direction: Vector3Value;
  completed: boolean;
  lastArrival?: { pointId: string; token: string };
}

/**
 * 将作者路线编译成确定性时间表。每段使用梯形或三角速度曲线，
 * 因而速度和加速度参数都会真实参与运行，而不是仅作为配置展示。
 */
export function buildMotionRoutePlan(route: SceneMotionRouteState): MotionRoutePlan | undefined {
  if (!route.enabled || route.points.length < 2) return undefined;
  const pairs = routePairs(route);
  const legs: MotionRouteLeg[] = [];
  let cursor = 0;
  for (const [fromIndex, toIndex] of pairs) {
    const fromPoint = route.points[fromIndex]!;
    const toPoint = route.points[toIndex]!;
    const distance = vectorDistance(fromPoint.position, toPoint.position);
    const cruiseSpeedMps = positive(fromPoint.speedOverrideMps, positive(route.speedMps, 1));
    const accelerationMps2 = positive(route.accelerationMps2, cruiseSpeedMps * 2);
    const profile = motionProfile(distance, cruiseSpeedMps, accelerationMps2);
    const arrivalSeconds = cursor + profile.durationSeconds;
    const endSeconds = arrivalSeconds + nonNegative(toPoint.waitSeconds);
    if (profile.durationSeconds <= 0 && endSeconds <= cursor) continue;
    legs.push({
      from: cloneVector(fromPoint.position),
      to: cloneVector(toPoint.position),
      fromPointId: fromPoint.id,
      toPointId: toPoint.id,
      startSeconds: cursor,
      arrivalSeconds,
      endSeconds,
      distance,
      accelerationMps2,
      cruiseSpeedMps: profile.peakSpeedMps,
      rampSeconds: profile.rampSeconds,
      triangular: profile.triangular,
    });
    cursor = endSeconds;
  }
  if (legs.length === 0 || cursor <= 0) return undefined;
  return { legs, durationSeconds: cursor, repeating: route.loopMode !== "once" };
}

export function sampleMotionRoute(plan: MotionRoutePlan, elapsedSeconds: number): MotionRouteSample {
  const elapsed = Math.max(0, finite(elapsedSeconds));
  const completed = !plan.repeating && elapsed >= plan.durationSeconds;
  const cycle = plan.repeating ? Math.floor(elapsed / plan.durationSeconds) : 0;
  let localSeconds = completed ? plan.durationSeconds : elapsed - cycle * plan.durationSeconds;
  // 浮点整周期应采样到新周期起点，不能误判为上一周期末端。
  if (plan.repeating && Math.abs(localSeconds - plan.durationSeconds) < 1e-9) localSeconds = 0;
  const legIndex = Math.max(0, plan.legs.findIndex((leg) => localSeconds <= leg.endSeconds + 1e-9));
  const leg = plan.legs[legIndex] ?? plan.legs.at(-1)!;
  const travelSeconds = Math.min(Math.max(localSeconds - leg.startSeconds, 0), leg.arrivalSeconds - leg.startSeconds);
  const travelled = travelDistance(leg, travelSeconds);
  const progress = leg.distance <= 1e-9 ? 1 : Math.min(1, travelled / leg.distance);
  const lastArrival = lastArrivalAt(plan, localSeconds, cycle, elapsed);
  return {
    position: interpolate(leg.from, leg.to, progress),
    direction: normalizedDirection(leg.from, leg.to),
    completed,
    ...(lastArrival ? { lastArrival } : {}),
  };
}

function routePairs(route: SceneMotionRouteState): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let index = 0; index < route.points.length - 1; index += 1) pairs.push([index, index + 1]);
  if (route.loopMode === "loop") pairs.push([route.points.length - 1, 0]);
  if (route.loopMode === "ping-pong") {
    for (let index = route.points.length - 1; index > 0; index -= 1) pairs.push([index, index - 1]);
  }
  return pairs;
}

function motionProfile(distance: number, speed: number, acceleration: number) {
  if (distance <= 1e-9) return { durationSeconds: 0, rampSeconds: 0, peakSpeedMps: 0, triangular: true };
  const fullRampSeconds = speed / acceleration;
  const fullRampDistance = 0.5 * acceleration * fullRampSeconds ** 2;
  if (distance < fullRampDistance * 2) {
    const rampSeconds = Math.sqrt(distance / acceleration);
    return { durationSeconds: rampSeconds * 2, rampSeconds, peakSpeedMps: acceleration * rampSeconds, triangular: true };
  }
  const cruiseDistance = distance - fullRampDistance * 2;
  return {
    durationSeconds: fullRampSeconds * 2 + cruiseDistance / speed,
    rampSeconds: fullRampSeconds,
    peakSpeedMps: speed,
    triangular: false,
  };
}

function travelDistance(leg: MotionRouteLeg, seconds: number): number {
  if (leg.distance <= 1e-9) return leg.distance;
  const duration = leg.arrivalSeconds - leg.startSeconds;
  if (seconds <= leg.rampSeconds) return 0.5 * leg.accelerationMps2 * seconds ** 2;
  if (seconds >= duration - leg.rampSeconds) {
    const remaining = duration - seconds;
    return leg.distance - 0.5 * leg.accelerationMps2 * remaining ** 2;
  }
  const rampDistance = 0.5 * leg.accelerationMps2 * leg.rampSeconds ** 2;
  return rampDistance + leg.cruiseSpeedMps * (seconds - leg.rampSeconds);
}

function lastArrivalAt(plan: MotionRoutePlan, localSeconds: number, cycle: number, elapsed: number) {
  let index = -1;
  for (let candidate = 0; candidate < plan.legs.length; candidate += 1) {
    if (plan.legs[candidate]!.arrivalSeconds <= localSeconds + 1e-9) index = candidate;
  }
  let arrivalCycle = cycle;
  if (index < 0 && plan.repeating && elapsed > 0) {
    index = plan.legs.length - 1;
    arrivalCycle = cycle - 1;
  }
  if (index < 0 || arrivalCycle < 0) return undefined;
  return { pointId: plan.legs[index]!.toPointId, token: `${arrivalCycle}:${index}` };
}

function interpolate(from: Vector3Value, to: Vector3Value, progress: number): Vector3Value {
  return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress, z: from.z + (to.z - from.z) * progress };
}

function normalizedDirection(from: Vector3Value, to: Vector3Value): Vector3Value {
  const length = vectorDistance(from, to);
  return length <= 1e-9 ? { x: 0, y: 0, z: 1 } : { x: (to.x - from.x) / length, y: (to.y - from.y) / length, z: (to.z - from.z) / length };
}

function vectorDistance(left: Vector3Value, right: Vector3Value): number {
  return Math.hypot(right.x - left.x, right.y - left.y, right.z - left.z);
}

function cloneVector(value: Vector3Value): Vector3Value {
  return { x: finite(value.x), y: finite(value.y), z: finite(value.z) };
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
