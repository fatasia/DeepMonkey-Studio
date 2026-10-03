import { describe, expect, it, vi } from "vitest";
import { assembleCameraFlyTween, sceneCameraEaseInOutCubic } from "./SceneCameraFlyTween";
import { activeCameraFlyTween, startCameraFlyTweenPlayback, type CameraFlyTweenPlaybackOptions } from "./SceneCameraFlyTweenPlayback";
import type { SceneCameraPort, SceneCameraPose } from "./SceneCameraPort";

/** 手动帧泵:可控时间与帧序,替代 rAF。 */
function manualPump() {
  let clock = 0;
  const queue: Array<() => void> = [];
  const options = {
    requestFrame: (callback: () => void) => { queue.push(callback); return queue.length; },
    cancelFrame: (handle: unknown) => { const index = (handle as number) - 1; if (index >= 0 && index < queue.length) queue[index] = () => {}; },
    now: () => clock,
  };
  return {
    options,
    advance(ms: number) {
      clock += ms;
      const pending = queue.splice(0);
      for (const callback of pending) callback();
    },
  };
}

function memoryPort(start?: SceneCameraPose): SceneCameraPort & { writes: SceneCameraPose[] } {
  let pose: SceneCameraPose | null = start ?? null;
  const writes: SceneCameraPose[] = [];
  return {
    writes,
    setCamera(next) { pose = { position: [...next.position], target: [...next.target], ...(next.fov === undefined ? {} : { fov: next.fov }) }; writes.push(next); },
    flyTo() { throw new Error("playback 层不得调用 flyTo"); },
    snapshot() { return { pose: pose === null ? null : { ...pose, position: [...pose.position], target: [...pose.target] }, lastIntent: null }; },
    restore(snapshot) { pose = snapshot.pose; },
  };
}

const FROM: SceneCameraPose = { position: [0, 0, 0], target: [10, 0, 0] };
const TO: SceneCameraPose = { position: [20, 10, -6], target: [0, 5, 3], fov: 55 };

function playbackOptions(port: SceneCameraPort, pump: ReturnType<typeof manualPump>, onComplete?: (reached: boolean) => void): CameraFlyTweenPlaybackOptions {
  return { port, tween: assembleCameraFlyTween(FROM, TO, { durationMs: 300 }),
    ...(onComplete ? { onComplete } : {}),
    requestFrame: pump.options.requestFrame, cancelFrame: pump.options.cancelFrame, now: pump.options.now };
}

describe("H-C7-P3 相机 Tween 生产播放层", () => {
  it("rAF 全帧序:逐帧采样推进,终点精确落位且 onComplete(true) 恰一次", () => {
    const pump = manualPump();
    const port = memoryPort();
    const onComplete = vi.fn();
    startCameraFlyTweenPlayback(playbackOptions(port, pump, onComplete));

    const seen: Array<[number, number, number]> = [];
    for (let i = 0; i < 5; i += 1) { pump.advance(50); if (port.writes.at(-1)) seen.push([...port.writes.at(-1)!.position]); }
    // 中间帧单调趋近终点(easeInOutCubic 非线性,但方向单调)。
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.at(-1)![0]).toBeGreaterThan(seen[0]![0]);
    pump.advance(100); // 越过 300ms 终点。
    expect(port.writes.at(-1)!.position).toEqual([20, 10, -6]);
    expect(port.writes.at(-1)!.fov).toBe(55);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(true);
    expect(activeCameraFlyTween(port)).toBeUndefined();
  });

  it("cancel 停在当前采样不回跳,相机保持最后写入;onComplete(false) 恰一次", () => {
    const pump = manualPump();
    const port = memoryPort();
    const onComplete = vi.fn();
    const handle = startCameraFlyTweenPlayback(playbackOptions(port, pump, onComplete));
    pump.advance(60);
    const lastWrite = port.writes.at(-1)!;
    handle.cancel();
    const afterCancel = port.writes.length;
    pump.advance(500); // 取消后帧泵空转,不再写相机。
    expect(port.writes.length).toBe(afterCancel);
    expect(port.writes.at(-1)!.position).toEqual(lastWrite.position);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(false);
    handle.cancel(); // 幂等。
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("单飞行互斥:新起飞自动取消旧飞行,旧 onComplete(false) 恰一次", () => {
    const pump = manualPump();
    const port = memoryPort();
    const first = vi.fn(), second = vi.fn();
    const firstHandle = startCameraFlyTweenPlayback(playbackOptions(port, pump, first));
    expect(firstHandle.active).toBe(true);
    startCameraFlyTweenPlayback(playbackOptions(port, pump, second));
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(false);
    expect(firstHandle.active).toBe(false);
    pump.advance(500);
    expect(first).toHaveBeenCalledTimes(1); // 旧飞行不再推进。
    expect(second).toHaveBeenCalledWith(true);
  });

  it("cancelFrame 生效:取消后挂起帧回调不再执行写相机", () => {
    const pump = manualPump();
    const port = memoryPort();
    const handle = startCameraFlyTweenPlayback(playbackOptions(port, pump));
    pump.advance(60);
    const writesAtCancel = port.writes.length;
    handle.cancel();
    pump.advance(60);
    expect(port.writes.length).toBe(writesAtCancel);
  });

  it("装配复用:easeInOutCubic 端点不动与播放层合同一致(t=0/t=end 精确)", () => {
    expect(sceneCameraEaseInOutCubic(0)).toBe(0);
    expect(sceneCameraEaseInOutCubic(1)).toBe(1);
    const tween = assembleCameraFlyTween(FROM, TO, { durationMs: 300 });
    expect(tween.sample(0).position).toEqual([0, 0, 0]);
    expect(tween.sample(300).position).toEqual([20, 10, -6]);
    expect(tween.sample(9999).position).toEqual([20, 10, -6]); // 越界截断。
  });
});
