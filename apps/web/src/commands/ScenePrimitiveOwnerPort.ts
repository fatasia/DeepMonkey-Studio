import type { ModelTransform, PrimitiveKind, PrimitiveState, SceneMaterialState, SceneSnapshot, Vector3Value } from "@bim-studio/contracts";
import type { DeepRuntimePackage, RenderPacket, SpatialAabb } from "@bim-studio/deep-engine";
import { buildDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { SceneTransformGraph, type SceneLocalTrs, type SceneTransformFlushResult } from "@bim-studio/deep-engine/scene";
import type { SceneMaterialCommandPatch } from "@bim-studio/scene-sdk";
import { sceneSnapshotToRenderPacket } from "../delivery/sceneSnapshotRenderPacket";
import { isNeutralMaterialField } from "../delivery/sceneNeutralAppearance";
import { resolveSceneReferenceIntegrity } from "./SceneReferenceCleanupPort";

/**
 * H-C7-P3 宿主 port:object.create-primitive / object.delete-primitive 的
 * PrimitiveState 与 RuntimePackage 几何/材质所有者。
 *
 * 复用产品唯一编译路径(sceneSnapshotToRenderPacket → primitiveGeometry/primitiveMaterial
 * → buildDeepRuntimePackage);port 只持有权威 PrimitiveState 注册表与编译产物,
 * 不发明第二套几何或材质。graph 节点增删仍由 SceneGraphTransactionDriver 经
 * graph 原事务执行,port 仅镜像资源所有权并供回滚恢复。
 *
 * driver 侧消费顺序合同(保证失败可补偿):
 * - create:port.createPrimitive 成功后才允许 graph.create;graph 事务失败由 driver
 *   逆序调用 deletePrimitive 补偿。
 * - delete:driver 先 captureSubtree + 取回 PrimitiveState,再 port.deletePrimitive;
 *   回滚时 driver 逆序调用 restorePrimitive 恢复资源。
 */

export interface ScenePrimitiveOwnerCompileResult {
  readonly renderPacket: RenderPacket;
  readonly runtimePackage: DeepRuntimePackage;
}

export interface ScenePrimitiveOwnerPort {
  has(objectId: string): boolean;
  get(objectId: string): Readonly<PrimitiveState> | undefined;
  list(): readonly Readonly<PrimitiveState>[];
  /** 注册 PrimitiveState;同 id 重复抛错(fail-closed,不覆盖)。 */
  createPrimitive(primitive: PrimitiveState): void;
  /** 释放该图元的几何/材质所有权;missing 或 locked 抛错。 */
  deletePrimitive(objectId: string): void;
  /** 回滚删除:按原捕获状态恢复资源(仅当该 id 当前不存在)。 */
  restorePrimitive(primitive: Readonly<PrimitiveState>): void;
  /**
   * 标记 port 拥有的图元为宿主无法投影的触碰态:compileRuntimePackage 对已标记图元
   * fail-closed 拒绝。第二批起 driver 对 transform/visibility/parent 走投影解锁
   * (syncTransform/syncVisibility),本方法保留为宿主级防御,不在驱动主流程调用。
   */
  markNodeDiverged(objectId: string): void;
  /** 解除触碰标记(仅当确由本事务标记)。 */
  clearNodeDiverged(objectId: string): void;
  /** 该图元当前是否处于宿主触碰锁定态(逆算子捕获用)。 */
  isNodeDiverged(objectId: string): boolean;
  /**
   * 触碰解锁投影:把 graph 节点权威本地 TRS 镜像进 PrimitiveState.transform
   * (ModelTransform 为 XYZ Euler 弧度,与 sceneModelMatrixValues 同约定)。
   * 投影后该图元重新可编译;非 port 拥有抛错。
   */
  syncTransform(objectId: string, transform: ModelTransform): void;
  /** 触碰解锁投影:graph hidden 权威态镜像进 PrimitiveState.visible。 */
  syncVisibility(objectId: string, visible: boolean): void;
  /**
   * material.set 消费:把命令 patch 投影进 PrimitiveState.material。支持域与
   * 产品编译路径(primitiveMaterial)一致:color/emissive/emissiveIntensity/
   * roughness/metalness/doubleSided;中性值键按编译路径域放行为 no-op;
   * 其余键不支持——如实抛错列出键名,整批原子拒绝,不部分写入。
   */
  syncMaterial(objectId: string, patch: SceneMaterialCommandPatch): void;
  /** 逆算子回滚:整体恢复捕获的权威 PrimitiveState 与 diverged 位(id 必须已存在)。 */
  applyPrimitiveState(objectId: string, snapshot: ScenePrimitiveSnapshot): void;
  /** 图元局部包围盒(几何顶点 min/max,单位米;创建 graph 节点时消费)。 */
  localBounds(kind: PrimitiveKind): SpatialAabb | null;
  /**
   * 持久化导出:port 图元注册表 → SceneSnapshot 骨架(schemaVersion 1,primitives 深克隆;
   * models 空、相机零位 orbit——相机/引用等宿主状态由宿主各自补充,graph 层级由重开链重建)。
   */
  snapshotScene(): SceneSnapshot;
  /** 以当前权威状态重编译真实 render packet 并通过 Native 契约校验打包。 */
  compileRuntimePackage(input: { readonly packageId: string; readonly revision: number }): ScenePrimitiveOwnerCompileResult;
}

/** 逆算子捕获的 port 图元 before 态(状态 + 触碰锁位)。 */
export interface ScenePrimitiveSnapshot {
  readonly primitive: PrimitiveState;
  readonly diverged: boolean;
}

export interface ScenePrimitiveOwnerOptions {
  /** 打入 RuntimePackage 的场景身份;仅用于包内 snapshot 骨架,不参与校验语义。 */
  readonly sceneId: string;
}

const PRIMITIVE_KINDS: readonly PrimitiveKind[] = ["box", "sphere", "cylinder", "cone", "torus", "plane", "capsule"];

/** object.create-primitive 命令的稳定 PrimitiveState 投影(与浏览器主作者同语义)。 */
export function primitiveStateFromCommand(command: {
  readonly target: { readonly objectId: string };
  readonly name: string;
  readonly kind: PrimitiveKind;
  readonly color: string;
}): PrimitiveState {
  return {
    modelId: command.target.objectId,
    name: command.name,
    kind: command.kind,
    color: command.color,
    visible: true,
    opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  };
}

/** 参考实现:产品编译路径上的权威 PrimitiveState 注册表。 */
export class ScenePrimitiveOwner implements ScenePrimitiveOwnerPort {
  private readonly primitives = new Map<string, PrimitiveState>();
  private readonly diverged = new Set<string>();
  private readonly boundsCache = new Map<PrimitiveKind, SpatialAabb | null>();

  constructor(private readonly options: ScenePrimitiveOwnerOptions) {
    if (!options || typeof options !== "object" || !options.sceneId?.trim()) {
      throw new TypeError("Scene primitive owner requires a sceneId.");
    }
  }

  has(objectId: string): boolean { return this.primitives.has(objectId); }

  get(objectId: string): Readonly<PrimitiveState> | undefined { return this.primitives.get(objectId); }

  list(): readonly Readonly<PrimitiveState>[] { return [...this.primitives.values()]; }

  private requirePrimitive(objectId: string): PrimitiveState {
    const state = this.primitives.get(objectId);
    if (!state) throw new Error(`Primitive ${objectId} is not owned by the scene primitive owner.`);
    return state;
  }

  createPrimitive(primitive: PrimitiveState): void {
    assertValidPrimitive(primitive);
    if (this.primitives.has(primitive.modelId)) {
      throw new Error(`Primitive ${primitive.modelId} already exists in the scene primitive owner.`);
    }
    this.primitives.set(primitive.modelId, structuredClone(primitive));
  }

  deletePrimitive(objectId: string): void {
    const state = this.primitives.get(objectId);
    if (!state) throw new Error(`Primitive ${objectId} is not owned by the scene primitive owner.`);
    if (state.locked) throw new Error(`Primitive ${objectId} is locked; deletion requires an unlocked primitive.`);
    this.primitives.delete(objectId);
  }

  restorePrimitive(primitive: Readonly<PrimitiveState>): void {
    assertValidPrimitive(primitive);
    if (this.primitives.has(primitive.modelId)) {
      throw new Error(`Primitive ${primitive.modelId} already exists; rollback restore refused.`);
    }
    this.primitives.set(primitive.modelId, structuredClone(primitive));
  }

  markNodeDiverged(objectId: string): void {
    if (!this.primitives.has(objectId)) return;
    this.diverged.add(objectId);
  }

  clearNodeDiverged(objectId: string): void {
    this.diverged.delete(objectId);
  }

  isNodeDiverged(objectId: string): boolean {
    return this.diverged.has(objectId);
  }

  syncTransform(objectId: string, transform: ModelTransform): void {
    const state = this.requirePrimitive(objectId);
    assertFiniteTransform(objectId, transform);
    this.primitives.set(objectId, { ...state, transform: structuredClone(transform) });
    this.diverged.delete(objectId);
  }

  syncVisibility(objectId: string, visible: boolean): void {
    const state = this.requirePrimitive(objectId);
    this.primitives.set(objectId, { ...state, visible });
    this.diverged.delete(objectId);
  }

  syncMaterial(objectId: string, patch: SceneMaterialCommandPatch): void {
    const state = this.requirePrimitive(objectId);
    const applied: Record<string, unknown> = {};
    const unsupported: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (MATERIAL_SUPPORTED.has(key)) applied[key] = value;
      else if (isNeutralMaterialField(key, value)) continue; // 中性默认值:编译路径放行,无需写入。
      else unsupported.push(key);
    }
    if (unsupported.length) {
      throw new Error(`Primitive ${objectId} material.set contains fields outside the primitive compile path: ${unsupported.sort().join(", ")}.`);
    }
    if (typeof applied.color === "string" && !/^#[\da-f]{6}$/i.test(applied.color)) {
      throw new Error(`Primitive ${objectId} material color must be #RRGGBB.`);
    }
    if (typeof applied.emissive === "string" && !/^#[\da-f]{6}$/i.test(applied.emissive)) {
      throw new Error(`Primitive ${objectId} material emissive must be #RRGGBB.`);
    }
    const material = { ...(state.material ?? {}), ...applied } as SceneMaterialState;
    this.primitives.set(objectId, { ...state, material });
    this.diverged.delete(objectId);
  }

  applyPrimitiveState(objectId: string, snapshot: ScenePrimitiveSnapshot): void {
    assertValidPrimitive(snapshot.primitive);
    if (!this.primitives.has(objectId)) {
      throw new Error(`Primitive ${objectId} does not exist; rollback restore refused.`);
    }
    this.primitives.set(objectId, structuredClone(snapshot.primitive));
    if (snapshot.diverged) this.diverged.add(objectId);
    else this.diverged.delete(objectId);
  }

  localBounds(kind: PrimitiveKind): SpatialAabb | null {
    const cached = this.boundsCache.get(kind);
    if (cached !== undefined) return cached;
    // 单 kind 探针走同一产品编译路径,复用 geometryResource 的顶点语义,不复制几何。
    const packet = sceneSnapshotToRenderPacket(minimalSnapshot(this.options.sceneId, [{
      modelId: `bounds-probe:${kind}`, name: `bounds-probe-${kind}`, kind, color: "#000000",
      visible: true, opacity: 1, transform: {
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      },
    }]));
    const geometry = packet.geometries.find(entry => entry.id === `primitive:${kind}`);
    let bounds: SpatialAabb | null = null;
    if (geometry) {
      const vertices = geometry.vertices;
      const min: [number, number, number] = [Infinity, Infinity, Infinity];
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (let index = 0; index < vertices.length; index += 6) {
        for (let axis = 0; axis < 3; axis += 1) {
          const value = vertices[index + axis]!;
          if (value < min[axis]!) min[axis] = value;
          if (value > max[axis]!) max[axis] = value;
        }
      }
      bounds = { min, max };
    }
    this.boundsCache.set(kind, bounds);
    return bounds;
  }

  snapshotScene(): SceneSnapshot {
    return {
      schemaVersion: 1 as const,
      id: this.options.sceneId,
      projectId: this.options.sceneId,
      name: this.options.sceneId,
      camera: { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" as const },
      models: [] as [],
      primitives: this.list().map(primitive => structuredClone(primitive)),
      measurements: [] as [],
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
    };
  }

  compileRuntimePackage(input: { readonly packageId: string; readonly revision: number }): ScenePrimitiveOwnerCompileResult {
    if (this.diverged.size) {
      throw new Error(`RuntimePackage recompile refused; port-owned primitives were touched by unsupported commands: ${[...this.diverged].sort().join(", ")}.`);
    }
    const renderPacket = sceneSnapshotToRenderPacket(minimalSnapshot(this.options.sceneId, this.primitives.values()));
    // v1 包最小输入:renderPacket + 内置默认 IBL(environment 缺省)。走完整
    // Native 契约校验、资源内容哈希与包哈希,与产品发布同一打包路径。
    const runtimePackage = buildDeepRuntimePackage({
      packageId: input.packageId,
      // Native 契约要求 semver;revision 编入 patch 位,同状态重编译可复现。
      packageVersion: `1.${Math.floor(input.revision / 65536) % 65536}.${input.revision % 65536}`,
      renderPacket: { id: "scene.render", revision: input.revision, value: renderPacket },
    });
    return { renderPacket, runtimePackage };
  }
}

function assertValidPrimitive(primitive: PrimitiveState): void {
  if (!primitive || typeof primitive !== "object") throw new TypeError("Primitive state must be an object.");
  if (typeof primitive.modelId !== "string" || !primitive.modelId.trim()) throw new TypeError("Primitive modelId is required.");
  if (!PRIMITIVE_KINDS.includes(primitive.kind)) throw new TypeError(`Unknown primitive kind: ${String(primitive.kind)}.`);
  if (typeof primitive.color !== "string" || !/^#[\da-f]{6}$/i.test(primitive.color)) {
    throw new TypeError(`Primitive ${primitive.modelId} color must be #RRGGBB.`);
  }
}

/** material.set 可投影子集 = SceneMaterialCommandPatch ∩ primitiveMaterial 编译支持域(逐键核对,不靠记忆)。 */
const MATERIAL_SUPPORTED: ReadonlySet<string> = new Set(["color", "emissive", "emissiveIntensity", "roughness", "metalness", "doubleSided"]);

/** graph 四元数 → XYZ Euler 弧度(three.js setFromQuaternion "XYZ" 算法,与 eulerXyzQuaternion 精确互逆)。 */
function quaternionToEulerXyz(rotation: readonly [number, number, number, number]): Vector3Value {
  const [qx, qy, qz, qw] = rotation;
  // makeRotationFromQuaternion 的元素(按 three.js m<row><col> 记号)。
  const m11 = 1 - 2 * (qy * qy + qz * qz), m12 = 2 * (qx * qy - qw * qz), m13 = 2 * (qx * qz + qw * qy);
  const m22 = 1 - 2 * (qx * qx + qz * qz), m23 = 2 * (qy * qz - qw * qx);
  const m32 = 2 * (qy * qz + qw * qx), m33 = 1 - 2 * (qx * qx + qy * qy);
  const clamp = (value: number) => Math.min(1, Math.max(-1, value));
  const sy = clamp(m13);
  const y = Math.asin(sy);
  // 万向锁分支与 three.js 相同:|m13| 贴近 1 时 z 归 0,由 x 承担剩余旋转。
  const x = Math.abs(sy) < 0.9999999 ? Math.atan2(-m23, m33) : Math.atan2(m32, m22);
  const z = Math.abs(sy) < 0.9999999 ? Math.atan2(-m12, m11) : 0;
  return { x, y, z };
}

/**
 * graph 权威本地变换 → PrimitiveState.transform 投影。TRS 直接镜像;matrix kind
 * (如 keepWorld reparent 的产物)按 T*R*S 语义精确分解(three.js decompose 约定),
 * 重组守卫保证分解可无损还原,含 skew/奇异的矩阵如实拒绝,不做静默近似。
 * 与 sceneModelMatrixValues / SceneMutationGateway.eulerXyzQuaternion 同一 XYZ 约定。
 */
export function modelTransformFromSceneLocal(transform: SceneLocalTrs | { readonly kind: "matrix"; readonly matrix: readonly number[] }): ModelTransform {
  if (transform.kind === "trs") {
    return {
      position: { x: transform.translation[0], y: transform.translation[1], z: transform.translation[2] },
      rotation: quaternionToEulerXyz(transform.rotation),
      scale: { x: transform.scale[0], y: transform.scale[1], z: transform.scale[2] },
    };
  }
  return modelTransformFromMatrix(transform.matrix);
}

function modelTransformFromMatrix(m: readonly number[]): ModelTransform {
  // 列主序 T*R*S:平移在第 4 列,前三列长度为 |缩放|,列归一后为旋转矩阵。
  const columnLength = (offset: number) => Math.hypot(m[offset]!, m[offset + 1]!, m[offset + 2]!);
  const determinant = m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[4]! * (m[1]! * m[10]! - m[2]! * m[9]!)
    + m[8]! * (m[1]! * m[6]! - m[2]! * m[5]!);
  const c0 = [m[0]!, m[1]!, m[2]!] as [number, number, number];
  let sx = columnLength(0);
  if (determinant < 0) { sx = -sx; c0[0] = -c0[0]; c0[1] = -c0[1]; c0[2] = -c0[2]; }
  const sy = columnLength(4), sz = columnLength(8);
  if (!sx || !sy || !sz || !Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz)) {
    throw new Error("Scene matrix has a singular scale axis; primitive projection refused (fail-closed).");
  }
  // Shepperd 分支(three.js Quaternion.setFromRotationMatrix 同式),列归一后取四元数。
  const r00 = c0[0] / sx, r10 = c0[1] / sx, r20 = c0[2] / sx;
  const r01 = m[4]! / sy, r11 = m[5]! / sy, r21 = m[6]! / sy;
  const r02 = m[8]! / sz, r12 = m[9]! / sz, r22 = m[10]! / sz;
  const trace = r00 + r11 + r22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s; x = (r21 - r12) * s; y = (r02 - r20) * s; z = (r10 - r01) * s;
  } else if (r00 > r11 && r00 > r22) {
    const s = 2 * Math.sqrt(1 + r00 - r11 - r22);
    w = (r21 - r12) / s; x = 0.25 * s; y = (r01 + r10) / s; z = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = 2 * Math.sqrt(1 + r11 - r00 - r22);
    w = (r02 - r20) / s; x = (r01 + r10) / s; y = 0.25 * s; z = (r12 + r21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + r22 - r00 - r11);
    w = (r10 - r01) / s; x = (r02 + r20) / s; y = (r12 + r21) / s; z = 0.25 * s;
  }
  const quaternion: [number, number, number, number] = [x, y, z, w];
  const transform: ModelTransform = {
    position: { x: m[12]!, y: m[13]!, z: m[14]! },
    rotation: quaternionToEulerXyz(quaternion),
    scale: { x: sx, y: sy, z: sz },
  };
  assertMatrixRoundTrip(m, transform, Math.max(1, Math.abs(sx), Math.abs(sy), Math.abs(sz)));
  return transform;
}

