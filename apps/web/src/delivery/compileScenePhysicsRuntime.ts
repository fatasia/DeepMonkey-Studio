import type { SceneSnapshot, ScenePhysicsColliderState, SceneSoftBodyState, SceneClothState,
  SceneClothWindState, SceneTetraSoftBodyState, Vector3Value } from "@bim-studio/contracts";
import type { DynamicPhysicsRuntime } from "@bim-studio/deep-engine/runtime-package";
// F6 遗留切片:预算常量单一定义在引擎软体会话侧,译层直接复用,不复制数值
// (delivery 域值导入 deep-engine 子路径有 packNativeProbeGridRecords 先例)。
import { SOFT_BODY_BUDGETS } from "@bim-studio/deep-engine/physics";
import { worldToLocal, type SceneCoordinate } from "./sceneLocalCoordinates";
import type { SceneRenderCompilation } from "./compileSceneRenderPacket";

/** F6 软体运行包载荷:运行包合同未从 index 导出具名符号(禁碰 deep-engine),
 * 按 G1-S2 静态薄代理先例经已导出的 DynamicPhysicsRuntime 结构派生。 */
type SoftBodiesPayload = NonNullable<DynamicPhysicsRuntime["softBodies"]>;
type SoftBodyPayload = SoftBodiesPayload[number];

export interface CompileScenePhysicsRuntimeOptions {
  readonly objectBindings: SceneRenderCompilation["objectBindings"];
  readonly coordinateOrigin: Vector3Value;
}

/** Compiles authored rigid bodies into deterministic commands whose colliders
 * are resolved from the already-frozen render packet rather than editor state.
 * kinematic 刚体保留作者位姿作为 Native 的初始位姿（Native 不消费角色控制器，见 B3-b 边界）。
 * 作者 collider（T17 来源规范）按判别联合下译：凸包/简化网格几何位于刚体局部空间，
 * 必须携带精度标记；省略 collider 时保持 render-bounds 现状。 */
