import type { SceneCameraPort, SceneCameraPose } from "./SceneCameraPort";
import type { SceneCameraFlyTween } from "./SceneCameraFlyTween";

/**
 * H-C7-P3 相机 Tween 生产播放层(第五批示例的宿主循环正式形态)。
 *
 * 轨迹合同不变(sample 端点精确/越界截断,见 SceneCameraFlyTween);本层补齐生产要求:
 * - **rAF 驱动**:`requestFrame` 参数化(缺省 window.requestAnimationFrame;测试注入手动帧泵);
 *   时间取自 `now()`(参数化,缺省 performance.now),帧长抖动/后台节流由 sample 越界截断兜底;
 * - **取消**:句柄 `cancel()` 停在当前帧(相机保持最后一次采样,不回跳起点),返回是否已终;
 * - **单飞行互斥**:同 port 的新起飞自动取消前一飞行(中断恢复=旧飞行停在当前位置,新飞行
 *   从当前位置的真实 pose 起步——由调用方传当前 snapshot pose 作 from 保证);
 * - **终点权威落位**:最后一帧 `setCamera(to)` 精确落位后 `onComplete(true)` 恰一次;
 *   取消路径 `onComplete(false)` 恰一次。
 *
 * 仍然**从不向事务驱动发 durationMs>0 的 fly-to**(driver 如实拒绝;终点态若需落库由
 * 调用方在 onComplete(true) 后经 camera.set 事务自行落库)。
 */

export interface CameraFlyTweenPlaybackOptions {
  readonly port: SceneCameraPort;
  readonly tween: SceneCameraFlyTween;
  /** 完成回调:reached=true 终点落位完成,false=被取消(停在当前采样)。恰调一次。 */
  readonly onComplete?: (reached: boolean) => void;
  /** 帧调度;缺省 window.requestAnimationFrame(非浏览器环境必须注入)。 */
  readonly requestFrame?: (callback: () => void) => unknown;
  /** 取消帧调度;与 requestFrame 成对注入。 */
  readonly cancelFrame?: (handle: unknown) => void;
  /** 毫秒时钟;缺省 performance.now。 */
  readonly now?: () => number;
}

export interface CameraFlyTweenPlaybackHandle {
  /** 取消飞行:停帧并触发 onComplete(false)。已终/已取消时为 no-op(幂等)。 */
  cancel(): void;
  /** 是否仍在播放。 */
  readonly active: boolean;
}

/** 同 port 单飞行互斥登记:新起飞取消旧飞行。 */
const activePlays = new WeakMap<SceneCameraPort, CameraFlyTweenPlaybackHandle>();

export function startCameraFlyTweenPlayback(options: CameraFlyTweenPlaybackOptions): CameraFlyTweenPlaybackHandle {
  const { port, tween } = options;
  const requestFrame = options.requestFrame ?? ((callback: () => void) => window.requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle: unknown) => window.cancelAnimationFrame(handle as number));
  const now = options.now ?? (() => performance.now());

  // 中断恢复:旧飞行停在当前位置(它已把最后采样写进 port),新飞行从调用方给的 from 起步。
  activePlays.get(port)?.cancel();

  let cancelled = false;
  let finished = false;
  let frameHandle: unknown = undefined;
  const startMs = now();
  let lastSample: SceneCameraPose = tween.sample(0);
  port.setCamera(lastSample);

  const handle: CameraFlyTweenPlaybackHandle = {
    cancel(): void {
      if (finished) return;
      cancelled = true;
      finished = true;
      if (frameHandle !== undefined) cancelFrame(frameHandle);
      activePlays.delete(port);
      options.onComplete?.(false);
    },
    get active(): boolean { return !finished; },
  };
  activePlays.set(port, handle);

  const step = (): void => {
    if (cancelled || finished) return;
    const elapsed = now() - startMs;
    if (elapsed >= tween.durationMs) {
      finished = true;
      activePlays.delete(port);
      port.setCamera(tween.to); // 终点精确落位(权威终点态)。
      options.onComplete?.(true);
      return;
    }
    lastSample = tween.sample(elapsed);
    port.setCamera(lastSample);
    frameHandle = requestFrame(step);
  };
  frameHandle = requestFrame(step);
  return handle;
}

/** 查询某 port 当前的飞行句柄(宿主在切换场景/销毁时取消用)。 */
export function activeCameraFlyTween(port: SceneCameraPort): CameraFlyTweenPlaybackHandle | undefined {
  const handle = activePlays.get(port);
  return handle?.active ? handle : undefined;
}
