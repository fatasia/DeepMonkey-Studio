/** AA-M2 残影复测探针:①T07 fence 翻转口径 ②平移后静止(拒绝全盲)第二类型场景
 * ③temporalSequenceScenes 四序列 CPU 链。修复前后对比入口,与单测同式。 */
import { accumulateTemporalFrame, accumulateTemporalFrameDetailed, BASELINE_REPROJECTION_POLICY,
  GHOST_GUARD_REPROJECTION_POLICY, measureGhostSequence,
  type ReprojectionPolicy } from "../src/postprocess/temporalReprojection.js";
import { buildAllSequences } from "../src/postprocess/temporalSequenceScenes.js";

const width = 32, height = 8, pixels = width * height;
const options = { feedback: 0.9, depthThreshold: 0.1, relativeDepthThreshold: 0.02 } as const;
const jitter: readonly [number, number] = [0, 0];

const fence = (phase: number) => ({
  color: Array.from({ length: pixels * 4 }, (_, i) =>
    i % 4 === 3 ? 1 : ((((i / 4 | 0) % width) - 2 * phase) % 4 + 4) % 4 < 2 ? 1 : 0),
  depth: Array<number>(pixels).fill(4) });

const runFence = (policy: ReprojectionPolicy) => {
  const target = fence(0);
  let previousColor: number[] = fence(1).color, previousDepth: number[] = fence(1).depth;
  const resolved: Float32Array[] = [], ideal: number[][] = [];
  for (let frame = 0; frame < 3; frame++) {
    const out = accumulateTemporalFrame({ width, height, ...target, motion: Array<number>(pixels * 2).fill(0),
      previousColor, previousDepth, currentJitter: jitter, previousJitter: jitter, historyValid: true }, options, policy);
    resolved.push(out); ideal.push(target.color);
    previousColor = Array.from(out); previousDepth = target.depth;
  }
  return measureGhostSequence(resolved, ideal, 1);
};

// 第二类型:2px 细杆 4px/帧 平移 4 帧后静止;杆与背景同深度(深度拒绝全盲,
// 运动残迹只能靠钳制 + decay 压制)——"停后残影"的对抗口径。
const moveStopFrame = (barStart: number, shift: number) => {
  const inBar = (column: number) => column >= barStart && column < barStart + 2;
  const color = Array.from({ length: pixels * 4 }, (_, i) =>
    i % 4 === 3 ? 1 : inBar((i / 4 | 0) % width) ? 1 : 0);
  const depth = Array<number>(pixels).fill(12);
  const motion = Array.from({ length: pixels * 2 }, (_, i) =>
    i % 2 === 0 && inBar((i / 2 | 0) % width) ? shift / width : 0);
  return { color, depth, motion };
};

const runMoveStop = (policy: ReprojectionPolicy) => {
  const starts = [4, 8, 12, 16, 16, 16, 16];
  const resolved: Float32Array[] = [], ideal: number[][] = [];
  let previousColor: number[] | undefined, previousDepth: number[] | undefined;
  for (let frame = 0; frame < 7; frame++) {
    const current = moveStopFrame(starts[frame]!, frame < 4 ? 4 : 0);
    const out = accumulateTemporalFrame({ width, height, ...current,
      ...(previousColor !== undefined && previousDepth !== undefined ? { previousColor, previousDepth } : {}),
      currentJitter: jitter, previousJitter: jitter,
      historyValid: frame > 0 }, options, policy);
    resolved.push(out); ideal.push(current.color);
    previousColor = Array.from(out); previousDepth = current.depth;
  }
  return measureGhostSequence(resolved.slice(4), ideal.slice(4), 1);
};

const guarded = runFence(GHOST_GUARD_REPROJECTION_POLICY);
const baseline = runFence(BASELINE_REPROJECTION_POLICY);
console.log("[fence flip]  guard :", guarded.energies.map(v => (v * 100).toFixed(3) + "%").join(" / "));
console.log("[fence flip]  base :", baseline.energies.map(v => (v * 100).toFixed(3) + "%").join(" / "));
const gsGuard = runMoveStop(GHOST_GUARD_REPROJECTION_POLICY);
const gsBase = runMoveStop(BASELINE_REPROJECTION_POLICY);
console.log("[move+stop]   guard:", gsGuard.energies.map(v => (v * 100).toFixed(3) + "%").join(" / "));
console.log("[move+stop]   base :", gsBase.energies.map(v => (v * 100).toFixed(3) + "%").join(" / "));