export function compileScenePhysicsRuntime(
  scene: SceneSnapshot,
  options: CompileScenePhysicsRuntimeOptions,
): DynamicPhysicsRuntime | undefined {
  if (!scene.physics?.enabled) return;
  const bindings = new Map(options.objectBindings.map(binding => [binding.nodeId, binding.instanceIds]));
  const bodies = [...scene.models, ...scene.primitives]
    .filter(item => item.physics !== undefined && item.physics.type !== "none")
    .map(item => {
      const state = item.physics!;
      if (state.type !== "fixed" && state.type !== "dynamic" && state.type !== "kinematic") {
        throw new Error(`物理对象 ${item.modelId} 的刚体类型不受支持`);
      }
      const instanceIds = [...(bindings.get(item.modelId) ?? [])].sort(compare);
      if (!instanceIds.length) throw new Error(`物理对象 ${item.modelId} 没有可用于碰撞体的运行实例`);
      if (!Number.isFinite(state.mass) || state.mass <= 0 || !Number.isFinite(state.friction)
        || state.friction < 0 || state.friction > 2 || !Number.isFinite(state.restitution)
        || state.restitution < 0 || state.restitution > 1) {
        throw new Error(`物理对象 ${item.modelId} 的质量或碰撞系数无效`);
      }
      // 角色控制器只有 kinematic 刚体能承载；其他类型带该字段说明作者数据自相矛盾。
      if (state.character && state.type !== "kinematic") {
        throw new Error(`物理对象 ${item.modelId} 的角色控制器要求 kinematic 刚体`);
      }
      // F6:sdf-grid 凹体碰撞只允许 fixed 刚体(trimesh 承载凹体,dynamic/kinematic
      // 非凸不可稳定求解,与运行包解析层同判;提前给出作者侧原因而非解析层泛化报错)。
      if (state.collider?.kind === "sdf-grid" && state.type !== "fixed") {
        throw new Error(`物理对象 ${item.modelId} 的 sdf-grid collider 要求 fixed 刚体`);
      }
      if (state.initialLinearVelocity && (state.type !== "dynamic"
        || !Object.values(state.initialLinearVelocity).every(value => Number.isFinite(value) && Math.abs(value) <= 1_000))) {
        throw new Error(`物理对象 ${item.modelId} 的初速度要求 dynamic 且各轴在 ±1000 m/s 内`);
      }
      const collider = compileCollider(state.collider, item.modelId, instanceIds);
      return { id: item.modelId, type: state.type as "fixed" | "dynamic" | "kinematic",
        initialPose: { translation: vector(item.transform.position), rotation: quaternion(item.transform.rotation) }, mass: state.mass,
        friction: state.friction, restitution: state.restitution,
        ...(state.character ? { character: cloneCharacter(state.character) } : {}),
        ...(state.initialLinearVelocity ? { initialLinearVelocity: vector(state.initialLinearVelocity) } : {}),
        collider };
    }).sort((left, right) => compare(left.id, right.id));
  // F6 遗留切片:作者软体/布料意图 → 运行包 softBodies 通道(opt-in 语义见
  // compileSoftBodies 头注:作者合同字段在场即激活,缺省零行为变化)。
  const softBodies = compileSoftBodies(scene.physics.softBodies, options.coordinateOrigin);
  if (!bodies.length) {
    throw new Error(softBodies.length
      ? "已启用物理场景但没有可编译的刚体;软体通道要求与至少一个可编译刚体并存(运行包物理合同 bodies 非空)"
      : "已启用物理场景但没有可编译的刚体");
  }
  const bodyIds = new Set(bodies.map(body => body.id));
  const joints = [...(scene.physics.joints ?? [])].map(joint => {
    if (joint.kind !== "revolute" && joint.kind !== "prismatic") {
      throw new Error(`关节 ${joint.id} 的类型不受 Native 运行包支持`);
    }
    const solver = joint.solver ?? "impulse";
    if (joint.kind === "prismatic" && solver !== "impulse") {
      throw new Error(`关节 ${joint.id} 的 prismatic 仅支持 impulse 求解器`);
    }
    if (!bodyIds.has(joint.bodyId) || joint.connectedBodyId && !bodyIds.has(joint.connectedBodyId)) {
      throw new Error(`关节 ${joint.id} 引用了未编译的刚体`);
    }
    if (joint.connectedBodyId === joint.bodyId) throw new Error(`关节 ${joint.id} 不能连接同一刚体`);
    // T17 位置伺服:multibody 拒绝、motor.enabled 是总开关;gain fail-closed(零刚度伺服无意义,damping 非负)。
    const position = joint.motor.position;
    if (position && (position.enabled && (solver === "multibody" || !joint.motor.enabled)
      || !Number.isFinite(position.target) || !Number.isFinite(position.stiffness) || position.stiffness <= 0
      || !Number.isFinite(position.damping) || position.damping < 0)) {
      throw new Error(`关节 ${joint.id} 的位置伺服参数无效`);
    }
    if (solver === "multibody" && (joint.limits.enabled || joint.motor.enabled)) {
      throw new Error(`关节 ${joint.id} 的 multibody 限位或马达尚不受支持`);
    }
    return { ...joint, solver, connectedBodyId: joint.connectedBodyId ?? null,
      worldAnchor: [joint.worldAnchor.x - options.coordinateOrigin.x, joint.worldAnchor.y - options.coordinateOrigin.y,
        joint.worldAnchor.z - options.coordinateOrigin.z] as const,
      localAnchor: vector(joint.localAnchor), axis: vector(joint.axis) };
  }).sort((left, right) => compare(left.id, right.id));
  // T17 齿轮耦合:driver/follower 必须是既有 impulse 同类关节;ratio 非零、gain 有效。
  const jointById = new Map(joints.map(joint => [joint.id, joint] as const));
  const gears = [...(scene.physics.gears ?? [])].map(gear => {
    const driver = jointById.get(gear.driverJointId), follower = jointById.get(gear.followerJointId);
    if (!driver || !follower || gear.driverJointId === gear.followerJointId
      || driver.kind !== follower.kind || driver.solver !== "impulse" || follower.solver !== "impulse"
      || !Number.isFinite(gear.ratio) || gear.ratio === 0
      || !Number.isFinite(gear.stiffness) || gear.stiffness <= 0
      || !Number.isFinite(gear.damping) || gear.damping < 0) {
      throw new Error(`齿轮耦合 ${gear.id} 引用了无效或不匹配的关节`);
    }
    return { id: gear.id, driverJointId: gear.driverJointId, followerJointId: gear.followerJointId,
      ratio: gear.ratio, stiffness: gear.stiffness, damping: gear.damping };
  }).sort((left, right) => compare(left.id, right.id));
  return { schema: "deep-engine.physics-runtime", schemaVersion: 1, enabled: true,
    playing: scene.physics.playing, gravity: vector(scene.physics.gravity), bodies, joints,
    ...(gears.length ? { gears } : {}),
    ...(softBodies.length ? { softBodies } : {}) };
}

