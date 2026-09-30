/**
 * J3-E：编辑器瞬时动画播放头读取。
 *
 * 播放头只存在于引擎 transient "animation" 通道（与 App 播放宿主
 * readAnimationPlayhead、sceneAnimationCommands 同一来源），不进 SceneSnapshot——
 * 快照只含动画策略。渲染器重建类恢复（设备丢失/WebGPU 回收/返回编辑器）在
 * 捕获快照的同一时刻读取它，恢复时经 applyScene 回 seek；通道缺失、异常或
 * 非法值一律返回 undefined，恢复语义保持归零重放（与既有行为逐位一致）。
 */
type AnimationChannelHost = {
  readonly transientChannels?: {
    readonly channel?: <T>(name: string) => { readonly snapshot: () => T } | undefined;
  };
};

export function readAnimationPlayheadSec(engine: AnimationChannelHost | undefined | null): number | undefined {
  try {
    const snapshot = engine?.transientChannels?.channel?.<{ time: number; playing: boolean }>("animation")?.snapshot();
    const time = (snapshot as { time?: unknown } | undefined)?.time;
    return typeof time === "number" && Number.isFinite(time) && time > 0 ? time : undefined;
  } catch {
    return undefined;
  }
}