/** XYZ Euler 弧度 → 四元数(deep-engine eulerXyzQuaternion 同式;与 quaternionToEulerXyz 同一约定互逆)。 */
export function eulerXyzToQuaternion({ x, y, z }: Vector3Value): [number, number, number, number] {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}

/** PrimitiveState.transform(ModelTransform)→ graph 权威本地 TRS(重开水合用;与 modelTransformFromSceneLocal 同一 XYZ 约定互逆)。 */
export function sceneLocalFromModelTransform(transform: ModelTransform): SceneLocalTrs {
  return {
    kind: "trs",
    translation: [transform.position.x, transform.position.y, transform.position.z],
    rotation: eulerXyzToQuaternion(transform.rotation),
    scale: [transform.scale.x, transform.scale.y, transform.scale.z],
  };
}

export interface SceneReopenResult {
  readonly owner: ScenePrimitiveOwner;
  readonly graph: SceneTransformGraph<string>;
  /** 水合源快照(selectionSets/rootLayerOrder 等宿主引用容器随快照持久化,重开链据此接回清理 port)。 */
  readonly snapshot: SceneSnapshot;
  /** 水合首次 flush(全部节点的权威世界态):宿主据此重建空间索引等 flush 投影(撤销重开同用)。 */
  readonly flush: SceneTransformFlushResult<string>;
}