/** 作者 collider → 运行包判别联合;fail-closed:几何缺失/越界/generated 缺精度标记一律拒绝。 */
function compileCollider(
  state: ScenePhysicsColliderState | undefined,
  modelId: string,
  instanceIds: readonly string[],
): DynamicPhysicsRuntime["bodies"][number]["collider"] {
  const precision = state?.precision === undefined ? undefined : {
    ...(state.precision.approximate === undefined ? {} : { approximate: state.precision.approximate }),
    ...(state.precision.reasons === undefined ? {} : { reasons: [...state.precision.reasons] }),
    ...(state.precision.tolerance === undefined ? {} : { tolerance: state.precision.tolerance }),
    ...(state.precision.hullVertexCount === undefined ? {} : { hullVertexCount: state.precision.hullVertexCount }),
    ...(state.precision.triangleCount === undefined ? {} : { triangleCount: state.precision.triangleCount }),
    ...(state.precision.topologyOk === undefined ? {} : { topologyOk: state.precision.topologyOk }),
    ...(state.precision.topologyIssueCodes === undefined ? {} : { topologyIssueCodes: [...state.precision.topologyIssueCodes] }),
    ...(state.precision.concaveSource === undefined ? {} : { concaveSource: state.precision.concaveSource }),
  };
  if (state === undefined || state.kind === "render-bounds") {
    return { kind: "render-bounds", instanceIds, ...(precision ? { precision } : {}) };
  }
  if (state.kind === "convex-hull") {
    const points = (state.points ?? []).map(point => vector(point));
    if (points.length < 4 || !points.every(point => point.every(Number.isFinite))) {
      throw new Error(`物理对象 ${modelId} 的凸包 collider 至少需要 4 个有限顶点`);
    }
    if (!precision) throw new Error(`物理对象 ${modelId} 的凸包 collider 缺少精度标记`);
    return { kind: "convex-hull", instanceIds, points, precision };
  }
  if (state.kind === "simplified-mesh") {
    const positions = (state.positions ?? []).map(point => vector(point));
    const indices = state.indices ?? [];
    if (positions.length < 3 || !positions.every(point => point.every(Number.isFinite))
      || indices.length < 3 || indices.length % 3 !== 0
      || !indices.every(index => Number.isInteger(index) && index >= 0 && index < positions.length)) {
      throw new Error(`物理对象 ${modelId} 的简化网格 collider 几何无效`);
    }
    if (!precision) throw new Error(`物理对象 ${modelId} 的简化网格 collider 缺少精度标记`);
    return { kind: "simplified-mesh", instanceIds, positions, indices: [...indices], precision };
  }
  // F6:sdf-grid 凹体碰撞载荷下译。网格坐标系 = 刚体局部系(与 convex-hull/
  // simplified-mesh 几何同口径,不随发布坐标原点平移——刚体整体平移在局部系中消去);
  // 非固定刚体在体映射处已拒绝(见主函数)。域校验与运行包解析层同源 fail-closed:
  // 每维 2..128、cells ≤ 262144、cellSize ∈ (0,1e6]、distances 填满且有限、precision 必带。
  if (state.kind === "sdf-grid") {
    const sdf = state.sdfGrid;
    if (!sdf) throw new Error(`物理对象 ${modelId} 的 sdf-grid collider 缺少体素场载荷`);
    if (!precision) throw new Error(`物理对象 ${modelId} 的 sdf-grid collider 缺少精度标记`);
    const dimensions = [sdf.dimensions.x, sdf.dimensions.y, sdf.dimensions.z] as const;
    const cells = dimensions[0] * dimensions[1] * dimensions[2];
    if (!dimensions.every(value => Number.isSafeInteger(value) && value >= 2 && value <= 128)
      || cells > 262_144) {
      throw new Error(`物理对象 ${modelId} 的 sdf-grid 尺寸必须是每维 2..128 且总数 ≤262144,实测 ${dimensions.join("×")}`);
    }
    if (!Number.isFinite(sdf.cellSize) || sdf.cellSize <= 0 || sdf.cellSize > 1e6) {
      throw new Error(`物理对象 ${modelId} 的 sdf-grid cellSize 必须在 (0, 1e6] 米,实测 ${sdf.cellSize}`);
    }
    if (![sdf.origin.x, sdf.origin.y, sdf.origin.z].every(Number.isFinite)) {
      throw new Error(`物理对象 ${modelId} 的 sdf-grid origin 必须为有限数值(刚体局部系)`);
    }
    if (sdf.distances.length !== cells || !sdf.distances.every(Number.isFinite)) {
      throw new Error(`物理对象 ${modelId} 的 sdf-grid distances 必须填满 ${cells} 个网格且全部有限,实测 ${sdf.distances.length}`);
    }
    return { kind: "sdf-grid", instanceIds,
      sdf: { origin: vector(sdf.origin), cellSize: sdf.cellSize, dimensions: [...dimensions], distances: [...sdf.distances] },
      precision };
  }
  const primitive = state.primitive;
  if (!primitive) throw new Error(`物理对象 ${modelId} 的 primitive collider 缺少显式几何`);
  if (primitive.shape === "cuboid") {
    const halfExtents = primitive.halfExtents;
    if (!halfExtents || ![halfExtents.x, halfExtents.y, halfExtents.z].every(value => Number.isFinite(value) && value > 0)) {
      throw new Error(`物理对象 ${modelId} 的 cuboid collider 需要正的半尺寸`);
    }
    return { kind: "primitive", instanceIds, primitive: { shape: "cuboid", halfExtents: vector(halfExtents) }, ...(precision ? { precision } : {}) };
  }
  if (primitive.shape === "sphere") {
    if (!Number.isFinite(primitive.radius) || (primitive.radius ?? 0) <= 0) {
      throw new Error(`物理对象 ${modelId} 的 sphere collider 需要正半径`);
    }
    return { kind: "primitive", instanceIds, primitive: { shape: "sphere", radius: primitive.radius! }, ...(precision ? { precision } : {}) };
  }
  if (!Number.isFinite(primitive.radius) || (primitive.radius ?? 0) <= 0
    || !Number.isFinite(primitive.halfHeight) || (primitive.halfHeight ?? 0) <= 0) {
    throw new Error(`物理对象 ${modelId} 的 cylinder collider 需要正半径与半高`);
  }
  return { kind: "primitive", instanceIds, primitive: { shape: "cylinder", radius: primitive.radius!, halfHeight: primitive.halfHeight! }, ...(precision ? { precision } : {}) };
}

