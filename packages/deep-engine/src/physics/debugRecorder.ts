/**
 * Brief-PhysDbg 确定性物理调试录制器(引擎侧,产品级;2026-10-03)。
 *
 * 与 T28 app 层录制器(`apps/web/src/viewer/physicsPoseRecorder.ts`,JS 对象环形
 * 缓冲,T17 JSON 合同)互补:T28 面向编辑器 UI,本模块面向**确定性跨端取证**——
 * 由 FixedStepClock 驱动、每 tick 一次 `record()`,全部状态预分配在 TypedArray
 * ring buffer 里(热路径零堆分配),位姿/接触/约束脉冲统一 **f32 量化**存储,
 * 并对每 tick 的位姿块计算 FNV-1a 双车道哈希、链式混入整段录制链哈希。
 * Web(TS)与 native(Rust,`physics_debug_compare.rs`)按同一合同逐位对拍;
 * 差异 >1e-3 的 tick 由 `comparePhysicsDebugRecordingTicks` 精确定位。
 *
 * 确定性合同(与 physicsTypes.ts 同源):
 * - 全部数值量化为 IEEE-754 f32(小端字节序参与哈希);跨端逐位一致的域是
 *   "同一位模式的 f32 流",对拍双方只比较 f32 位模式与哈希,不比较 f64 舍入;
 * - 固定通道布局(见各 STRIDE 常量注释),刚体顺序由调用方固定(按 id 字典序,
 *   与 T17 跨端配对口径一致);
 * - 不存在 Math.random / Date / 全局可变状态。
 *
 * 零分配纪律:record() 热路径只做下标写入与哈希滚动,唯一的跨调用复用临时量
 * 是 4 字节 DataView;mark() 停靠在 bounded 数组(mark 是人工低频操作)。
 *
 * 3D debugView 挂载点(后续接线,本任务交付数据合同):接触点=青/穿透=红/
 * 约束力=黄,见 PHYSICS_DEBUG_SEMANTIC_COLORS;挂载在
 * apps/web/src/viewer/rapierPhysicsDebugOverlay 同族的覆盖层(本任务该目录禁改,
 * 布局合同先行钉死,避免后续接线时合同漂移)。
 */

export const PHYSICS_DEBUG_RECORDING_SCHEMA = "deep-engine.physics-debug-recording";
export const PHYSICS_DEBUG_RECORDING_SCHEMA_VERSION = 1;

/** 位姿通道步长:px,py,pz,qx,qy,qz,qw(f32×7)。 */
export const PHYSICS_DEBUG_POSE_STRIDE = 7;
/** 接触通道步长:bodyA,bodyB(整数值 f32,≤2^24 精确),px,py,pz,penetration,nx,ny,nz(f32×9)。 */
export const PHYSICS_DEBUG_CONTACT_STRIDE = 9;
/** 关节脉冲通道步长:jointIndex(整数值 f32),impulseX,impulseY,impulseZ(f32×4)。 */
export const PHYSICS_DEBUG_JOINT_STRIDE = 4;

/** 默认字节预算:60s@60Hz × 默认通道容量 ≈ 12MiB(任务书口径)。 */
export const PHYSICS_DEBUG_DEFAULT_BYTE_BUDGET = 12 * 1024 * 1024;
export const PHYSICS_DEBUG_DEFAULT_MAX_BODIES = 96;
export const PHYSICS_DEBUG_DEFAULT_MAX_CONTACTS_PER_TICK = 16;
export const PHYSICS_DEBUG_DEFAULT_MAX_JOINTS_PER_TICK = 8;
/** mark 上限:人工打标是低频操作,超限拒绝并返回 undefined。 */
export const PHYSICS_DEBUG_MAX_MARKS = 64;

/**
 * 通道语义色(0xRRGGBB,与 base.css 深浅主题语义同源:青=info 族、红=danger、
 * 黄=warning)。3D 覆盖层与时间线泳道共用这组常量,禁止在消费端另配色。
 */
export const PHYSICS_DEBUG_SEMANTIC_COLORS = {
  /** 接触点:青。 */
  contact: 0x4dd0e1,
  /** 穿透深度:红。 */
  penetration: 0xe27478,
  /** 关节约束脉冲:黄。 */
  constraint: 0xd8ac52,
} as const;

export interface PhysicsDebugRecorderConfig {
  /**
   * 字节预算(全部 TypedArray 合计上限)。tick 容量 = floor(budget / 每 tick 字节数),
   * 派生值不少于 1。默认 12MiB ≈ 60s@60Hz(默认通道容量下 3683 tick ≈ 61.4s)。
   */
  readonly byteBudget?: number;
  /** 显式 tick 容量;给出时优先于 byteBudget 推导(仍受预算不限制约——显式容量即合同)。 */
  readonly tickCapacity?: number;
  readonly maxBodies?: number;
  readonly maxContactsPerTick?: number;
  readonly maxJointsPerTick?: number;
}

