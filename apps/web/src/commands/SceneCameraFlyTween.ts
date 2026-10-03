import type { SceneCameraPort, SceneCameraPose } from "./SceneCameraPort";

/**
 * H-C7-P3 第五批 宿主相机 Tween 装配示例(非生产接线,不建通用 Tween 系统)。
 *
 * 合同背景:driver 对 `camera.fly-to` 的 `durationMs>0` 如实拒绝——时长缓动属宿主相机
 * Tween 播放层,事务驱动只消费即时终点态。本文件给出该播放层的最小装配形:
 *
 * 1. 宿主解析飞行意图为起点/终点 pose(终点即 driver camera.set 会消费的即时终点态;
 *    driver 侧 fly-to 解析只到 look-at/focus-object/fit-scene 几何事实,取景逼近属宿主);
 * 2. `assembleCameraFlyTween` 把两端装配成可采样的轨迹(端点精确、数值键缓动插值);
 * 3. 播放循环逐帧 `cameraPort.setCamera(sample(elapsed))` ——**只驱动 cameraPort,
 *    从不向事务驱动发 durationMs>0 的 fly-to**(driver 会如实拒绝);终点一帧
 *    `setCamera(to)` 精确落位,权威终点态可再经 camera.set 事务落库。
 *
 * 示例循环是同步的;真实宿主把 `playCameraFlyTween` 的循环体换成 rAF/取消句柄即可,
 * 轨迹合同(sample 端点精确、进度截断)不变。缓动只带 easeInOutCubic 一族;
 * 取景策略、曲线库、中断恢复登记后续。
 */

/** 缓动:(进度 t∈[0,1])→进度∈[0,1];要求单调、端点不动。 */
export type SceneCameraTweenEasing = (t: number) => number;

/** 三次缓入缓出(与主流 web 动画同式;示例默认)。 */
export const sceneCameraEaseInOutCubic: SceneCameraTweenEasing = t =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

export interface SceneCameraFlyTweenOptions {
  /** 飞行时长(毫秒);> 0 且有限——0/负数/非有限值如实拒绝(时长只活在本层)。 */
  readonly durationMs: number;
  readonly easing?: SceneCameraTweenEasing;
  /** 示例循环的帧步长(毫秒);缺省 1000/60。 */
  readonly frameMs?: number;
}

export interface SceneCameraFlyTween {
  readonly from: SceneCameraPose;
  readonly to: SceneCameraPose;
  readonly durationMs: number;
  readonly frameMs: number;
  /** elapsedMs∈[0,durationMs] → 插值 pose;越界截断,t=0/t=durationMs 精确返回起/终点。 */
  sample(elapsedMs: number): SceneCameraPose;
}

/**
 * 装配相机飞行轨迹。pose 的可选数值键(near/far/fov)两侧都定义则插值、仅一侧定义则
 * 该侧值恒定持有——不静默补默认值。缓动进度额外截断到 [0,1],异常缓动不会把相机推出
 * 起终点包围盒(fail-safe,不是对缓动质量的背书)。
 */
export function assembleCameraFlyTween(
  from: SceneCameraPose,
  to: SceneCameraPose,
  options: SceneCameraFlyTweenOptions,
): SceneCameraFlyTween {
  if (!Number.isFinite(options.durationMs) || options.durationMs <= 0) {
    throw new Error(`Camera fly tween requires a finite positive durationMs; got ${options.durationMs}.`);
  }
  const frameMs = options.frameMs ?? 1000 / 60;
  if (!Number.isFinite(frameMs) || frameMs <= 0) {
    throw new Error(`Camera fly tween requires a finite positive frameMs; got ${frameMs}.`);
  }
  const easing = options.easing ?? sceneCameraEaseInOutCubic;
  assertFinitePose("from", from);
  assertFinitePose("to", to);
  const clone = (pose: SceneCameraPose): SceneCameraPose => ({
    position: [...pose.position] as [number, number, number],
    target: [...pose.target] as [number, number, number],
    ...(pose.near === undefined ? {} : { near: pose.near }),
    ...(pose.far === undefined ? {} : { far: pose.far }),
    ...(pose.fov === undefined ? {} : { fov: pose.fov }),
  });
  const start = clone(from);
  const end = clone(to);
  return {
    from: start,
    to: end,
    durationMs: options.durationMs,
    frameMs,
    sample(elapsedMs: number): SceneCameraPose {
      const raw = elapsedMs <= 0 ? 0 : elapsedMs >= options.durationMs ? 1 : elapsedMs / options.durationMs;
      const t = Math.min(1, Math.max(0, easing(raw)));
      return {
        position: lerpTriple(start.position, end.position, t),
        target: lerpTriple(start.target, end.target, t),
        ...lerpOptional("near", start.near, end.near, t),
        ...lerpOptional("far", start.far, end.far, t),
        ...lerpOptional("fov", start.fov, end.fov, t),
      };
    },
  };
}

/**
 * 装配示例循环:从 t=0 逐帧推进到终点,每帧经 cameraPort.setCamera 写权威 pose,
 * 终点一帧精确落位并返回。同步循环仅供 CLI/单测;真实宿主换成 rAF 驱动时,
 * 每帧仍然是 `setCamera(tween.sample(elapsed))`——不经过事务驱动的 fly-to。
 */
export function playCameraFlyTween(port: SceneCameraPort, tween: SceneCameraFlyTween): SceneCameraPose {
  port.setCamera(tween.sample(0));
  for (let elapsed = tween.frameMs; elapsed < tween.durationMs; elapsed += tween.frameMs) {
    port.setCamera(tween.sample(elapsed));
  }
  port.setCamera(tween.to);
  return port.snapshot().pose ?? tween.to;
}

function lerpTriple(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t];
}

function lerpOptional(
  key: "near" | "far" | "fov",
  a: number | undefined,
  b: number | undefined,
  t: number,
): { [K in "near" | "far" | "fov"]?: number } {
  if (a === undefined && b === undefined) return {};
  if (a === undefined) return { [key]: b };
  if (b === undefined) return { [key]: a };
  return { [key]: a + (b - a) * t };
}

function assertFinitePose(label: string, pose: SceneCameraPose): void {
  for (const [key, value] of [["position", pose.position], ["target", pose.target]] as const) {
    if (value.length !== 3 || !value.every(Number.isFinite)) {
      throw new Error(`Camera fly tween ${label}.${key} must be a finite [x,y,z] triple.`);
    }
  }
  for (const key of ["near", "far", "fov"] as const) {
    const value = pose[key];
    if (value !== undefined && !Number.isFinite(value)) {
      throw new Error(`Camera fly tween ${label}.${key} must be a finite number.`);
    }
  }
}