/**
 * F6 遗留切片:作者布料/软体意图 → 运行包 softBodies 通道载荷(逐字段映射)。
 *
 * opt-in 语义(选型理由):沿用**作者合同字段**而非 t25/b4/g1 的 URL 开关。
 * 那些 URL 开关是查看器渲染技术的激活闸(bake/staging 注入、GPU pass 计时),
 * 作用于装载/渲染期能力,不改发布包内容;而 softBodies 是发布包 physics 通道的
 * 数据载荷,必须在发布编译期定型——作者编写 `physics.softBodies` 即选择加入,
 * 与 joints/gears 的作者合同同构;同一场景恒产出同一包字节(URL 开关会让包内容
 * 取决于发布者浏览器 URL,破坏 sourceSemanticHash → targetArtifactHash 确定性链)。
 * 缺省(无字段/空数组)输出对象不写该键 → legacy 场景包逐位不变(默认关闭零行为)。
 *
 * fail-closed:任何非法作者值拒绝整包并给原因(实测/上限入错消息);预算护栏
 * (数量/单体粒子/四面体/总粒子/substeps)常量复用引擎 SOFT_BODY_BUDGETS 单一定义,
 * 与运行包解析层(parseSoftBodies)和软体会话(softBodyRuntimeHost)同源。
 * 世界系字段(origin/positions/groundY)按发布坐标原点局部化,与刚体 initialPose
 * (经 localizeSceneCoordinates)和关节 worldAnchor(本文件平移)同口径;点数据走
 * worldToLocal(有限/Float32 剖面/往返校验),标量平面 groundY 沿用关节先例做
 * 平移 + 有限校验。
 */