/**
 * 保存重开水合:SceneSnapshot.primitives → 新 owner 注册表 + graph 节点。
 * 权威本地 TRS 经 sceneLocalFromModelTransform 重建,hidden=!visible 按捕获态补 update,
 * localBounds 走同一产品编译路径;schemaVersion 非 1 如实拒绝(fail-closed)。
 *
 * 引用解析门(本批):快照携带 animation/simulationEntities 时,加载即把文档级引用
 * 逐条解析到运行时资源(port 图元注册表)——对象引用悬空、状态机内部引用悬空、
 * clip 事件标记 clipId 悬空、仿真实体形状不可识别,都以显式错误码
 * (SceneReferenceResolutionError)拒绝重开,不静默丢弃(见 resolveSceneReferenceIntegrity;
 * 状态机环形转移为合法语义,解析遍历带 visited 集防护)。
 */
export function restoreSceneFromSnapshot(input: {
  readonly snapshot: SceneSnapshot;
  readonly sceneId: string;
}): SceneReopenResult {
  if (input.snapshot.schemaVersion !== 1) {
    throw new Error(`Scene snapshot schemaVersion ${input.snapshot.schemaVersion} is not supported; reopen refused (fail-closed).`);
  }
  const owner = new ScenePrimitiveOwner({ sceneId: input.sceneId });
  const graph = new SceneTransformGraph<string>();
  for (const primitive of input.snapshot.primitives) {
    owner.createPrimitive(structuredClone(primitive));
    const bounds = owner.localBounds(primitive.kind);
    if (!bounds) throw new Error(`Primitive kind ${primitive.kind} has no compiled geometry; reopen refused.`);
    graph.create({ id: primitive.modelId, localTransform: sceneLocalFromModelTransform(primitive.transform), localBounds: bounds });
    if (!primitive.visible) graph.update(primitive.modelId, { hidden: true });
  }
  if (input.snapshot.animation || input.snapshot.simulationEntities) {
    resolveSceneReferenceIntegrity({
      ...(input.snapshot.animation ? { animation: input.snapshot.animation } : {}),
      ...(input.snapshot.simulationEntities ? { simulationEntities: input.snapshot.simulationEntities } : {}),
      isKnownObject: objectId => owner.has(objectId),
    });
  }
  const flush = graph.flush();
  return { owner, graph, snapshot: input.snapshot, flush };
}

