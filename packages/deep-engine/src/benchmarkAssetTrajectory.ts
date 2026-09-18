/** DE26/A02 · 基准交互轨迹合同 v1:确定性相机飞行 + 选择/剖切序列,时间戳+动作+参数可回放。
 *  坐标在 asset-bounding-sphere 归一化系(中心=资产包围球中心,1=包围球半径),
 *  同一条轨迹可跨资产复用;落回世界坐标由 manifest stats.bounds 在回放侧完成。
 *  回放是纯函数:同一 elapsed 输入永远得到同一姿态与动作窗口,禁止时钟/随机参与。 */

export const BENCHMARK_TRAJECTORY_SCHEMA_VERSION = 1 as const;

export type TrajectoryEasing = "linear" | "ease-in-out";

export interface TrajectoryCameraKey {
  /** 相对轨迹起点的毫秒;keyframes 必须按 timeMs 非降序且落在 [0, durationMs]。 */
  readonly timeMs: number;
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  /** 缺省 48;与 render-engine 基准既有相机视场一致。 */
  readonly fovDeg?: number;
  /** 本 keyframe 与前一 keyframe 之间段的缓动;首段忽略。缺省 linear。 */
  readonly easing?: TrajectoryEasing;
}

/** select 的 target 是资产内稳定节点名(GLB node name);input 是输入延迟采样的合成锚点。 */
export type TrajectoryAction =
  | { readonly kind: "select"; readonly timeMs: number; readonly target: string }
  | { readonly kind: "clear-selection"; readonly timeMs: number }
  | { readonly kind: "clip"; readonly timeMs: number; readonly axis: "x" | "y" | "z"; readonly position: number; readonly direction: 1 | -1; readonly enabled: boolean }
  | { readonly kind: "input"; readonly timeMs: number; readonly inputId: string };

export interface BenchmarkTrajectory {
  readonly schema: "deep-engine.benchmark-trajectory";
  readonly schemaVersion: typeof BENCHMARK_TRAJECTORY_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly durationMs: number;
  readonly frame: "asset-bounding-sphere";
  readonly cameraKeys: readonly TrajectoryCameraKey[];
  /** 必须按 timeMs 非降序;同一时刻的动作按数组顺序派发。 */
  readonly actions: readonly TrajectoryAction[];
}

export interface TrajectoryValidationIssue {
  readonly field: string;
  readonly message: string;
}

const TRAJECTORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const EASINGS = new Set<TrajectoryEasing>(["linear", "ease-in-out"]);
const CLIP_AXES = new Set(["x", "y", "z"]);
/** 与 render-engine 基准 createCamera(48°) 对齐的可再现视场范围。 */
const FOV_MIN_DEG = 1;
const FOV_MAX_DEG = 170;

function isVector3(value: unknown): value is readonly [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(component => typeof component === "number" && Number.isFinite(component));
}