function compileSoftBodies(
  authored: readonly SceneSoftBodyState[] | undefined,
  coordinateOrigin: Vector3Value,
): SoftBodiesPayload {
  if (!authored?.length) return [];
  if (authored.length > SOFT_BODY_BUDGETS.maxBodies) {
    throw new Error(`软体数量 ${authored.length} 超出预算 ${SOFT_BODY_BUDGETS.maxBodies}`);
  }
  const origin: SceneCoordinate = {
    x: coordinateOrigin.x, y: coordinateOrigin.y, z: coordinateOrigin.z,
  };
  const bodies = authored.map(body => {
    if (body.kind === "cloth") return compileCloth(body, origin);
    if (body.kind === "soft-body") return compileTetraSoftBody(body, origin);
    throw new Error(`软体 ${(body as { id?: string }).id ?? "?"} 的类型不受运行包支持(仅 cloth / soft-body)`);
  }).sort((left, right) => compare(left.id, right.id));
  // 运行包合同要求软体按 id 字典序;排序后重复 id 无法分辨,必须在译层显式拒绝。
  const ids = new Set(bodies.map(body => body.id));
  if (ids.size !== bodies.length) {
    throw new Error(`软体 id 必须唯一,实测 ${bodies.length} 条记录只有 ${ids.size} 个不同 id`);
  }
  const totalParticles = bodies.reduce((sum, body) =>
    sum + (body.kind === "cloth" ? body.columns * body.rows : body.positions.length), 0);
  if (totalParticles > SOFT_BODY_BUDGETS.maxTotalParticles) {
    throw new Error(`软体粒子总量 ${totalParticles} 超出预算 ${SOFT_BODY_BUDGETS.maxTotalParticles}`);
  }
  return bodies;
}

/** 布料作者态 → 运行包 cloth 载荷;参数域与运行包解析层/布料求解器逐项对齐。 */
function compileCloth(state: SceneClothState, origin: SceneCoordinate): SoftBodyPayload {
  if (!Number.isSafeInteger(state.columns) || state.columns < 2 || state.columns > 4096) {
    throw new Error(`布料 ${state.id} 的 columns 必须是 2..4096 的整数,实测 ${state.columns}`);
  }
  if (!Number.isSafeInteger(state.rows) || state.rows < 2 || state.rows > 4096) {
    throw new Error(`布料 ${state.id} 的 rows 必须是 2..4096 的整数,实测 ${state.rows}`);
  }
  const particles = state.columns * state.rows;
  if (particles > SOFT_BODY_BUDGETS.maxParticlesPerBody) {
    throw new Error(`布料 ${state.id} 粒子数 ${particles} 超出单体贴算 ${SOFT_BODY_BUDGETS.maxParticlesPerBody}`);
  }
  const common = commonSoftBodyFields(state, "布料");
  const spacing = boundedMetre(state.spacing, `布料 ${state.id} 的 spacing`);
  const compliance = nonNegativeFinite(state.compliance, `布料 ${state.id} 的 compliance`);
  const perturbation = nonNegativeFinite(state.perturbation, `布料 ${state.id} 的 perturbation`);
  const seed = int32(state.seed, `布料 ${state.id} 的 seed`);
  const localizedOrigin = worldToLocal(state.origin, origin, `软体 ${state.id}.origin`);
  const pinned = compilePinned(state.pinned, particles, `布料 ${state.id}`);
  const wind = state.wind === undefined ? undefined : compileClothWind(state.wind, `布料 ${state.id}`);
  return {
    kind: "cloth", id: state.id, mass: common.mass, damping: common.damping, substeps: common.substeps,
    pinned, columns: state.columns, rows: state.rows, spacing, compliance, perturbation, seed,
    origin: [localizedOrigin.x, localizedOrigin.y, localizedOrigin.z],
    ...(common.groundY === undefined ? {} : { groundY: localizeScalarY(common.groundY, origin, `软体 ${state.id}.groundY`) }),
    ...(wind === undefined ? {} : { wind }),
  };
}

