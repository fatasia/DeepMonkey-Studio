/**
 * T28 物理可视化调试器：固定步长刚体位姿环形录制器与 T17 位姿 JSON 编解码。
 *
 * 导出/导入格式对齐 T17 跨端配对数据（`apps/web/scripts/t17-compare-cross-tolerance.mjs`
 * 直接消费）：`{ meta: { ..., steps, boxes }, poses: [[{ p: [x,y,z], q: [x,y,z,w] }]] }`，
 * 其中 `poses[step][boxIndex]` 与 `meta.boxes[boxIndex]` 按下标对应。本模块是纯数据
 * 结构，不触碰引擎与渲染器，可 headless 单测。
 */

export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];

/** 单个刚体在某个固定步的世界位姿（米 / 单位四元数 xyzw）。 */
export interface RecordedBodyPose {
  readonly id: string;
  readonly p: Vec3Tuple;
  readonly q: QuatTuple;
}

/** 一个固定步的位姿帧；`step` 为引擎侧单调递增的固定步计数。 */
export interface PhysicsPoseFrame {
  readonly step: number;
  readonly bodies: readonly RecordedBodyPose[];
}

/** T17 位姿 JSON 的 meta 区（steps/boxes 为格式必需，其余自由扩展）。 */
export interface PhysicsPoseJsonMeta {
  readonly end?: string;
  readonly scenario?: string;
  readonly fixedStepSeconds?: number;
  readonly steps?: number;
  readonly boxes?: readonly string[];
  readonly [key: string]: unknown;
}

/** T17 格式位姿 JSON（导出物，可直接喂给 t17-compare-cross-tolerance.mjs）。 */
export interface PhysicsPoseJson {
  readonly meta: PhysicsPoseJsonMeta;
  readonly poses: readonly (readonly { p: Vec3Tuple; q: QuatTuple }[])[];
}

/** 导入解析后的位姿序列（比较视图的消费形态）。 */
export interface ParsedPoseSeries {
  /** 来源标注：meta.end 优先，缺失时为 "unknown"。 */
  readonly end: string;
  readonly steps: number;
  readonly bodies: readonly string[];
  readonly fixedStepSeconds: number | undefined;
  /** 帧按录制顺序排列，帧序号（比较视图的“帧 N”）= 数组下标 + 1。 */
  readonly frames: readonly PhysicsPoseFrame[];
  /** 文件名或来源说明，用于 UI 槽位展示。 */
  readonly source: string;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isVec3 = (value: unknown): value is Vec3Tuple =>
  Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);

const isQuat = (value: unknown): value is QuatTuple =>
  Array.isArray(value) && value.length === 4 && value.every(isFiniteNumber);

/** 环形缓冲位姿录制器：容量按固定步数计（默认 600 步 = 1/60 s × 600 ≈ 10 s）。 */
export class PhysicsPoseRecorder {
  private frames: PhysicsPoseFrame[] = [];
  private head = 0;

  constructor(readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity < 1) throw new Error("录制容量必须为正整数步数");
  }

  /** 当前缓冲内的帧数（超过容量后恒等于容量）。 */
  get size(): number {
    return this.frames.length - this.head;
  }

  /** 录入一帧；超出容量时丢弃最早帧（环形语义），帧数据深拷贝防外部改写。 */
  recordFrame(frame: PhysicsPoseFrame): void {
    this.frames.push({
      step: frame.step,
      bodies: frame.bodies.map((pose) => ({ id: pose.id, p: [...pose.p] as Vec3Tuple, q: [...pose.q] as QuatTuple })),
    });
    if (this.size > this.capacity) this.head += 1;
    // 惰性收缩：头指针走过一半时整理一次，避免长时间录制下数组无限增长。
    if (this.head > 512 && this.head * 2 > this.frames.length) {
      this.frames = this.frames.slice(this.head);
      this.head = 0;
    }
  }

  /** 按录制顺序（最早 → 最新）取出全部缓冲帧。 */
  framesAscending(): readonly PhysicsPoseFrame[] {
    return this.frames.slice(this.head);
  }

  /**
   * 导出为 T17 跨端配对 JSON。`boxes` 取最早一帧的刚体清单；个别帧缺少
   * 某刚体时该格填首帧位姿占位（编辑器录制中途增删刚体是边界场景，
   * 跨端比较按交集对齐，见 physicsPoseCompare）。
   */
  toPoseJson(meta: PhysicsPoseJsonMeta): PhysicsPoseJson {
    const ordered = this.framesAscending();
    if (ordered.length === 0) throw new Error("没有已录制的位姿帧");
    const boxes = ordered[0]!.bodies.map((pose) => pose.id);
    const poses = ordered.map((frame) => boxes.map((id) => {
      const pose = frame.bodies.find((entry) => entry.id === id) ?? frame.bodies[0]!;
      return { p: [...pose.p] as Vec3Tuple, q: [...pose.q] as QuatTuple };
    }));
    return {
      meta: { ...meta, steps: ordered.length, boxes },
      poses,
    };
  }
}

/**
 * 解析 T17 格式位姿 JSON 文本；结构不合法时抛出带中文原因的 Error，
 * 由调用方（比对视图）呈现为可操作的错误态。
 */
export function parsePhysicsPoseJson(text: string, source: string): ParsedPoseSeries {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`JSON 解析失败：${source} 不是合法 JSON`);
  }
  if (typeof payload !== "object" || payload === null) throw new Error(`${source} 缺少 JSON 根对象`);
  const { meta, poses } = payload as { meta?: unknown; poses?: unknown };
  if (typeof meta !== "object" || meta === null) throw new Error(`${source} 缺少 meta 区`);
  if (!Array.isArray(poses) || poses.length === 0) throw new Error(`${source} 的 poses 区为空或缺失`);
  const firstMeta = meta as { boxes?: unknown; end?: unknown; fixedStepSeconds?: unknown };
  if (!Array.isArray(firstMeta.boxes) || firstMeta.boxes.length === 0 || !firstMeta.boxes.every((box) => typeof box === "string")) {
    throw new Error(`${source} 的 meta.boxes 必须为非空字符串数组`);
  }
  const bodies = firstMeta.boxes as string[];
  const frames = poses.map((stepPoses, index) => {
    if (!Array.isArray(stepPoses) || stepPoses.length !== bodies.length) {
      throw new Error(`${source} 第 ${index + 1} 步的位姿数量与 meta.boxes 不一致`);
    }
    const bodiesOut = stepPoses.map((pose, boxIndex) => {
      if (typeof pose !== "object" || pose === null) throw new Error(`${source} 第 ${index + 1} 步第 ${boxIndex + 1} 个位姿不是对象`);
      const { p, q } = pose as { p?: unknown; q?: unknown };
      if (!isVec3(p) || !isQuat(q)) throw new Error(`${source} 第 ${index + 1} 步第 ${boxIndex + 1} 个位姿的 p/q 数组非法`);
      return { id: bodies[boxIndex]!, p, q } satisfies RecordedBodyPose;
    });
    return { step: index + 1, bodies: bodiesOut } satisfies PhysicsPoseFrame;
  });
  return {
    end: typeof firstMeta.end === "string" ? firstMeta.end : "unknown",
    steps: frames.length,
    bodies,
    fixedStepSeconds: typeof firstMeta.fixedStepSeconds === "number" ? firstMeta.fixedStepSeconds : undefined,
    frames,
    source,
  };
}
