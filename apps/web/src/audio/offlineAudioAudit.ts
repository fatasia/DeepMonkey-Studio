/**
 * T29 离线渲染审计:固定场景在真实 OfflineAudioContext(Chrome)中渲染,
 * 用数值断言验证四件事:
 *   1. 距离增益包络与纯模型 inverseDistanceGain 一致(含近场恒 1、静音=0);
 *   2. 告警声源 schedule stop 后包络正确归零(循环启停语义);
 *   3. equalpower 下声源方位引起左右声道能量差(监听器朝向驱动的定位生效);
 *   4. 500 轮 build/dispose 无残留节点(dispose 语义在真实节点对象上成立)。
 *
 * 执行方式:scripts/gate-spatial-audio-offline.mjs 经 Vite dev server 的
 * /@fs/ 端点在真实 Chrome 中动态 import 本模块并调用 runOfflineAudioAudit
 * (参考 deep-gpu-stage-smoke.mjs 的既有模式);node 环境无 WebAudio,本模块
 * 不进 vitest,也不被生产 bundle 引用(仅 dev 审计入口)。
 */

import { synthesizeAlarmTonePcm } from "./alarmTone";
import { effectiveLinearVolume, inverseDistanceGain } from "./spatialAudioAttenuation";
import { buildSpatialGraph, disposeSpatialGraph, positionSpatialGraph } from "./spatialAudioGraph";

export interface OfflineAuditReport {
  schema: "deep-monkey.spatial-audio-offline-audit.v1";
  userAgent: string;
  sampleRate: number;
  tolerance: number;
  passed: boolean;
  failures: string[];
  distanceCases: Array<{ label: string; distance: number; expectedGain: number; measuredGain: number; relativeError: number; passed: boolean }>;
  muteCase: { expectedGain: number; measuredGain: number; passed: boolean };
  alarmEnvelope: { loudRms: number; afterStopRms: number; stopAtSeconds: number; passed: boolean };
  direction: { leftRms: number; rightRms: number; ratio: number; passed: boolean };
  leak: { cycles: number; residualGraphs: number; passed: boolean };
  notes: string[];
}

const TOLERANCE = 0.1;