/** 重组守卫:按产品路径(Euler→四元数→T*R*S)重建矩阵并与源比对,超出 f64 噪声即拒绝。 */
function assertMatrixRoundTrip(source: readonly number[], transform: ModelTransform, magnitude: number): void {
  const { position: p, scale: s } = transform;
  const [qx, qy, qz, qw] = eulerXyzToQuaternion(transform.rotation);
  const recomposed = [
    (1 - 2 * (qy * qy + qz * qz)) * s.x, (2 * (qx * qy + qw * qz)) * s.x, (2 * (qx * qz - qw * qy)) * s.x, 0,
    (2 * (qx * qy - qw * qz)) * s.y, (1 - 2 * (qx * qx + qz * qz)) * s.y, (2 * (qy * qz + qw * qx)) * s.y, 0,
    (2 * (qx * qz + qw * qy)) * s.z, (2 * (qy * qz - qw * qx)) * s.z, (1 - 2 * (qx * qx + qy * qy)) * s.z, 0,
    p.x, p.y, p.z, 1,
  ];
  const tolerance = 1e-9 * magnitude;
  for (let index = 0; index < 16; index += 1) {
    if (Math.abs(recomposed[index]! - source[index]!) > tolerance) {
      throw new Error(`Scene matrix is not a T*R*S transform (entry ${index} drifts beyond ${tolerance}); primitive projection refused (fail-closed).`);
    }
  }
}

function assertFiniteTransform(objectId: string, transform: ModelTransform): void {
  for (const vector of [transform.position, transform.rotation, transform.scale]) {
    for (const value of [vector.x, vector.y, vector.z]) {
      if (!Number.isFinite(value)) throw new Error(`Primitive ${objectId} transform contains a non-finite value.`);
    }
  }
}

/** sceneSnapshotToRenderPacket 仅消费 models/primitives;骨架沿 sceneViewerDynamicPlayback 的 {...scene, models: []} 形态。 */
function minimalSnapshot(sceneId: string, primitives: Iterable<PrimitiveState>) {
  return {
    schemaVersion: 1 as const,
    id: sceneId,
    projectId: sceneId,
    name: sceneId,
    camera: { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" as const },
    models: [] as [],
    primitives: [...primitives],
    measurements: [] as [],
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}