export interface PhysicsDebugRecorderEstimate {
  readonly tickCapacity: number;
  readonly maxBodies: number;
  readonly maxContactsPerTick: number;
  readonly maxJointsPerTick: number;
  /** 每 tick 全通道字节数(含 tick 头:tick 号 8B + 计数 3×4B + 双车道哈希 8B)。 */
  readonly perTickBytes: number;
  readonly totalBytes: number;
  readonly channelBytes: { readonly pose: number; readonly contact: number; readonly joint: number; readonly headers: number };
}

const TICK_HEADER_BYTES = 8 + 3 * 4 + 8;

export function estimatePhysicsDebugRecorderBytes(config: PhysicsDebugRecorderConfig = {}): PhysicsDebugRecorderEstimate {
  const maxBodies = config.maxBodies ?? PHYSICS_DEBUG_DEFAULT_MAX_BODIES;
  const maxContacts = config.maxContactsPerTick ?? PHYSICS_DEBUG_DEFAULT_MAX_CONTACTS_PER_TICK;
  const maxJoints = config.maxJointsPerTick ?? PHYSICS_DEBUG_DEFAULT_MAX_JOINTS_PER_TICK;
  const byteBudget = config.byteBudget ?? PHYSICS_DEBUG_DEFAULT_BYTE_BUDGET;
  if (!Number.isSafeInteger(maxBodies) || maxBodies < 1) throw new Error(`PhysicsDebugRecorder: maxBodies must be a positive integer, got ${maxBodies}.`);
  if (!Number.isSafeInteger(maxContacts) || maxContacts < 0) throw new Error(`PhysicsDebugRecorder: maxContactsPerTick must be a non-negative integer, got ${maxContacts}.`);
  if (!Number.isSafeInteger(maxJoints) || maxJoints < 0) throw new Error(`PhysicsDebugRecorder: maxJointsPerTick must be a non-negative integer, got ${maxJoints}.`);
  if (!Number.isFinite(byteBudget) || byteBudget <= 0) throw new Error(`PhysicsDebugRecorder: byteBudget must be positive, got ${byteBudget}.`);
  const channelBytes = {
    pose: maxBodies * PHYSICS_DEBUG_POSE_STRIDE * 4,
    contact: maxContacts * PHYSICS_DEBUG_CONTACT_STRIDE * 4,
    joint: maxJoints * PHYSICS_DEBUG_JOINT_STRIDE * 4,
    headers: TICK_HEADER_BYTES,
  };
  const perTickBytes = channelBytes.pose + channelBytes.contact + channelBytes.joint + channelBytes.headers;
  const tickCapacity = config.tickCapacity ?? Math.max(1, Math.floor(byteBudget / perTickBytes));
  if (config.tickCapacity !== undefined && (!Number.isSafeInteger(config.tickCapacity) || config.tickCapacity < 1)) {
    throw new Error(`PhysicsDebugRecorder: tickCapacity must be a positive integer, got ${config.tickCapacity}.`);
  }
  return { tickCapacity, maxBodies, maxContactsPerTick: maxContacts, maxJointsPerTick: maxJoints, perTickBytes, totalBytes: perTickBytes * tickCapacity, channelBytes };
}

/** 单 tick 录入载荷。poses 长度必须 = bodyCount×7;接触/关节同型(f64 入,f32 量化存)。 */
export interface PhysicsDebugRecorderTickInput {
  /** 引擎权威 tick 计数(来自 FixedStepClock);必须相对上次 +1,断档按丢 tick 记账。 */
  readonly tick: number;
  readonly poses: ArrayLike<number>;
  readonly bodyCount: number;
  readonly contacts?: ArrayLike<number>;
  readonly contactCount?: number;
  readonly joints?: ArrayLike<number>;
  readonly jointCount?: number;
}

export interface PhysicsDebugRecordOutcome {
  readonly accepted: boolean;
  /** 接受时的写入槽(0..tickCapacity);拒绝时为 -1。 */
  readonly slot: number;
  readonly reason?: "not-recording" | "body-overflow" | "non-finite";
}

export interface PhysicsDebugMark {
  readonly tick: number;
  readonly label: string;
  /** 录制内的序号(0 起,与缓冲槽无关),跨端对拍按它对齐。 */
  readonly ordinal: number;
}

