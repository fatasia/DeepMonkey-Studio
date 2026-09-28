/**
 * T29 空间音频·距离衰减纯模型(唯一权威公式,禁止第二处推导)。
 *
 * 与运行时的关系:生产播放路径是既有 THREE.PositionalAudio
 * (viewer/viewerEngineSpatialAudio.ts,监听器随相机、声源挂模型原点),
 * 它把 SceneSpatialAudioState 的 ref/max/rolloff 原样交给 Web Audio PannerNode
 * 的 "inverse" 距离模型;本模块把同一条规范公式提取为纯函数,供单测、
 * 离线渲染验证(offlineAudioAudit.ts 经 OfflineAudioContext)与音量口径共用。
 *
 * Web Audio 规范 inverse 模型:
 *   gain(d) = refDistance / (refDistance + rolloffFactor * max(d - refDistance, 0))
 * - d <= refDistance 时恒为 1(近场不放大);
 * - rolloffFactor = 0 时恒为 1(无衰减);
 * - maxDistance 在 inverse 模型中不改变增益(规范语义:仅约束参数归一,
 *   linear 模型才用它截断);SceneSpatialAudioState.maxDistance 的
 *   "超过该距离后不再继续增强可听范围"由 normalizeSpatialAudioState 保证
 *   maxDistance >= refDistance 后原样下传 PannerNode,语义一致。
 */

export interface SpatialAudioAttenuationParams {
  refDistance: number;
  maxDistance: number;
  rolloffFactor: number;
}

/**
 * 合同口径:SceneSpatialAudioState.volume 是"线性音量,运行时限制在 0..1",
 * 静音 = 0。THREE 桥(applySpatialAudioSettings)与离线验证共用本函数,
 * 消除"muted 时是否还乘 volume"的口径漂移。
 */
export function effectiveLinearVolume(volume: number, muted: boolean): number {
  if (!Number.isFinite(volume)) return 0;
  if (muted) return 0;
  return Math.min(Math.max(volume, 0), 1);
}

/**
 * inverse 距离增益。参数异常(负/非有限)时保守返回 1:不放大、不静音,
 * 异常值应由 normalizeSpatialAudioState 在进场景前兜底,这里只做防御。
 */
export function inverseDistanceGain(params: SpatialAudioAttenuationParams, distance: number): number {
  const ref = params.refDistance;
  const rolloff = params.rolloffFactor;
  if (!(ref > 0) || !Number.isFinite(ref)) return 1;
  if (!Number.isFinite(rolloff) || rolloff < 0) return 1;
  if (!Number.isFinite(distance) || distance < 0) return 1;
  if (distance <= ref) return 1;
  return ref / (ref + rolloff * (distance - ref));
}