// 四序列 CPU 链(与 T07 真机同源场景,小尺寸 CPU 复验):guard 修前后不回归检查。
const seqOptions = { feedback: 0.9, depthThreshold: 0.012, relativeDepthThreshold: 0.02 } as const;
for (const sequence of buildAllSequences(64, 64)) {
  const resolved: Float32Array[] = [], ideal: number[][] = [];
  let previousColor: Float32Array | undefined, previousDepth: Float32Array | undefined;
  sequence.frames.forEach((frame, index) => {
    const out = accumulateTemporalFrameDetailed({ width: sequence.width, height: sequence.height,
      color: Array.from(frame.color), depth: Array.from(frame.depth),
      motion: analyticMotionCpu(sequence, index), ...(index > 0 ? { previousColor: Array.from(previousColor!), previousDepth: Array.from(previousDepth!) } : {}),
      currentJitter: [0, 0], previousJitter: [0, 0], historyValid: index > 0 }, seqOptions, GHOST_GUARD_REPROJECTION_POLICY).output;
    resolved.push(out); ideal.push(Array.from(frame.color));
    previousColor = out; previousDepth = frame.depth;
  });
  const report = measureGhostSequence(resolved.slice(sequence.moveFrames), ideal.slice(sequence.moveFrames), sequence.sourceContrast);
  console.log(`[seq ${sequence.name.padEnd(17)}] guard:`, report.energies.map(v => v.toFixed(4)).join(" / "));
}

/** 解析 MV(与 temporalMotionReference 同式:世界点经 previousVP/currentVP 投影差)。 */
function analyticMotionCpu(sequence: ReturnType<typeof buildAllSequences>[number], index: number): number[] {
  const frame = sequence.frames[index]!;
  const motion = new Array<number>(sequence.width * sequence.height * 2).fill(0);
  const w = sequence.width, h = sequence.height;
  for (let pixel = 0; pixel < w * h; pixel++) {
    const objectId = frame.world[pixel * 4 + 3]!;
    const point = [frame.world[pixel * 4]!, frame.world[pixel * 4 + 1]!, frame.world[pixel * 4 + 2]!, 1];
    const project = (m: ArrayLike<number>): [number, number] => {
      const x = m[0]! * point[0]! + m[4]! * point[1]! + m[8]! * point[2]! + m[12]! * point[3]!;
      const y = m[1]! * point[0]! + m[5]! * point[1]! + m[9]! * point[2]! + m[13]! * point[3]!;
      const zw = m[3]! * point[0]! + m[7]! * point[1]! + m[11]! * point[2]! + m[15]! * point[3]!;
      return [(x / zw * 0.5 + 0.5) * w, (0.5 - y / zw * 0.5) * h];
    };
    const current = project(frame.viewProjection);
    const rows = objectId >= 1 ? frame.relativeRows[objectId - 1]! : [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] as const;
    const previousModel = [rows[0]![0]!, rows[0]![1]!, rows[0]![2]!, rows[0]![3]!,
      rows[1]![0]!, rows[1]![1]!, rows[1]![2]!, rows[1]![3]!,
      rows[2]![0]!, rows[2]![1]!, rows[2]![2]!, rows[2]![3]!, 0, 0, 0, 1] as ArrayLike<number>;
    const worldPrev = [
      previousModel[0]! * point[0]! + previousModel[4]! * point[1]! + previousModel[8]! * point[2]! + previousModel[12]! * point[3]!,
      previousModel[1]! * point[0]! + previousModel[5]! * point[1]! + previousModel[9]! * point[2]! + previousModel[13]! * point[3]!,
      previousModel[2]! * point[0]! + previousModel[6]! * point[1]! + previousModel[10]! * point[2]! + previousModel[14]! * point[3]!, 1];
    const previous = project(frame.previousViewProjection);
    void worldPrev;
    motion[pixel * 2] = (previous[0] - current[0]) / w;
    motion[pixel * 2 + 1] = (previous[1] - current[1]) / h;
  }
  return motion;
}