/** 四面体软体作者态 → 运行包 soft-body 载荷;顶点走世界系局部化,四面体索引域收紧。 */
function compileTetraSoftBody(state: SceneTetraSoftBodyState, origin: SceneCoordinate): SoftBodyPayload {
  if (state.positions.length < 4) {
    throw new Error(`软体 ${state.id} 至少需要 4 个顶点,实测 ${state.positions.length}`);
  }
  if (state.positions.length > SOFT_BODY_BUDGETS.maxParticlesPerBody) {
    throw new Error(`软体 ${state.id} 粒子数 ${state.positions.length} 超出单体贴算 ${SOFT_BODY_BUDGETS.maxParticlesPerBody}`);
  }
  const positions = state.positions.map((point, index) =>
    worldToLocal(point, origin, `软体 ${state.id}.positions[${index}]`))
    .map(point => [point.x, point.y, point.z] as const);
  if (!Number.isSafeInteger(state.tets.length) || state.tets.length < 1) {
    throw new Error(`软体 ${state.id} 至少需要 1 个四面体,实测 ${state.tets.length}`);
  }
  if (state.tets.length > SOFT_BODY_BUDGETS.maxTetsPerBody) {
    throw new Error(`软体 ${state.id} 四面体数 ${state.tets.length} 超出预算 ${SOFT_BODY_BUDGETS.maxTetsPerBody}`);
  }
  const tets = state.tets.map((tet, index) => {
    if (tet.length !== 4
      || !tet.every(vertex => Number.isSafeInteger(vertex) && vertex >= 0 && vertex < positions.length)
      || new Set(tet).size !== 4) {
      throw new Error(`软体 ${state.id} 的四面体[${index}] 必须引用 4 个互异顶点索引(0..${positions.length - 1})`);
    }
    return [tet[0], tet[1], tet[2], tet[3]] as const;
  });
  const common = commonSoftBodyFields(state, "软体");
  const complianceDistance = nonNegativeFinite(state.complianceDistance, `软体 ${state.id} 的 complianceDistance`);
  const complianceVolume = nonNegativeFinite(state.complianceVolume, `软体 ${state.id} 的 complianceVolume`);
  const pinned = compilePinned(state.pinned, positions.length, `软体 ${state.id}`);
  return {
    kind: "soft-body", id: state.id, mass: common.mass, damping: common.damping, substeps: common.substeps,
    pinned, positions, tets, complianceDistance, complianceVolume,
    ...(common.groundY === undefined ? {} : { groundY: localizeScalarY(common.groundY, origin, `软体 ${state.id}.groundY`) }),
  };
}

/** 软体公共标量参数(质量/阻尼/子步/地面),域与运行包 commonSoftBodyFields 同源。 */
function commonSoftBodyFields(
  state: Pick<SceneClothState | SceneTetraSoftBodyState, "id" | "mass" | "damping" | "substeps" | "groundY">,
  label: string,
): { mass: number; damping: number; substeps: number; groundY?: number } {
  if (!Number.isFinite(state.mass) || state.mass <= 0) {
    throw new Error(`${label} ${state.id} 的质量必须是正有限数,实测 ${state.mass}`);
  }
  if (!Number.isFinite(state.damping) || state.damping < 0 || state.damping >= 1) {
    throw new Error(`${label} ${state.id} 的 damping 必须在 [0,1),实测 ${state.damping}`);
  }
  if (!Number.isSafeInteger(state.substeps) || state.substeps < 1 || state.substeps > SOFT_BODY_BUDGETS.maxSubsteps) {
    throw new Error(`${label} ${state.id} 的 substeps 必须是 1..${SOFT_BODY_BUDGETS.maxSubsteps} 的整数,实测 ${state.substeps}`);
  }
  if (state.groundY !== undefined && !Number.isFinite(state.groundY)) {
    throw new Error(`${label} ${state.id} 的 groundY 必须是有限数值,实测 ${state.groundY}`);
  }
  return { mass: state.mass, damping: state.damping, substeps: state.substeps,
    ...(state.groundY === undefined ? {} : { groundY: state.groundY }) };
}

