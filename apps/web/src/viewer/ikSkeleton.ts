import * as THREE from "three";
import { assertRobotPose, type RobotAssetDefinition } from "@bim-studio/contracts";
import { normalizedRobotAxis } from "./urdfJointNormalization";

/**
 * 纯数学骨架运动学层(节点 = 关节坐标系;URDF 语义:子连杆系与关节系重合)。
 * 为多链限位 IK、姿态搜索与重定向提供确定性底座,不依赖场景对象。
 * 场景骨骼链 IK 仍由 ik.ts 承担,本文件不重复其单链场景路径。
 */

/** 节点运动类型;URDF continuous 折叠为无限制 revolute,fixed 无自由度。 */
export type IKJointType = "revolute" | "prismatic" | "fixed";

/** 硬限位:revolute 单位弧度、prismatic 单位米;缺省表示无限制。 */
export interface IKJointLimit {
  lower: number;
  upper: number;
}

/** mimic 驱动:值 = clampToLimits(multiplier × 驱动关节值 + offset)。 */
export interface IKMimicDrive {
  joint: number;
  multiplier: number;
  offset: number;
}

export interface IKSkeletonNode {
  /** 关节名,是姿态记录的主键;根节点使用 rootLink 名。 */
  name: string;
  /** 父节点索引;-1 表示唯一根。必须小于自身索引(拓扑序),由此天然排除环。 */
  parent: number;
  /** 静息局部平移(URDF origin.xyz)。 */
  restTranslation: THREE.Vector3;
  /** 静息局部旋转(URDF origin.rpy,ZYX 欧拉)。 */
  restRotation: THREE.Quaternion;
  type: IKJointType;
  /** 旋转/平移轴(已单位化);fixed 节点忽略。 */
  axis: THREE.Vector3;
  limits?: IKJointLimit;
  /** mimic 节点是派生量:不可直接驱动,也不进入 IK 与 Jacobian 的自由空间。 */
  mimic?: IKMimicDrive;
}

export interface IKSkeleton {
  nodes: IKSkeletonNode[];
  root: number;
}