/** 录制只读快照中的一 tick(分配态,供比对/序列化;不在热路径)。 */
export interface PhysicsDebugTickSnapshot {
  readonly tick: number;
  readonly hash: string;
  readonly poses: Float32Array;
  readonly bodyCount: number;
  readonly contacts: Float32Array;
  readonly contactCount: number;
  readonly joints: Float32Array;
  readonly jointCount: number;
}

/**
 * FNV-1a 双车道(f32 小端字节序;正序/反序各一条 32 位链),与
 * fingerprintFloat64 同族但作用于 f32 位模式。跨端合同:Rust 侧
 * `physics_debug_compare.rs` 逐字节同构。
 */
export function fingerprintFloat32(values: ArrayLike<number>): string {
  const scratch = new DataView(new ArrayBuffer(4));
  let forward = 0x811c9dc5;
  let backward = 0x811c9dc5;
  for (let i = 0; i < values.length; i += 1) {
    scratch.setFloat32(0, Math.fround(values[i]!), true);
    for (let b = 0; b < 4; b += 1) {
      const head = scratch.getUint8(b);
      const tail = scratch.getUint8(3 - b);
      forward = Math.imul(forward ^ head, 0x01000193);
      backward = Math.imul(backward ^ tail, 0x01000193);
    }
  }
  const hex = (v: number) => (v >>> 0).toString(16).padStart(8, "0");
  return hex(forward) + hex(backward);
}

/** 链哈希推进(双车道):chain = chain ⊕ tickHash,再过一遍 FNV 素数。 */
function chainMix(chain: number, tickHash: number): number {
  return Math.imul((chain ^ tickHash) >>> 0, 0x01000193) >>> 0;
}

const hex8 = (v: number): string => (v >>> 0).toString(16).padStart(8, "0");

export class PhysicsDebugRecorder {
  readonly #capacity: number;
  readonly #maxBodies: number;
  readonly #maxContacts: number;
  readonly #maxJoints: number;
  // ring 通道(预分配,record() 热路径零分配)。
  readonly #poses: Float32Array;
  readonly #contacts: Float32Array;
  readonly #joints: Float32Array;
  readonly #slotTicks: Float64Array;
  readonly #slotBodyCounts: Uint32Array;
  readonly #slotContactCounts: Uint32Array;
  readonly #slotJointCounts: Uint32Array;
  readonly #slotHashForward: Uint32Array;
  readonly #slotHashBackward: Uint32Array;
  readonly #hashScratch = new DataView(new ArrayBuffer(4));
  // 会话状态。
  #recording = false;
  #writeSlot = 0;
  #filled = 0;
  #startedTick: number | undefined;
  #lastTick: number | undefined;
  #totalAccepted = 0;
  #lostGaps = 0;
  #lostTicks = 0;
  #droppedTicks = 0;
  #truncatedContacts = 0;
  #truncatedJoints = 0;
  #chainForward = 0x811c9dc5;
  #chainBackward = 0x811c9dc5;
  #marks: PhysicsDebugMark[] = [];

  constructor(config: PhysicsDebugRecorderConfig = {}) {
    const estimate = estimatePhysicsDebugRecorderBytes(config);
    this.#capacity = estimate.tickCapacity;
    this.#maxBodies = estimate.maxBodies;
    this.#maxContacts = estimate.maxContactsPerTick;
    this.#maxJoints = estimate.maxJointsPerTick;
    this.#poses = new Float32Array(this.#capacity * this.#maxBodies * PHYSICS_DEBUG_POSE_STRIDE);
    this.#contacts = new Float32Array(this.#capacity * this.#maxContacts * PHYSICS_DEBUG_CONTACT_STRIDE);
    this.#joints = new Float32Array(this.#capacity * this.#maxJoints * PHYSICS_DEBUG_JOINT_STRIDE);
    this.#slotTicks = new Float64Array(this.#capacity);
    this.#slotBodyCounts = new Uint32Array(this.#capacity);
    this.#slotContactCounts = new Uint32Array(this.#capacity);
    this.#slotJointCounts = new Uint32Array(this.#capacity);
    this.#slotHashForward = new Uint32Array(this.#capacity);
    this.#slotHashBackward = new Uint32Array(this.#capacity);
  }

