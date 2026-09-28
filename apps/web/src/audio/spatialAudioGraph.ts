/**
 * T29 空间音频图·上下文无关的构造与释放。
 *
 * 分工纪律(防重复实现):生产播放路径 = 既有 THREE.PositionalAudio
 * (viewer/viewerEngineSpatialAudio.ts,挂模型原点、监听器随相机、手势解锁、
 * buffer 加载缓存都在那一处);本模块不重造播放引擎,只把
 * "BufferSource → GainNode(线性音量) → PannerNode(inverse 距离模型)"
 * 的参数映射提取为可在任意 BaseAudioContext(含 OfflineAudioContext)构造、
 * 定位、显式释放的单元,供离线渲染验证与节点释放证明使用。
 * PannerNode 参数与 THREE 桥(applySpatialAudioSettings)一一对应,
 * 音量口径共用 effectiveLinearVolume——禁止在别处再写第二份参数映射。
 */

import { effectiveLinearVolume } from "./spatialAudioAttenuation";

export interface SpatialGraphParams {
  volume: number;
  muted: boolean;
  loop: boolean;
  refDistance: number;
  maxDistance: number;
  rolloffFactor: number;
  /** 默认 "HRTF"(与 THREE.PositionalAudio 出厂一致);离线数值断言用 "equalpower"。 */
  panningModel?: PanningModelType;
}

export interface SpatialAudioGraphNodes {
  readonly context: BaseAudioContext;
  source: AudioBufferSourceNode | null;
  gain: GainNode | null;
  panner: PannerNode | null;
  disposed: boolean;
}

export function buildSpatialGraph(
  context: BaseAudioContext,
  buffer: AudioBuffer,
  params: SpatialGraphParams,
  destination: AudioNode,
): SpatialAudioGraphNodes {
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = params.loop;
  const gain = context.createGain();
  gain.gain.value = effectiveLinearVolume(params.volume, params.muted);
  const panner = context.createPanner();
  panner.panningModel = params.panningModel ?? "HRTF";
  panner.distanceModel = "inverse";
  panner.refDistance = params.refDistance;
  panner.maxDistance = params.maxDistance;
  panner.rolloffFactor = params.rolloffFactor;
  source.connect(gain);
  gain.connect(panner);
  panner.connect(destination);
  return { context, source, gain, panner, disposed: false };
}

/** 声源定位:优先 AudioParam(positionX/Y/Z),旧实现回退 setPosition。 */
export function positionSpatialGraph(graph: SpatialAudioGraphNodes, x: number, y: number, z: number): void {
  const panner = graph.panner;
  if (!panner) return;
  const position = panner as PannerNode & { setPosition?: (x: number, y: number, z: number) => void };
  if (position.positionX && position.positionY && position.positionZ) {
    position.positionX.value = x;
    position.positionY.value = y;
    position.positionZ.value = z;
    return;
  }
  position.setPosition?.(x, y, z);
}

/**
 * 显式释放:停源、逐节点断开、清引用、置 disposed。
 * 声源移除路径必须调用(生产侧对应 disposeSpatialAudioRuntime 的 stop+disconnect)。
 * stop() 对未启动的源在某些实现抛 InvalidStateError,释放路径吞掉不外抛;
 * disconnect 幂等,重复 dispose 直接短路(无二次断开、无异常)。
 */
export function disposeSpatialGraph(graph: SpatialAudioGraphNodes): void {
  if (graph.disposed) return;
  graph.disposed = true;
  const source = graph.source;
  if (source) {
    try {
      source.stop();
    } catch {
      // 未 start 的源不可 stop:释放语义不受影响。
    }
    try {
      source.disconnect();
    } catch {
      // 已断开/未连接:幂等。
    }
  }
  graph.gain?.disconnect();
  graph.panner?.disconnect();
  graph.source = null;
  graph.gain = null;
  graph.panner = null;
}