export function validateBenchmarkTrajectory(trajectory: BenchmarkTrajectory): readonly TrajectoryValidationIssue[] {
  const issues: TrajectoryValidationIssue[] = [];
  const fail = (field: string, message: string) => issues.push({ field, message });
  if (trajectory.schema !== "deep-engine.benchmark-trajectory" || trajectory.schemaVersion !== BENCHMARK_TRAJECTORY_SCHEMA_VERSION) {
    fail("schema", "schema identity mismatch");
    return issues;
  }
  if (!TRAJECTORY_ID.test(trajectory.id)) fail("id", "trajectory id is invalid");
  if (!trajectory.name.trim()) fail("name", "name is empty");
  if (!Number.isFinite(trajectory.durationMs) || trajectory.durationMs <= 0) fail("durationMs", "duration must be a positive finite number");
  if (trajectory.frame !== "asset-bounding-sphere") fail("frame", "frame must be asset-bounding-sphere");
  trajectory.cameraKeys.forEach((key, index) => {
    if (!Number.isFinite(key.timeMs) || key.timeMs < 0 || key.timeMs > trajectory.durationMs) {
      fail(`cameraKeys[${index}].timeMs`, "camera key time must be within [0, durationMs]");
    }
    if (index > 0 && key.timeMs < trajectory.cameraKeys[index - 1]!.timeMs) {
      fail(`cameraKeys[${index}].timeMs`, "camera keys must be non-decreasing in time");
    }
    if (!isVector3(key.position)) fail(`cameraKeys[${index}].position`, "position must be a finite [x, y, z]");
    if (!isVector3(key.target)) fail(`cameraKeys[${index}].target`, "target must be a finite [x, y, z]");
    if (key.fovDeg !== undefined && (!Number.isFinite(key.fovDeg) || key.fovDeg < FOV_MIN_DEG || key.fovDeg > FOV_MAX_DEG)) {
      fail(`cameraKeys[${index}].fovDeg`, `fov must be within [${FOV_MIN_DEG}, ${FOV_MAX_DEG}] degrees`);
    }
    if (key.easing !== undefined && !EASINGS.has(key.easing)) fail(`cameraKeys[${index}].easing`, "easing is not a frozen easing name");
  });
  if (!trajectory.cameraKeys.length) fail("cameraKeys", "at least one camera key is required");
  trajectory.actions.forEach((action, index) => {
    if (!Number.isFinite(action.timeMs) || action.timeMs < 0 || action.timeMs > trajectory.durationMs) {
      fail(`actions[${index}].timeMs`, "action time must be within [0, durationMs]");
    }
    if (index > 0 && action.timeMs < trajectory.actions[index - 1]!.timeMs) {
      fail(`actions[${index}].timeMs`, "actions must be non-decreasing in time");
    }
    if (action.kind === "select" && !action.target.trim()) fail(`actions[${index}].target`, "select target must be a non-empty node name");
    if (action.kind === "clip" && !CLIP_AXES.has(action.axis)) fail(`actions[${index}].axis`, "clip axis must be x, y or z");
    if (action.kind === "clip" && !Number.isFinite(action.position)) fail(`actions[${index}].position`, "clip position must be finite");
    if (action.kind === "input" && !action.inputId.trim()) fail(`actions[${index}].inputId`, "input id must be non-empty");
  });
  return issues;
}

export function createBenchmarkTrajectory(trajectory: BenchmarkTrajectory): BenchmarkTrajectory {
  const issues = validateBenchmarkTrajectory(trajectory);
  if (issues.length) throw new Error(`invalid benchmark trajectory ${trajectory.id}: ${issues.map(issue => `${issue.field}: ${issue.message}`).join("; ")}`);
  return trajectory;
}

export interface TrajectoryCameraPose {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly fovDeg: number;
}

/** smoothstep:与 CSS ease-in-up/down 家族一致的确定性 S 曲线,二阶导在两端为零。 */
function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}

function applyEasing(name: TrajectoryEasing | undefined, t: number): number {
  if (name === "ease-in-out") return easeInOut(t);
  return t;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 采样 elapsedMs 的相机姿态;越界钳位到首/尾 keyframe(不外推,保证窗口外回放稳定)。 */
export function sampleTrajectoryPose(trajectory: BenchmarkTrajectory, elapsedMs: number): TrajectoryCameraPose {
  const keys = trajectory.cameraKeys;
  if (!keys.length) throw new Error(`cannot sample trajectory ${trajectory.id}: no camera keys; run validateBenchmarkTrajectory first`);
  const clamped = Math.min(Math.max(elapsedMs, 0), trajectory.durationMs);
  if (clamped <= keys[0]!.timeMs) {
    const first = keys[0]!;
    return { position: first.position, target: first.target, fovDeg: first.fovDeg ?? 48 };
  }
  let segment = 0;
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index]!.timeMs <= clamped) segment = index;
  }
  const from = keys[segment]!;
  const to = keys[Math.min(segment + 1, keys.length - 1)]!;
  if (to === from) {
    return { position: from.position, target: from.target, fovDeg: from.fovDeg ?? 48 };
  }
  const raw = (clamped - from.timeMs) / (to.timeMs - from.timeMs);
  const t = applyEasing(to.easing, raw);
  const mix = (axis: 0 | 1 | 2, select: (key: TrajectoryCameraKey) => readonly [number, number, number]) =>
    lerp(select(from)[axis]!, select(to)[axis]!, t);
  return {
    position: [mix(0, key => key.position), mix(1, key => key.position), mix(2, key => key.position)],
    target: [mix(0, key => key.target), mix(1, key => key.target), mix(2, key => key.target)],
    fovDeg: lerp(from.fovDeg ?? 48, to.fovDeg ?? 48, t),
  };
}

/** 返回 [fromMs, toMs) 内应派发的动作;窗口互斥且并集穷尽,重复回放不重不漏。 */
export function trajectoryActionsInWindow(trajectory: BenchmarkTrajectory, fromMs: number, toMs: number): readonly TrajectoryAction[] {
  return trajectory.actions.filter(action => action.timeMs >= fromMs && action.timeMs < toMs);
}