  get tickCapacity(): number { return this.#capacity; }
  get maxBodies(): number { return this.#maxBodies; }
  get maxContactsPerTick(): number { return this.#maxContacts; }
  get maxJointsPerTick(): number { return this.#maxJoints; }
  /** 当前缓冲内的 tick 数(≤ capacity;环形覆盖后恒等于 capacity)。 */
  get recordedTickCount(): number { return this.#filled; }
  /** 本次录制会话累计接受的 tick 数(含已被环形覆盖的)。 */
  get totalAcceptedTicks(): number { return this.#totalAccepted; }
  get recording(): boolean { return this.#recording; }
  get startedTick(): number | undefined { return this.#startedTick; }
  /** 检测到的 tick 断档次数(record 的 tick 不是上次 +1)。 */
  get lostTickGaps(): number { return this.#lostGaps; }
  /** 断档累计缺失 tick 数(跨端零丢 tick 验收门直接读这个)。 */
  get lostTicks(): number { return this.#lostTicks; }
  /** 因 bodyCount 超通道或非有限值被整 tick 拒绝的次数。 */
  get droppedTicks(): number { return this.#droppedTicks; }
  get truncatedContacts(): number { return this.#truncatedContacts; }
  get truncatedJoints(): number { return this.#truncatedJoints; }
  /** 整段录制链哈希(所有已接受 tick 的位姿块按序混入;环形覆盖同样生效)。 */
  get chainHash(): string { return hex8(this.#chainForward) + hex8(this.#chainBackward); }

  /** 开始录制(幂等;不清空已有缓冲,清空用 clear())。 */
  start(tick?: number): void {
    this.#recording = true;
    if (tick !== undefined && this.#startedTick === undefined) this.#startedTick = tick;
  }

  stop(): void {
    this.#recording = false;
  }

  /** 清空缓冲与统计,重置链哈希;录制开关保持原状。 */
  clear(): void {
    this.#writeSlot = 0;
    this.#filled = 0;
    this.#startedTick = undefined;
    this.#lastTick = undefined;
    this.#totalAccepted = 0;
    this.#lostGaps = 0;
    this.#lostTicks = 0;
    this.#droppedTicks = 0;
    this.#truncatedContacts = 0;
    this.#truncatedJoints = 0;
    this.#chainForward = 0x811c9dc5;
    this.#chainBackward = 0x811c9dc5;
    this.#marks = [];
  }

  /** 人工标记(低频);超上限返回 undefined(fail-loud,不静默覆盖)。 */
  mark(label: string): PhysicsDebugMark | undefined {
    if (this.#marks.length >= PHYSICS_DEBUG_MAX_MARKS) return undefined;
    const ordinal = this.#marks.length;
    const tick = this.#lastTick ?? this.#startedTick ?? -1;
    const entry: PhysicsDebugMark = { tick, label, ordinal };
    this.#marks.push(entry);
    return entry;
  }

  get marks(): readonly PhysicsDebugMark[] {
    return this.#marks;
  }

  /**
   * 录入一个 tick。热路径零分配:全部写入预分配通道;哈希在写入值上滚动。
   * 位姿块超通道(bodyCount > maxBodies)或出现非有限值 → 整 tick 拒绝并计入
   * droppedTicks(故障要响,不做静默截断);接触/关节超通道按前 K 个截断并计数
   * (诊断通道,截断规则确定性,跨端一致)。
   */
  record(input: PhysicsDebugRecorderTickInput): PhysicsDebugRecordOutcome {
    if (!this.#recording) return { accepted: false, slot: -1, reason: "not-recording" };
    if (!Number.isSafeInteger(input.tick)) throw new Error(`PhysicsDebugRecorder: tick must be an integer, got ${input.tick}.`);
    if (!Number.isSafeInteger(input.bodyCount) || input.bodyCount < 0) throw new Error(`PhysicsDebugRecorder: bodyCount must be a non-negative integer, got ${input.bodyCount}.`);
    if (input.bodyCount > this.#maxBodies) {
      this.#droppedTicks += 1;
      return { accepted: false, slot: -1, reason: "body-overflow" };
    }
    if (input.poses.length < input.bodyCount * PHYSICS_DEBUG_POSE_STRIDE) {
      throw new Error(`PhysicsDebugRecorder: poses length ${input.poses.length} < bodyCount×7 = ${input.bodyCount * PHYSICS_DEBUG_POSE_STRIDE}.`);
    }
    // 丢 tick 记账:tick 断档在跨端对拍里等价于录制源不稳定,必须显式暴露。
    if (this.#lastTick !== undefined && input.tick !== this.#lastTick + 1) {
      this.#lostGaps += 1;
      this.#lostTicks += Math.max(0, input.tick - this.#lastTick - 1);
    }
    this.#lastTick = input.tick;

    const slotBase = this.#writeSlot * this.#maxBodies * PHYSICS_DEBUG_POSE_STRIDE;
    let forward = 0x811c9dc5;
    let backward = 0x811c9dc5;
    const scratch = this.#hashScratch;
    const limit = input.bodyCount * PHYSICS_DEBUG_POSE_STRIDE;
    for (let i = 0; i < limit; i += 1) {
      const value = input.poses[i]!;
      if (!Number.isFinite(value)) {
        this.#droppedTicks += 1;
        return { accepted: false, slot: -1, reason: "non-finite" };
      }
      const quantized = Math.fround(value);
      this.#poses[slotBase + i] = quantized;
      scratch.setFloat32(0, quantized, true);
      for (let b = 0; b < 4; b += 1) {
        forward = Math.imul(forward ^ scratch.getUint8(b), 0x01000193);
        backward = Math.imul(backward ^ scratch.getUint8(3 - b), 0x01000193);
      }
    }
    // 接触/关节通道:确定性截断(f32 整数值下标 ≤2^24 精确)。
    const contactCount = Math.min(Math.max(0, Math.trunc(input.contactCount ?? 0)), this.#maxContacts);
    if ((input.contactCount ?? 0) > this.#maxContacts) this.#truncatedContacts += (input.contactCount ?? 0) - this.#maxContacts;
    const contactBase = this.#writeSlot * this.#maxContacts * PHYSICS_DEBUG_CONTACT_STRIDE;
    for (let i = 0; i < contactCount * PHYSICS_DEBUG_CONTACT_STRIDE; i += 1) {
      const value = input.contacts?.[i];
      if (value === undefined) throw new Error(`PhysicsDebugRecorder: contacts truncated payload missing at ${i}.`);
      if (!Number.isFinite(value)) {
        this.#droppedTicks += 1;
        return { accepted: false, slot: -1, reason: "non-finite" };
      }
      this.#contacts[contactBase + i] = Math.fround(value);
    }
    const jointCount = Math.min(Math.max(0, Math.trunc(input.jointCount ?? 0)), this.#maxJoints);
    if ((input.jointCount ?? 0) > this.#maxJoints) this.#truncatedJoints += (input.jointCount ?? 0) - this.#maxJoints;
    const jointBase = this.#writeSlot * this.#maxJoints * PHYSICS_DEBUG_JOINT_STRIDE;
    for (let i = 0; i < jointCount * PHYSICS_DEBUG_JOINT_STRIDE; i += 1) {
      const value = input.joints?.[i];
      if (value === undefined) throw new Error(`PhysicsDebugRecorder: joints truncated payload missing at ${i}.`);
      if (!Number.isFinite(value)) {
        this.#droppedTicks += 1;
        return { accepted: false, slot: -1, reason: "non-finite" };
      }
      this.#joints[jointBase + i] = Math.fround(value);
    }

    this.#slotTicks[this.#writeSlot] = input.tick;
    this.#slotBodyCounts[this.#writeSlot] = input.bodyCount;
    this.#slotContactCounts[this.#writeSlot] = contactCount;
    this.#slotJointCounts[this.#writeSlot] = jointCount;
    this.#slotHashForward[this.#writeSlot] = forward >>> 0;
    this.#slotHashBackward[this.#writeSlot] = backward >>> 0;
    this.#chainForward = chainMix(this.#chainForward, forward >>> 0);
    this.#chainBackward = chainMix(this.#chainBackward, backward >>> 0);

    const acceptedSlot = this.#writeSlot;
    this.#writeSlot = (this.#writeSlot + 1) % this.#capacity;
    if (this.#filled < this.#capacity) this.#filled += 1;
    this.#totalAccepted += 1;
    if (this.#startedTick === undefined) this.#startedTick = input.tick;
    return { accepted: true, slot: acceptedSlot };
  }

  #slotOf(index: number): number {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#filled) throw new Error(`PhysicsDebugRecorder: tick index ${index} out of range [0, ${this.#filled}).`);
    // 时间升序:最早一帧位于 writeSlot(filled==capacity 时)或 0(未满)。
    const oldest = this.#filled < this.#capacity ? 0 : this.#writeSlot;
    return (oldest + index) % this.#capacity;
  }

  /** 缓冲内第 index 个(时间升序)tick 号。 */
  tickAt(index: number): number {
    return this.#slotTicks[this.#slotOf(index)]!;
  }

  /** 缓冲内第 index 个 tick 的位姿哈希(与快照/JSON 里的 hash 一致)。 */
  tickHashAt(index: number): string {
    const slot = this.#slotOf(index);
    return hex8(this.#slotHashForward[slot]!) + hex8(this.#slotHashBackward[slot]!);
  }

  /** 把第 index 个 tick 的位姿块拷进 out(f32 量化位模式逐位一致)。 */
  copyTickPoses(index: number, out: Float32Array): void {
    const slot = this.#slotOf(index);
    const base = slot * this.#maxBodies * PHYSICS_DEBUG_POSE_STRIDE;
    out.set(this.#poses.subarray(base, base + this.#slotBodyCounts[slot]! * PHYSICS_DEBUG_POSE_STRIDE));
  }

  /** 把第 index 个 tick 的接触块拷进 out,返回条数。 */
  copyTickContacts(index: number, out: Float32Array): number {
    const slot = this.#slotOf(index);
    const count = this.#slotContactCounts[slot]!;
    const base = slot * this.#maxContacts * PHYSICS_DEBUG_CONTACT_STRIDE;
    out.set(this.#contacts.subarray(base, base + count * PHYSICS_DEBUG_CONTACT_STRIDE));
    return count;
  }

  /** 把第 index 个 tick 的关节脉冲块拷进 out,返回条数。 */
  copyTickJoints(index: number, out: Float32Array): number {
    const slot = this.#slotOf(index);
    const count = this.#slotJointCounts[slot]!;
    const base = slot * this.#maxJoints * PHYSICS_DEBUG_JOINT_STRIDE;
    out.set(this.#joints.subarray(base, base + count * PHYSICS_DEBUG_JOINT_STRIDE));
    return count;
  }

  /** 全缓冲只读快照(分配态;回放/比对/序列化专用,不在热路径)。 */
  snapshotTicks(): PhysicsDebugTickSnapshot[] {
    const ticks: PhysicsDebugTickSnapshot[] = [];
    for (let index = 0; index < this.#filled; index += 1) {
      const slot = this.#slotOf(index);
      const bodyCount = this.#slotBodyCounts[slot]!;
      const contactCount = this.#slotContactCounts[slot]!;
      const jointCount = this.#slotJointCounts[slot]!;
      const poseBase = slot * this.#maxBodies * PHYSICS_DEBUG_POSE_STRIDE;
      const contactBase = slot * this.#maxContacts * PHYSICS_DEBUG_CONTACT_STRIDE;
      const jointBase = slot * this.#maxJoints * PHYSICS_DEBUG_JOINT_STRIDE;
      ticks.push({
        tick: this.#slotTicks[slot]!,
        hash: hex8(this.#slotHashForward[slot]!) + hex8(this.#slotHashBackward[slot]!),
        poses: this.#poses.slice(poseBase, poseBase + bodyCount * PHYSICS_DEBUG_POSE_STRIDE),
        bodyCount,
        contacts: this.#contacts.slice(contactBase, contactBase + contactCount * PHYSICS_DEBUG_CONTACT_STRIDE),
        contactCount,
        joints: this.#joints.slice(jointBase, jointBase + jointCount * PHYSICS_DEBUG_JOINT_STRIDE),
        jointCount,
      });
    }
    return ticks;
  }

  /** 序列化为跨端 JSON(native 侧 physics_debug_compare.rs 直接消费)。 */
  toDebugJson(meta: { hz?: number; note?: string; bodyIds?: readonly string[] } = {}): string {
    const payload = {
      schema: PHYSICS_DEBUG_RECORDING_SCHEMA,
      schemaVersion: PHYSICS_DEBUG_RECORDING_SCHEMA_VERSION,
      chainHash: this.chainHash,
      meta: {
        ...meta,
        startedTick: this.#startedTick ?? null,
        totalAcceptedTicks: this.#totalAccepted,
        recordedTicks: this.#filled,
        tickCapacity: this.#capacity,
        maxBodies: this.#maxBodies,
        maxContactsPerTick: this.#maxContacts,
        maxJointsPerTick: this.#maxJoints,
        lostTickGaps: this.#lostGaps,
        lostTicks: this.#lostTicks,
        droppedTicks: this.#droppedTicks,
        marks: this.#marks,
        poseStride: PHYSICS_DEBUG_POSE_STRIDE,
        contactStride: PHYSICS_DEBUG_CONTACT_STRIDE,
        jointStride: PHYSICS_DEBUG_JOINT_STRIDE,
        layout: "poses: px,py,pz,qx,qy,qz,qw · contacts: a,b,px,py,pz,pen,nx,ny,nz · joints: idx,ix,iy,iz (f32 LE)",
      },
      ticks: this.snapshotTicks().map((tick) => ({
        tick: tick.tick,
        hash: tick.hash,
        bodyCount: tick.bodyCount,
        poses: Array.from(tick.poses),
        contactCount: tick.contactCount,
        contacts: tick.contactCount > 0 ? Array.from(tick.contacts) : [],
        jointCount: tick.jointCount,
        joints: tick.jointCount > 0 ? Array.from(tick.joints) : [],
      })),
    };
    return JSON.stringify(payload);
  }
}

// ─── 跨端比对:同 tick 位姿哈希 + >1e-3 精确定位 ─────────────────────────────

export interface PhysicsDebugCompareTolerance {
  /** 位置差容差(米);默认 1e-3(任务书口径)。 */
  readonly positionMeters: number;
  /** 旋转差容差(弧度,短弧角);默认 1e-3。 */
  readonly rotationRadians: number;
}

export const PHYSICS_DEBUG_DEFAULT_COMPARE_TOLERANCE: PhysicsDebugCompareTolerance = {
  positionMeters: 1e-3,
  rotationRadians: 1e-3,
};

export interface PhysicsDebugCompareTickRow {
  readonly tick: number;
  readonly hashMatch: boolean;
  readonly maxPosition: number;
  readonly maxRotation: number;
  readonly positionExceeded: boolean;
  readonly rotationExceeded: boolean;
  readonly exceeded: boolean;
}

export interface PhysicsDebugCompareResult {
  readonly ticksCompared: number;
  readonly perTick: PhysicsDebugCompareTickRow[];
  readonly maxPosition: number;
  readonly maxRotation: number;
  /** 首个超差 tick(无则 null)——跨端定位验收门直接读这个。 */
  readonly firstExceededTick: number | null;
  readonly firstHashMismatchTick: number | null;
  readonly exceededTickCount: number;
  readonly tolerance: PhysicsDebugCompareTolerance;
}

const quaternionAngleBetween = (a: Float32Array, b: Float32Array, poseOffsetA: number, poseOffsetB: number): number => {
  const ax = a[poseOffsetA + 3]!, ay = a[poseOffsetA + 4]!, az = a[poseOffsetA + 5]!, aw = a[poseOffsetA + 6]!;
  const bx = b[poseOffsetB + 3]!, by = b[poseOffsetB + 4]!, bz = b[poseOffsetB + 5]!, bw = b[poseOffsetB + 6]!;
  const dot = Math.abs(ax * bx + ay * by + az * bz + aw * bw);
  return 2 * Math.acos(Math.min(1, dot));
};

/**
 * 按 tick 号对齐比较两段录制快照。哈希相等且 bodyCount 相同 → 判定逐位一致
 * (快路径,不进浮点差);哈希不等才计算逐体最大位置/旋转差。
 * 容差默认 1e-3 米 / 1e-3 弧度(任务书口径);超差 tick 逐条列出并给出首个。
 */
export function comparePhysicsDebugRecordingTicks(
  a: readonly PhysicsDebugTickSnapshot[],
  b: readonly PhysicsDebugTickSnapshot[],
  tolerance: PhysicsDebugCompareTolerance = PHYSICS_DEBUG_DEFAULT_COMPARE_TOLERANCE,
): PhysicsDebugCompareResult {
  if (a.length === 0 || b.length === 0) throw new Error("comparePhysicsDebugRecordingTicks: 两侧快照至少一份为空,无法比对");
  const byTick = new Map<number, PhysicsDebugTickSnapshot>();
  for (const tick of b) byTick.set(tick.tick, tick);
  const perTick: PhysicsDebugCompareTickRow[] = [];
  let maxPosition = 0;
  let maxRotation = 0;
  let firstExceededTick: number | null = null;
  let firstHashMismatchTick: number | null = null;
  let exceededTickCount = 0;
  for (const tickA of a) {
    const tickB = byTick.get(tickA.tick);
    if (!tickB) continue; // 步号错位宁少比不错比(与 physicsPoseCompare 同口径)。
    if (firstHashMismatchTick === null && tickA.hash !== tickB.hash) firstHashMismatchTick = tickA.tick;
    if (tickA.hash === tickB.hash && tickA.bodyCount === tickB.bodyCount) {
      perTick.push({ tick: tickA.tick, hashMatch: true, maxPosition: 0, maxRotation: 0, positionExceeded: false, rotationExceeded: false, exceeded: false });
      continue;
    }
    const bodyCount = Math.min(tickA.bodyCount, tickB.bodyCount);
    let stepMaxPosition = 0;
    let stepMaxRotation = 0;
    for (let body = 0; body < bodyCount; body += 1) {
      const offsetA = body * PHYSICS_DEBUG_POSE_STRIDE;
      const offsetB = body * PHYSICS_DEBUG_POSE_STRIDE;
      const dx = tickA.poses[offsetA]! - tickB.poses[offsetB]!;
      const dy = tickA.poses[offsetA + 1]! - tickB.poses[offsetB + 1]!;
      const dz = tickA.poses[offsetA + 2]! - tickB.poses[offsetB + 2]!;
      stepMaxPosition = Math.max(stepMaxPosition, Math.hypot(dx, dy, dz));
      stepMaxRotation = Math.max(stepMaxRotation, quaternionAngleBetween(tickA.poses, tickB.poses, offsetA, offsetB));
    }
    const positionExceeded = stepMaxPosition > tolerance.positionMeters;
    const rotationExceeded = stepMaxRotation > tolerance.rotationRadians;
    const exceeded = positionExceeded || rotationExceeded;
    if (exceeded && firstExceededTick === null) firstExceededTick = tickA.tick;
    if (exceeded) exceededTickCount += 1;
    maxPosition = Math.max(maxPosition, stepMaxPosition);
    maxRotation = Math.max(maxRotation, stepMaxRotation);
    perTick.push({ tick: tickA.tick, hashMatch: false, maxPosition: stepMaxPosition, maxRotation: stepMaxRotation, positionExceeded, rotationExceeded, exceeded });
  }
  return {
    ticksCompared: perTick.length,
    perTick,
    maxPosition,
    maxRotation,
    firstExceededTick,
    firstHashMismatchTick,
    exceededTickCount,
    tolerance,
  };
}

// ─── 外部录制 JSON 的载入(跨端交换;web↔native 同一份合同) ─────────────────

export interface ParsedPhysicsDebugRecording {
  readonly meta: Record<string, unknown>;
  readonly chainHash: string;
  readonly ticks: PhysicsDebugTickSnapshot[];
}

/** 解析 toDebugJson 产物;结构不合法抛中文错误(与 parsePhysicsPoseJson 同风格)。 */
export function parsePhysicsDebugRecordingJson(text: string): ParsedPhysicsDebugRecording {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("物理调试录制 JSON 解析失败:不是合法 JSON");
  }
  if (typeof payload !== "object" || payload === null) throw new Error("物理调试录制 JSON 缺少根对象");
  const { schema, schemaVersion, meta, chainHash, ticks } = payload as Record<string, unknown>;
  if (schema !== PHYSICS_DEBUG_RECORDING_SCHEMA) throw new Error(`物理调试录制 JSON schema 不符:${String(schema)}`);
  if (schemaVersion !== PHYSICS_DEBUG_RECORDING_SCHEMA_VERSION) throw new Error(`物理调试录制 JSON 版本不符:${String(schemaVersion)}`);
  if (typeof meta !== "object" || meta === null) throw new Error("物理调试录制 JSON 缺少 meta 区");
  if (typeof chainHash !== "string" || chainHash.length !== 16) throw new Error("物理调试录制 JSON 的 chainHash 非法");
  if (!Array.isArray(ticks) || ticks.length === 0) throw new Error("物理调试录制 JSON 的 ticks 为空或缺失");
  const parsedTicks = ticks.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`物理调试录制 JSON 第 ${index + 1} 个 tick 非对象`);
    const { tick, hash, bodyCount, poses, contactCount, contacts, jointCount, joints } = entry as Record<string, unknown>;
    if (typeof tick !== "number" || !Number.isSafeInteger(tick)) throw new Error(`物理调试录制 JSON 第 ${index + 1} 个 tick 号非法`);
    if (typeof hash !== "string" || hash.length !== 16) throw new Error(`物理调试录制 JSON 第 ${index + 1} 个 tick 哈希非法`);
    if (typeof bodyCount !== "number" || !Number.isSafeInteger(bodyCount) || bodyCount < 0) throw new Error(`物理调试录制 JSON 第 ${index + 1} 个 tick 的 bodyCount 非法`);
    if (!Array.isArray(poses) || poses.length !== bodyCount * PHYSICS_DEBUG_POSE_STRIDE) throw new Error(`物理调试录制 JSON 第 ${index + 1} 个 tick 的 poses 长度与 bodyCount 不一致`);
    const parsedPoses = Float32Array.from(poses as number[], (value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`物理调试录制 JSON 第 ${index + 1} 个 tick 的位姿含非有限值`);
      return value;
    });
    const parsedContacts = Float32Array.from((contacts as number[] | undefined) ?? []);
    const parsedJoints = Float32Array.from((joints as number[] | undefined) ?? []);
    return {
      tick,
      hash,
      poses: parsedPoses,
      bodyCount,
      contacts: parsedContacts,
      contactCount: typeof contactCount === "number" ? contactCount : 0,
      joints: parsedJoints,
      jointCount: typeof jointCount === "number" ? jointCount : 0,
    } satisfies PhysicsDebugTickSnapshot;
  });
  return { meta: meta as Record<string, unknown>, chainHash, ticks: parsedTicks };
}