export interface IKFrameWorld {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

/** 末端 = 某关节系内的一个点;offset 为该关节局部坐标,缺省为原点(如 TCP)。 */
export interface IKEffector {
  joint: number;
  offset?: THREE.Vector3;
}

export interface IKTarget {
  effector: IKEffector;
  /** 世界系目标位置。 */
  position: THREE.Vector3;
}

export interface IKSolveOptions {
  /** 全局迭代轮数;每轮对每个目标做一次自末端向根的 CCD 扫描。 */
  globalIterations?: number;
  /** 收敛残差(米),所有目标达到后提前退出。 */
  tolerance?: number;
  /** 初始姿态(按节点索引的全量数组);缺省全零。 */
  initialPose?: readonly number[];
}

export interface IKSolution {
  pose: number[];
  /** 各目标的末端残差(米),不可达目标同样是有限值。 */
  residuals: number[];
  converged: boolean[];
}

/** 数学层单骨架节点上限,与 URDF 导入上限一致,避免退化输入拖垮迭代求解。 */
const MAX_SKELETON_NODES = 512;
/** 奇异度行列式的链自由度上限;超出直接拒绝,不静默换口径。 */
export const MAX_MANIPULABILITY_DOFS = 12;
/** 退化几何(重合点/平行向量)判定阈值。 */
const DEGENERATE_EPSILON = 1e-12;
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} 必须是有限数值`);
}

function assertFiniteVector(value: THREE.Vector3, label: string): void {
  assertFiniteNumber(value.x, `${label}.x`);
  assertFiniteNumber(value.y, `${label}.y`);
  assertFiniteNumber(value.z, `${label}.z`);
}

/** 节点是否为 IK/Jacobian 的自由变量:可动且非 mimic 派生。 */
export function isFreeJoint(node: IKSkeletonNode): boolean {
  return node.type !== "fixed" && !node.mimic;
}

export function clampToLimits(node: IKSkeletonNode, value: number): number {
  if (!node.limits) return value;
  return Math.min(node.limits.upper, Math.max(node.limits.lower, value));
}

function checkLimit(lower: number, upper: number): IKJointLimit {
  assertFiniteNumber(lower, "关节限位下界");
  assertFiniteNumber(upper, "关节限位上界");
  if (lower > upper) throw new Error(`关节限位下界 ${lower} 大于上界 ${upper}`);
  return { lower, upper };
}

/**
 * 构建并校验骨架:唯一命名、唯一根、拓扑序(父索引小于自身)、有限静息变换、
 * 单位化轴向与合法限位。任何结构性非法输入在此显式报错,不进入求解层。
 */
export function buildSkeleton(nodes: readonly IKSkeletonNode[]): IKSkeleton {
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error("骨架至少需要一个节点");
  if (nodes.length > MAX_SKELETON_NODES) throw new Error(`骨架节点数 ${nodes.length} 超过上限 ${MAX_SKELETON_NODES}`);
  const names = new Set<string>();
  let root = -1;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    if (!node || typeof node.name !== "string" || !node.name.trim()) throw new Error(`骨架节点 ${index} 缺少有效名称`);
    if (names.has(node.name)) throw new Error(`骨架节点名称重复:${node.name}`);
    names.add(node.name);
    if (!Number.isInteger(node.parent) || node.parent < -1 || node.parent >= index) {
      throw new Error(`骨架节点 ${node.name} 的父索引 ${node.parent} 非法(要求 -1 或小于 ${index} 的拓扑序索引)`);
    }
    if (node.parent < 0) {
      if (root >= 0) throw new Error(`骨架存在多个根:${nodes[root]!.name} 与 ${node.name}`);
      root = index;
    }
    assertFiniteVector(node.restTranslation, `骨架节点 ${node.name} 的静息平移`);
    if (node.type !== "revolute" && node.type !== "prismatic" && node.type !== "fixed") {
      throw new Error(`骨架节点 ${node.name} 的运动类型 ${String(node.type)} 无效`);
    }
    if (node.type !== "fixed") {
      assertFiniteVector(node.axis, `骨架节点 ${node.name} 的轴向`);
      if (node.axis.lengthSq() <= DEGENERATE_EPSILON) throw new Error(`骨架节点 ${node.name} 的轴向为零向量`);
      node.axis = node.axis.clone().normalize();
    }
    if (node.limits) {
      if (node.type === "fixed") throw new Error(`fixed 节点 ${node.name} 不允许声明限位`);
      node.limits = checkLimit(node.limits.lower, node.limits.upper);
    }
    if (node.mimic) {
      if (node.type === "fixed") throw new Error(`fixed 节点 ${node.name} 不允许 mimic 驱动`);
      assertFiniteNumber(node.mimic.multiplier, `mimic 节点 ${node.name} 的乘子`);
      assertFiniteNumber(node.mimic.offset, `mimic 节点 ${node.name} 的偏移`);
      if (!Number.isInteger(node.mimic.joint) || node.mimic.joint < 0 || node.mimic.joint >= nodes.length) {
        throw new Error(`mimic 节点 ${node.name} 的驱动关节索引非法`);
      }
    }
  }
  if (root < 0) throw new Error("骨架缺少根节点");
  const skeleton: IKSkeleton = { nodes, root };
  assertNoMimicCycle(skeleton);
  return skeleton;
}

function assertNoMimicCycle(skeleton: IKSkeleton): void {
  const visiting = new Set<number>();
  const visit = (index: number): void => {
    const node = skeleton.nodes[index]!;
    if (!node.mimic) return;
    if (visiting.has(index)) throw new Error(`骨架 mimic 关节 ${node.name} 存在循环驱动`);
    visiting.add(index);
    visit(node.mimic.joint);
    visiting.delete(index);
  };
  for (let index = 0; index < skeleton.nodes.length; index++) visit(index);
}

function nodeFromRobotJoint(joint: RobotAssetDefinition["joints"][number], parent: number): IKSkeletonNode {
  const type: IKJointType = joint.type === "continuous" ? "revolute" : joint.type;
  const restTranslation = new THREE.Vector3(joint.origin.xyz.x, joint.origin.xyz.y, joint.origin.xyz.z);
  const restRotation = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(joint.origin.rpy.x, joint.origin.rpy.y, joint.origin.rpy.z, "ZYX"),
  );
  assertFiniteVector(restTranslation, `机器人关节 ${joint.name} 的原点平移`);
  const axis = type === "fixed" ? new THREE.Vector3(0, 0, 1) : normalizedRobotAxis(joint.axis);
  const node: IKSkeletonNode = { name: joint.name, parent, restTranslation, restRotation, type, axis };
  if (type !== "fixed" && joint.type !== "continuous" && joint.limit?.lower !== undefined && joint.limit?.upper !== undefined) {
    node.limits = checkLimit(joint.limit.lower, joint.limit.upper);
  }
  return node;
}

/**
 * 从 URDF 资源定义构建关节系骨架:父连接杆名定位父关节系,子连杆名登记新关节系。
 * 父连杆尚未出现时多轮重排(拓扑排序),成环或断链显式报错。
 * mimic 引用在全部节点就绪后统一解析;mimic 是派生量,不作为自由关节参与求解。
 */
export function buildSkeletonFromRobotDefinition(definition: RobotAssetDefinition): IKSkeleton {
  if (!definition || typeof definition.rootLink !== "string" || !definition.rootLink || !Array.isArray(definition.joints)) {
    throw new Error("机器人资源定义无效");
  }
  type RobotJoint = RobotAssetDefinition["joints"][number];
  const nodes: IKSkeletonNode[] = [
    {
      name: definition.rootLink,
      parent: -1,
      restTranslation: new THREE.Vector3(),
      restRotation: new THREE.Quaternion(),
      type: "fixed",
      axis: new THREE.Vector3(0, 0, 1),
    },
  ];
  const jointByNode: (RobotJoint | undefined)[] = [undefined];
  const linkFrame = new Map<string, number>([[definition.rootLink, 0]]);
  const pending = [...definition.joints];
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const joint = pending[i]!;
      const parent = linkFrame.get(joint.parent);
      if (parent === undefined) continue;
      pending.splice(i, 1);
      progress = true;
      if (linkFrame.has(joint.child)) throw new Error(`机器人连杆 ${joint.child} 被多个关节声明为子连杆`);
      linkFrame.set(joint.child, nodes.length);
      nodes.push(nodeFromRobotJoint(joint, parent));
      jointByNode.push(joint);
    }
  }
  if (pending.length > 0) {
    throw new Error(`机器人关节 ${pending.map(joint => joint.name).join("、")} 的父连杆缺失或连杆关系成环`);
  }
  const jointIndex = new Map(nodes.map((node, index) => [node.name, index] as const));
  for (let index = 1; index < nodes.length; index++) {
    const joint = jointByNode[index]!;
    if (!joint.mimic) continue;
    const drive = jointIndex.get(joint.mimic.joint);
    const node = nodes[index]!;
    if (drive === undefined || drive === index || nodes[drive]!.type === "fixed") {
      throw new Error(`机器人 mimic 关节 ${joint.name} 的驱动关节 ${joint.mimic.joint} 无效`);
    }
    node.mimic = { joint: drive, multiplier: joint.mimic.multiplier, offset: joint.mimic.offset };
  }
  return buildSkeleton(nodes);
}

/** 关节名 → 节点索引;不存在时返回 undefined。 */
export function jointIndexByName(skeleton: IKSkeleton, name: string): number | undefined {
  const index = skeleton.nodes.findIndex(node => node.name === name);
  return index >= 0 ? index : undefined;
}

/** 自节点向根的祖先链(含自身与根),顺序确定,供 CCD 与 Jacobian 使用。 */
export function chainOf(skeleton: IKSkeleton, index: number): number[] {
  if (!Number.isInteger(index) || index < 0 || index >= skeleton.nodes.length) throw new Error("末端关节索引非法");
  const chain: number[] = [];
  for (let current = index; current >= 0; current = skeleton.nodes[current]!.parent) chain.push(current);
  return chain;
}

/**
 * 姿态记录(关节名 → SI 值)转为节点序数组:可动关节取记录值(缺省 0,不做限位钳制,
 * 限位由 IK/搜索/重定向层负责),fixed 与 mimic 填 0 待解析。未知名称与非有限值显式报错。
 */
export function poseFromRecord(skeleton: IKSkeleton, record: Record<string, number>): number[] {
  assertRobotPose(record);
  const pose = new Array<number>(skeleton.nodes.length).fill(0);
  for (const [name, value] of Object.entries(record)) {
    const index = jointIndexByName(skeleton, name);
    if (index === undefined) throw new Error(`骨架没有关节 ${name}`);
    const node = skeleton.nodes[index]!;
    if (node.type === "fixed") throw new Error(`关节 ${name} 是 fixed,不可驱动`);
    if (node.mimic) throw new Error(`关节 ${name} 由 mimic 派生,不可直接驱动`);
    pose[index] = value;
  }
  return pose;
}

/** 节点序数组转回关节名记录:含 mimic 派生值,不含 fixed;与 robotPoseRuntime 的解析口径一致。 */
export function poseToRecord(skeleton: IKSkeleton, pose: readonly number[]): Record<string, number> {
  const values = resolvePoseValues(skeleton, pose);
  const record: Record<string, number> = {};
  for (let index = 0; index < skeleton.nodes.length; index++) {
    const node = skeleton.nodes[index]!;
    if (node.type === "fixed") continue;
    record[node.name] = values[index]!;
  }
  return record;
}

/** 解析全部节点值:mimic 递归求值(带环检测)并按限位钳制,fixed 恒 0,自由关节取输入。 */
export function resolvePoseValues(skeleton: IKSkeleton, pose: readonly number[]): number[] {
  const nodes = skeleton.nodes;
  if (!Array.isArray(pose) || pose.length !== nodes.length) throw new Error("姿态数组长度与骨架节点数不一致");
  const values = new Array<number>(nodes.length).fill(0);
  const done = new Array<boolean>(nodes.length).fill(false);
  const visiting = new Array<boolean>(nodes.length).fill(false);
  const resolve = (index: number): number => {
    if (done[index]) return values[index]!;
    const node = nodes[index]!;
    if (visiting[index]) throw new Error(`骨架 mimic 关节 ${node.name} 存在循环驱动`);
    visiting[index] = true;
    let value: number;
    if (node.type === "fixed") value = 0;
    else if (node.mimic) value = clampToLimits(node, resolve(node.mimic.joint) * node.mimic.multiplier + node.mimic.offset);
    else value = pose[index]!;
    if (!Number.isFinite(value)) throw new Error(`骨架节点 ${node.name} 的姿态值无效`);
    visiting[index] = false;
    done[index] = true;
    values[index] = value;
    return value;
  };
  for (let index = 0; index < nodes.length; index++) resolve(index);
  return values;
}

function applyJointMotion(
  node: IKSkeletonNode,
  value: number,
  local: THREE.Matrix4,
  motion: THREE.Matrix4,
  rotation: THREE.Quaternion,
): void {
  if (node.type === "revolute") {
    rotation.setFromAxisAngle(node.axis, value);
    motion.makeRotationFromQuaternion(rotation);
    local.multiply(motion);
  } else if (node.type === "prismatic") {
    motion.makeTranslation(node.axis.x * value, node.axis.y * value, node.axis.z * value);
    local.multiply(motion);
  }
}

/** 正向运动学:返回各关节系世界位姿。纯函数,输入不变则输出逐位一致。 */
export function skeletonFK(skeleton: IKSkeleton, pose: readonly number[]): IKFrameWorld[] {
  const values = resolvePoseValues(skeleton, pose);
  return fkMatrices(skeleton, values).map(matrix => ({
    position: new THREE.Vector3().setFromMatrixPosition(matrix),
    quaternion: new THREE.Quaternion().setFromRotationMatrix(matrix),
  }));
}

/** 内部:按已解析值计算世界矩阵(world = parentWorld × rest × motion)。 */
function fkMatrices(skeleton: IKSkeleton, values: readonly number[]): THREE.Matrix4[] {
  const nodes = skeleton.nodes;
  const worldMatrices: THREE.Matrix4[] = new Array(nodes.length);
  const local = new THREE.Matrix4();
  const motion = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    local.compose(node.restTranslation, node.restRotation, UNIT_SCALE);
    applyJointMotion(node, values[index]!, local, motion, rotation);
    if (node.parent >= 0) local.premultiply(worldMatrices[node.parent]!);
    worldMatrices[index] = local.clone();
  }
  return worldMatrices;
}

function assertEffector(skeleton: IKSkeleton, effector: IKEffector): void {
  if (!effector || !Number.isInteger(effector.joint) || effector.joint < 0 || effector.joint >= skeleton.nodes.length) {
    throw new Error("末端关节索引非法");
  }
  if (effector.offset) assertFiniteVector(effector.offset, "末端偏移");
}

/** 末端世界坐标 = 关节系 × 局部偏移。 */
export function effectorWorldPosition(
  worlds: readonly IKFrameWorld[],
  skeleton: IKSkeleton,
  effector: IKEffector,
): THREE.Vector3 {
  assertEffector(skeleton, effector);
  const frame = worlds[effector.joint]!;
  if (!effector.offset) return frame.position.clone();
  return effector.offset.clone().applyQuaternion(frame.quaternion).add(frame.position);
}

function buildChildren(skeleton: IKSkeleton): number[][] {
  const children: number[][] = skeleton.nodes.map(() => []);
  for (let index = 0; index < skeleton.nodes.length; index++) {
    const parent = skeleton.nodes[index]!.parent;
    if (parent >= 0) children[parent]!.push(index);
  }
  return children;
}

/** 单次求解的 IK 目标数量上限,防止误用批量接口拖垮帧内预算。 */
const MAX_IK_TARGETS = 64;

/**
 * 多链限位 CCD:目标按入参顺序逐个求解,每轮自末端向根扫描链上自由关节,
 * 旋转量/平移量按关节硬限位钳制后再写入(限位是硬约束,任何时刻不越界)。
 * 共享前缀(如机械臂基座)被多条链共同更新,覆盖多根链/子基场景。
 * 全程固定顺序迭代、无随机源:同输入逐位同解;不可达目标收敛到限位边界,残差有限。
 */
export function solveSkeletonIK(skeleton: IKSkeleton, targets: readonly IKTarget[], options: IKSolveOptions = {}): IKSolution {
  const iterations = Math.floor(options.globalIterations ?? 32);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 512) throw new Error("IK 全局迭代次数必须是 1..512 的整数");
  const tolerance = Math.max(1e-9, options.tolerance ?? 1e-5);
  if (!Array.isArray(targets) || targets.length > MAX_IK_TARGETS) throw new Error(`IK 目标数非法(上限 ${MAX_IK_TARGETS})`);
  for (const target of targets) {
    assertEffector(skeleton, target.effector);
    assertFiniteVector(target.position, "IK 目标位置");
  }
  const nodes = skeleton.nodes;
  const pose = new Array<number>(nodes.length).fill(0);
  if (options.initialPose) {
    if (options.initialPose.length !== nodes.length) throw new Error("初始姿态数组长度与骨架节点数不一致");
    for (let index = 0; index < nodes.length; index++) {
      const value = options.initialPose[index]!;
      assertFiniteNumber(value, "初始姿态值");
      pose[index] = value;
    }
  }
  const children = buildChildren(skeleton);
  const values = resolvePoseValues(skeleton, pose);
  const worldMatrices = fkMatrices(skeleton, values);
  const worlds: IKFrameWorld[] = worldMatrices.map(matrix => ({
    position: new THREE.Vector3().setFromMatrixPosition(matrix),
    quaternion: new THREE.Quaternion().setFromRotationMatrix(matrix),
  }));
  const local = new THREE.Matrix4();
  const motion = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  /** 关节值变更后自该节点向子树增量重算(父世界在 DFS 序中总是新鲜)。 */
  const recomputeSubtree = (start: number): void => {
    const stack = [start];
    while (stack.length > 0) {
      const index = stack.pop()!;
      const node = nodes[index]!;
      local.compose(node.restTranslation, node.restRotation, UNIT_SCALE);
      applyJointMotion(node, pose[index]!, local, motion, rotation);
      if (node.parent >= 0) local.premultiply(worldMatrices[node.parent]!);
      worldMatrices[index] = local.clone();
      worlds[index]!.position.setFromMatrixPosition(local);
      worlds[index]!.quaternion.setFromRotationMatrix(local);
      for (const child of children[index]!) stack.push(child);
    }
  };
  const scratchEffector = new THREE.Vector3();
  const toEffector = new THREE.Vector3();
  const toTarget = new THREE.Vector3();
  const axisWorld = new THREE.Vector3();
  const effectorInPlane = new THREE.Vector3();
  const targetInPlane = new THREE.Vector3();
  const cross = new THREE.Vector3();

  const residuals = targets.map(target => effectorWorldPosition(worlds, skeleton, target.effector).distanceTo(target.position));
  for (let round = 0; round < iterations; round++) {
    let allConverged = true;
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
      const target = targets[targetIndex]!;
      const chain = chainOf(skeleton, target.effector.joint);
      for (const joint of chain) {
        const node = nodes[joint]!;
        if (!isFreeJoint(node)) continue;
        scratchEffector.copy(effectorWorldPosition(worlds, skeleton, target.effector));
        toEffector.subVectors(scratchEffector, worlds[joint]!.position);
        toTarget.subVectors(target.position, worlds[joint]!.position);
        axisWorld.copy(node.axis).applyQuaternion(worlds[joint]!.quaternion);
        let delta: number;
        if (node.type === "revolute") {
          if (toTarget.lengthSq() <= DEGENERATE_EPSILON) continue;
          if (toEffector.lengthSq() <= DEGENERATE_EPSILON) {
            // 末端与关节重合时旋转无信号:退用首子关节方向作连杆方向,避免 CCD 永久卡死。
            const child = children[joint]![0];
            if (child === undefined) continue;
            toEffector.subVectors(worlds[child]!.position, worlds[joint]!.position);
            if (toEffector.lengthSq() <= DEGENERATE_EPSILON) continue;
          }
          effectorInPlane.copy(toEffector).addScaledVector(axisWorld, -toEffector.dot(axisWorld));
          targetInPlane.copy(toTarget).addScaledVector(axisWorld, -toTarget.dot(axisWorld));
          if (effectorInPlane.lengthSq() <= DEGENERATE_EPSILON || targetInPlane.lengthSq() <= DEGENERATE_EPSILON) continue;
          cross.crossVectors(effectorInPlane, targetInPlane);
          delta = Math.atan2(cross.dot(axisWorld), effectorInPlane.dot(targetInPlane));
        } else {
          // prismatic:沿轴平移目标-末端向量的轴向分量,不依赖 toEffector 是否退化。
          delta = toTarget.dot(axisWorld) - toEffector.dot(axisWorld);
        }
        const clamped = clampToLimits(node, pose[joint]! + delta);
        if (clamped === pose[joint]) continue;
        pose[joint] = clamped;
        recomputeSubtree(joint);
      }
      residuals[targetIndex] = effectorWorldPosition(worlds, skeleton, target.effector).distanceTo(target.position);
      if (residuals[targetIndex]! > tolerance) allConverged = false;
    }
    if (allConverged) break;
  }
  return {
    pose: resolvePoseValues(skeleton, pose),
    residuals: residuals.map(residual => residual!),
    converged: residuals.map(residual => residual! <= tolerance),
  };
}

/**
 * Yoshikawa 可操作度 w = √det(JᵀJ)(J 为末端位置雅可比,列仅取末端祖先链上的自由关节):
 * 链伸直/轴线共线时趋近 0,即奇异;用于姿态搜索的避奇异罚项。
 * 链自由度超过 MAX_MANIPULABILITY_DOFS 时显式拒绝,不静默换口径。
 */
export function poseManipulability(skeleton: IKSkeleton, pose: readonly number[], effector: IKEffector): number {
  assertEffector(skeleton, effector);
  const worlds = skeletonFK(skeleton, pose);
  const effectorPosition = effectorWorldPosition(worlds, skeleton, effector);
  const columns: THREE.Vector3[] = [];
  for (const joint of chainOf(skeleton, effector.joint)) {
    const node = skeleton.nodes[joint]!;
    if (!isFreeJoint(node)) continue;
    const axisWorld = node.axis.clone().applyQuaternion(worlds[joint]!.quaternion);
    if (node.type === "revolute") {
      columns.push(axisWorld.cross(new THREE.Vector3().subVectors(effectorPosition, worlds[joint]!.position)));
    } else {
      columns.push(axisWorld);
    }
  }
  const dofs = columns.length;
  if (dofs === 0) return 0;
  if (dofs > MAX_MANIPULABILITY_DOFS) throw new Error(`链自由度 ${dofs} 超过奇异度度量上限 ${MAX_MANIPULABILITY_DOFS}`);
  // JᵀJ 对称正定(半正定);行列式用列主元高斯消元,主元取首个最大者保证确定性。
  const jtj: number[][] = [];
  for (let i = 0; i < dofs; i++) {
    jtj.push(new Array<number>(dofs).fill(0));
    for (let j = 0; j <= i; j++) {
      const entry = columns[i]!.dot(columns[j]!);
      jtj[i]![j] = entry;
      jtj[j]![i] = entry;
    }
  }
  return Math.sqrt(Math.max(determinant(jtj), 0));
}

function determinant(matrix: number[][]): number {
  const size = matrix.length;
  const work = matrix.map(row => [...row]);
  let result = 1;
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(work[row]![column]!) > Math.abs(work[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(work[pivot]![column]!) < 1e-300) return 0;
    if (pivot !== column) {
      const swapped = work[column]!;
      work[column] = work[pivot]!;
      work[pivot] = swapped;
      result = -result;
    }
    result *= work[column]![column]!;
    for (let row = column + 1; row < size; row++) {
      const factor = work[row]![column]! / work[column]![column]!;
      const targetRow = work[row]!;
      const pivotRow = work[column]!;
      for (let k = column; k < size; k++) targetRow[k] = targetRow[k]! - factor * pivotRow[k]!;
    }
  }
  return result;
}