/** 锚点索引:域 [0, count) 内严格升序唯一(重复/乱序锚点无意义,fail-closed)。 */
function compilePinned(pinned: readonly number[], count: number, label: string): readonly number[] {
  for (let index = 0; index < pinned.length; index += 1) {
    const vertex = pinned[index]!;
    if (!Number.isSafeInteger(vertex) || vertex < 0 || vertex >= count) {
      throw new Error(`${label} 的锚点索引 ${vertex} 越界(0..${count - 1})`);
    }
    if (index > 0 && vertex <= pinned[index - 1]!) {
      throw new Error(`${label} 的锚点索引必须严格升序且唯一,实测 [${pinned.join(",")}]`);
    }
  }
  return [...pinned];
}

/** 布料风场作者态 → 运行包 wind 载荷;域与运行包 parseClothWind 同源。 */
function compileClothWind(wind: SceneClothWindState, label: string): NonNullable<Extract<SoftBodyPayload, { kind: "cloth" }>["wind"]> {
  const direction = [wind.direction.x, wind.direction.y, wind.direction.z] as const;
  if (!direction.every(Number.isFinite) || !direction.some(value => Math.abs(value) > 1e-9)) {
    throw new Error(`${label} 的风场方向必须是非零有限向量,实测 [${direction.join(",")}]`);
  }
  const baseSpeed = nonNegativeFinite(wind.baseSpeed, `${label} 的风场 baseSpeed`);
  if (!Number.isFinite(wind.gustFrequency) || wind.gustFrequency <= 0) {
    throw new Error(`${label} 的风场 gustFrequency 必须为正数,实测 ${wind.gustFrequency}`);
  }
  const spatialScale = nonNegativeFinite(wind.spatialScale, `${label} 的风场 spatialScale`);
  const seed = int32(wind.seed, `${label} 的风场 seed`);
  return { direction: [...direction], baseSpeed, gustFrequency: wind.gustFrequency, spatialScale, seed };
}

/** 标量世界 y(地面平面)→ 包局部 y;沿关节 worldAnchor 先例做平移 + 有限校验。 */
function localizeScalarY(worldY: number, origin: SceneCoordinate, path: string): number {
  const local = worldY - origin.y;
  if (!Number.isFinite(local)) throw new Error(`局部坐标 ${path} 超出数值范围`);
  return Object.is(local, -0) ? 0 : local;
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} 必须是非负有限数,实测 ${value}`);
  return value;
}

function boundedMetre(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1e6) {
    throw new Error(`${label} 必须在 (0, 1e6] 米,实测 ${value}`);
  }
  return value;
}

function int32(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    throw new Error(`${label} 必须是 int32 整数,实测 ${value}`);
  }
  return value;
}

function vector(value: Vector3Value): readonly [number, number, number] {
  return [value.x, value.y, value.z];
}
function quaternion(value: Vector3Value): readonly [number, number, number, number] {
  const cx = Math.cos(value.x / 2), sx = Math.sin(value.x / 2), cy = Math.cos(value.y / 2), sy = Math.sin(value.y / 2), cz = Math.cos(value.z / 2), sz = Math.sin(value.z / 2);
  return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
}
function cloneCharacter(state: NonNullable<import("@bim-studio/contracts").ScenePhysicsBodyState["character"]>): NonNullable<DynamicPhysicsRuntime["bodies"][number]["character"]> {
  return {
    ...(state.offset === undefined ? {} : { offset: state.offset }),
    ...(state.maxSlopeClimbAngle === undefined ? {} : { maxSlopeClimbAngle: state.maxSlopeClimbAngle }),
    ...(state.minSlopeSlideAngle === undefined ? {} : { minSlopeSlideAngle: state.minSlopeSlideAngle }),
    ...(state.autostep === undefined ? {} : { autostep: { ...state.autostep } }),
    ...(state.snapToGround === undefined ? {} : { snapToGround: { ...state.snapToGround } }),
  };
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