export async function runOfflineAudioAudit(options: { leakCycles?: number } = {}): Promise<OfflineAuditReport> {
  const sampleRate = 44100;
  const failures: string[] = [];
  const notes: string[] = [];

  // 固定测试音:440 Hz 满幅正弦,RMS = sqrt(2)/2。
  const tone = createSineBuffer(sampleRate, 440, 0.25);

  const params = { volume: 1, muted: false, loop: false, refDistance: 2, maxDistance: 50, rolloffFactor: 1, panningModel: "equalpower" as const };
  const distanceCases: OfflineAuditReport["distanceCases"] = [];
  for (const label of ["ref(2m)", "2ref(4m)", "4ref(8m)", "inside-ref(1m)"]) {
    const distance = label.startsWith("ref(") ? 2 : label.startsWith("2ref") ? 4 : label.startsWith("4ref") ? 8 : 1;
    const expectedGain = inverseDistanceGain(params, distance);
    const measuredGain = await renderGraphGain(sampleRate, tone, params, distance);
    const relativeError = expectedGain > 0 ? Math.abs(measuredGain - expectedGain) / expectedGain : Math.abs(measuredGain);
    const passed = relativeError <= TOLERANCE;
    if (!passed) failures.push(`distance ${distance}m: expected ${expectedGain.toFixed(4)}, measured ${measuredGain.toFixed(4)}`);
    distanceCases.push({ label, distance, expectedGain, measuredGain, relativeError, passed });
  }

  const muteExpected = effectiveLinearVolume(0.9, true);
  const muteMeasured = await renderGraphGain(sampleRate, tone, { ...params, muted: true, volume: 0.9 }, 2);
  const mutePassed = muteMeasured < 1e-4;
  if (!mutePassed) failures.push(`mute: expected 0, measured ${muteMeasured}`);
  const muteCase = { expectedGain: muteExpected, measuredGain: muteMeasured, passed: mutePassed };

  // 告警启停:0s 播放,0.8s 计划停止;0.7s 前必须有声,0.9s 后必须静音。
  const alarmPcm = synthesizeAlarmTonePcm({ sampleRate, cycles: 4 });
  const alarmBuffer = createBufferFromPcm(sampleRate, alarmPcm.data);
  const alarmContext = new OfflineAudioContext(1, sampleRate * 2, sampleRate);
  const alarmGraph = buildSpatialGraph(alarmContext, alarmBuffer, { ...params, volume: 1 }, alarmContext.destination);
  alarmGraph.source?.start(0);
  alarmGraph.source?.stop(0.8);
  const alarmRendered = await alarmContext.startRendering();
  const loudRms = rmsOf(alarmRendered.getChannelData(0), 0, Math.floor(sampleRate * 0.7));
  const afterStopRms = rmsOf(alarmRendered.getChannelData(0), Math.floor(sampleRate * 0.9), alarmRendered.length);
  const alarmPassed = loudRms > 0.05 && afterStopRms < 0.002;
  if (!alarmPassed) failures.push(`alarm envelope: loudRms=${loudRms.toFixed(5)} afterStopRms=${afterStopRms.toFixed(6)}`);
  disposeSpatialGraph(alarmGraph);
  const alarmEnvelope = { loudRms, afterStopRms, stopAtSeconds: 0.8, passed: alarmPassed };

  // 方向性:声源在监听器左方(-X),左声道能量应显著大于右声道。
  const directionContext = new OfflineAudioContext(2, sampleRate * 0.25, sampleRate);
  const directionGraph = buildSpatialGraph(directionContext, tone, { ...params }, directionContext.destination);
  positionSpatialGraph(directionGraph, -5, 0, 0);
  directionGraph.source?.start(0);
  const directionRendered = await directionContext.startRendering();
  const leftRms = rmsOf(directionRendered.getChannelData(0), 0, directionRendered.length);
  const rightRms = rmsOf(directionRendered.getChannelData(1), 0, directionRendered.length);
  const ratio = rightRms > 0 ? leftRms / rightRms : Number.POSITIVE_INFINITY;
  const directionPassed = leftRms > rightRms * 1.2;
  if (!directionPassed) failures.push(`direction: leftRms=${leftRms.toFixed(5)} rightRms=${rightRms.toFixed(5)} ratio=${ratio.toFixed(3)}`);
  disposeSpatialGraph(directionGraph);
  const direction = { leftRms, rightRms, ratio: Number.isFinite(ratio) ? ratio : 999, passed: directionPassed };

  // 泄漏:真实节点对象上重复构造/释放;disposal 后图内引用必须为空。
  const leakCycles = options.leakCycles ?? 500;
  let residualGraphs = 0;
  try {
    const leakContext = new OfflineAudioContext(1, 128, sampleRate);
    for (let index = 0; index < leakCycles; index += 1) {
      const graph = buildSpatialGraph(leakContext, tone, { ...params }, leakContext.destination);
      disposeSpatialGraph(graph);
      if (graph.source !== null || graph.gain !== null || graph.panner !== null || !graph.disposed) residualGraphs += 1;
    }
  } catch (error) {
    failures.push(`leak loop threw: ${String(error)}`);
    residualGraphs += 1;
  }
  const leakPassed = residualGraphs === 0;
  if (!leakPassed) failures.push(`leak: ${residualGraphs} residual graphs over ${leakCycles} cycles`);
  const leak = { cycles: leakCycles, residualGraphs, passed: leakPassed };

  notes.push("监听器位姿/朝向驱动由生产侧 THREE.AudioListener(挂相机)承担;本审计用 OfflineAudioContext 默认监听器验证声源方位与距离语义。");
  notes.push("距离模型 = Web Audio 规范 inverse(与 PannerNode 同一条公式),断言容差 ±10%(equalpower 立体声合成能量误差 + 浮点)。");
  notes.push("泄漏断言覆盖 dispose 的引用清空与释放调用;GC 时序不可在页内断言,引擎侧 disposeSpatialAudioRuntime 的 stop+disconnect+removeFromParent 路径同构。");

  return {
    schema: "deep-monkey.spatial-audio-offline-audit.v1",
    userAgent: navigator.userAgent,
    sampleRate,
    tolerance: TOLERANCE,
    passed: failures.length === 0,
    failures,
    distanceCases,
    muteCase,
    alarmEnvelope,
    direction,
    leak,
    notes,
  };
}

async function renderGraphGain(
  sampleRate: number,
  tone: AudioBuffer,
  params: { volume: number; muted: boolean; loop: boolean; refDistance: number; maxDistance: number; rolloffFactor: number; panningModel?: PanningModelType },
  distance: number,
): Promise<number> {
  const context = new OfflineAudioContext(2, sampleRate * 0.25, sampleRate);
  const graph = buildSpatialGraph(context, tone, params, context.destination);
  positionSpatialGraph(graph, distance, 0, 0);
  graph.source?.start(0);
  const rendered = await context.startRendering();
  disposeSpatialGraph(graph);
  const left = rendered.getChannelData(0);
  const right = rendered.getChannelData(1);
  const sourceRms = Math.SQRT1_2; // 满幅正弦 RMS
  return Math.sqrt(left.reduce((sum, v) => sum + v * v, 0) + right.reduce((sum, v) => sum + v * v, 0)) / Math.sqrt(left.length) / sourceRms;
}

function createSineBuffer(sampleRate: number, hz: number, seconds: number): AudioBuffer {
  const context = new OfflineAudioContext(2, sampleRate * seconds, sampleRate);
  const buffer = context.createBuffer(1, sampleRate * seconds, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return buffer;
}

function createBufferFromPcm(sampleRate: number, pcm: Float32Array): AudioBuffer {
  const context = new OfflineAudioContext(1, 128, sampleRate);
  const buffer = context.createBuffer(1, pcm.length, sampleRate);
  buffer.copyToChannel(new Float32Array(pcm), 0);
  return buffer;
}

function rmsOf(data: Float32Array, from: number, to: number): number {
  let sum = 0;
  let count = 0;
  for (let i = Math.max(0, from); i < Math.min(data.length, to); i += 1) {
    const value = data[i] ?? 0;
    sum += value * value;
    count += 1;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}
