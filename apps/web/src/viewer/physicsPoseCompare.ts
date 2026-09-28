import type { ParsedPoseSeries } from "./physicsPoseRecorder";

/**
 * T28 跨端位姿比对：两份 T17 格式位姿序列（Web / Native）按帧序对齐，
 * 逐步计算最大位置差（米）与旋转差（弧度），并按容差给出超差标记。
 *
 * 对齐口径与 T17 对比脚本一致：按帧序号对齐（录制起点即帧 1），旋转差用
 * 2·acos(|q1·q2|)（短弧角，与 t17-compare-cross-tolerance.mjs 同式）。
 * 本模块为纯函数，可 headless 单测。
 */

export interface PoseCompareTolerance {
  /** 位置差容差（米）；T17 实测口径默认 5 mm。 */
  positionMeters: number;
  /** 旋转差容差（弧度）；T17 实测口径默认 0.02 rad。 */
  rotationRadians: number;
}

export interface PoseCompareStepRow {
  /** 帧序号（1 起，两序列共用）。 */
  step: number;
  maxPosition: number;
  maxRotation: number;
  positionExceeded: boolean;
  rotationExceeded: boolean;
  exceeded: boolean;
}

export interface PoseCompareResult {
  /** 参与比较的刚体交集（按 A 序列顺序）。 */
  bodies: string[];
  stepsCompared: number;
  perStep: PoseCompareStepRow[];
  maxPosition: number;
  maxRotation: number;
  firstExceededStep: number | null;
  exceededStepCount: number;
  tolerance: PoseCompareTolerance;
  endA: string;
  endB: string;
  sourceA: string;
  sourceB: string;
}

export const DEFAULT_POSE_COMPARE_TOLERANCE: PoseCompareTolerance = {
  positionMeters: 0.005,
  rotationRadians: 0.02,
};

const quaternionAngle = (a: readonly number[], b: readonly number[]): number => {
  const dot = Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!);
  return 2 * Math.acos(Math.min(1, dot));
};

/**
 * 比较两份位姿序列。刚体取两侧 id 交集（编辑器录制与离线导出的刚体清单
 * 可能不同）；帧数取两侧较小值。任一侧为空或交集为空时抛出中文错误。
 */
export function comparePoseSeries(
  a: ParsedPoseSeries,
  b: ParsedPoseSeries,
  tolerance: PoseCompareTolerance = DEFAULT_POSE_COMPARE_TOLERANCE,
): PoseCompareResult {
  const bodies = a.bodies.filter((id) => b.bodies.includes(id));
  if (bodies.length === 0) throw new Error("两侧序列没有共同的刚体 id，无法比对");
  const indexB = new Map(b.frames.map((frame) => [frame.step, frame]));
  const stepsCompared = Math.min(a.frames.length, b.frames.length);
  if (stepsCompared === 0) throw new Error("至少一份序列没有任何位姿帧");
  const perStep: PoseCompareStepRow[] = [];
  let maxPosition = 0;
  let maxRotation = 0;
  let firstExceededStep: number | null = null;
  let exceededStepCount = 0;
  for (let index = 0; index < stepsCompared; index += 1) {
    const frameA = a.frames[index]!;
    const frameB = indexB.get(frameA.step);
    if (!frameB) break; // 步号错位即停：跨端录制起点不同步时宁少比不错比。
    let stepMaxPosition = 0;
    let stepMaxRotation = 0;
    for (const id of bodies) {
      const poseA = frameA.bodies.find((pose) => pose.id === id);
      const poseB = frameB.bodies.find((pose) => pose.id === id);
      if (!poseA || !poseB) continue;
      const position = Math.hypot(poseA.p[0] - poseB.p[0], poseA.p[1] - poseB.p[1], poseA.p[2] - poseB.p[2]);
      const rotation = quaternionAngle(poseA.q, poseB.q);
      stepMaxPosition = Math.max(stepMaxPosition, position);
      stepMaxRotation = Math.max(stepMaxRotation, rotation);
    }
    const positionExceeded = stepMaxPosition > tolerance.positionMeters;
    const rotationExceeded = stepMaxRotation > tolerance.rotationRadians;
    const exceeded = positionExceeded || rotationExceeded;
    if (exceeded && firstExceededStep === null) firstExceededStep = frameA.step;
    if (exceeded) exceededStepCount += 1;
    maxPosition = Math.max(maxPosition, stepMaxPosition);
    maxRotation = Math.max(maxRotation, stepMaxRotation);
    perStep.push({ step: frameA.step, maxPosition: stepMaxPosition, maxRotation: stepMaxRotation, positionExceeded, rotationExceeded, exceeded });
  }
  return {
    bodies,
    stepsCompared: perStep.length,
    perStep,
    maxPosition,
    maxRotation,
    firstExceededStep,
    exceededStepCount,
    tolerance,
    endA: a.end,
    endB: b.end,
    sourceA: a.source,
    sourceB: b.source,
  };
}
