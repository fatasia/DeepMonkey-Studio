import type { Vector3Value } from "./geometry.js";

/** kinematic 为位姿驱动刚体：不受重力/外力，可推动 dynamic，自身只能由宿主显式设位姿。 */
export type PhysicsBodyType = "none" | "fixed" | "dynamic" | "kinematic";

export interface ScenePhysicsBodyState {
  type: PhysicsBodyType;
  mass: number;
  friction: number;
  restitution: number;
  /** Initial world-space linear velocity in metres per second; dynamic bodies only. */
  initialLinearVelocity?: Vector3Value;
  /** 可选角色控制器；仅 kinematic 刚体消费，其余类型忽略。 */
  character?: SceneCharacterControllerState;
  /**
   * 碰撞体来源与精度标记（T17 CAD→collider 来源规范）；省略时保持 render-bounds 现状行为。
   * 几何字段（points/positions）位于刚体局部空间，单位米。
   */
  collider?: ScenePhysicsColliderState;
}

/** 碰撞体来源：collider 几何从哪里来、名义精度是什么。 */
export type ScenePhysicsColliderKind =
  /** 轴对齐包围盒近似（既有默认）；包围盒本身就是近似体。 */
  | "render-bounds"
  /** 源网格顶点的凸包；凹体被过度包裹（concave over-approximation）。 */
  | "convex-hull"
  /** 公差受约束的简化网格（T12 meshoptimizer 链路派生）。 */
  | "simplified-mesh"
  /** F6 有界 SDF 体素场（凹体碰撞；仅 fixed 刚体，消费端提取零等值面 → trimesh）。 */
  | "sdf-grid"
  /** 作者显式几何，构造精确。 */
  | "primitive";

/**
 * 碰撞体精度标记：collider 相对源几何的已知偏差声明。
 * 简化公差超限或源拓扑存在不可修复缺陷（本管线只检测不修补）时必须 approximate=true，
 * 不静默冒充精确；generated kinds（convex-hull/simplified-mesh）必须携带 precision。
 */
export interface ScenePhysicsColliderPrecision {
  /** true 时 collider 只能按近似体消费。 */
  approximate?: boolean;
  /** approximate 的机器可读原因码，如 tolerance-violated、topology-error:NON_MANIFOLD_EDGE。 */
  reasons?: string[];
  /** simplified-mesh 的目标绝对公差（米）；省略表示未声明公差。 */
  tolerance?: number;
  /** convex-hull 顶点数。 */
  hullVertexCount?: number;
  /** simplified-mesh 三角形数。 */
  triangleCount?: number;
  /** 拓扑检查结论引用（apps/api meshTopologyInspection 字典）；true = 无 error 级 issue。 */
  topologyOk?: boolean;
  /** 源网格出现过的 issue 码。 */
  topologyIssueCodes?: string[];
  /** 源网格为凹体：凸包名义上就会过度包裹，属来源性质而非精度失败。 */
  concaveSource?: boolean;
}

/** kind=primitive 的显式几何；字段取决于 shape。 */
export interface ScenePhysicsPrimitiveCollider {
  shape: "cuboid" | "sphere" | "cylinder";
  /** cuboid：半尺寸（米）。 */
  halfExtents?: Vector3Value;
  /** sphere/cylinder：半径（米）。 */
  radius?: number;
  /** cylinder：沿 y 轴的半高（米）。 */
  halfHeight?: number;
}

/** 作者侧碰撞体描述；几何位于刚体局部空间（米）。 */
export interface ScenePhysicsColliderState {
  kind: ScenePhysicsColliderKind;
  precision?: ScenePhysicsColliderPrecision;
  /** convex-hull：凸包顶点（≥4 点且不共面）。 */
  points?: Vector3Value[];
  /** simplified-mesh：网格顶点。 */
  positions?: Vector3Value[];
  /** simplified-mesh：三角形索引（长度为 3 的倍数，引用 positions）。 */
  indices?: number[];
  /** primitive 显式几何。 */
  primitive?: ScenePhysicsPrimitiveCollider;
  /** F6 sdf-grid：有界 SDF 体素场载荷（distances 为 f32 值，长度 = dimensions 体积）。
   * kind="sdf-grid" 时必带；每维 2..128、cells ≤ 262144。 */
  sdfGrid?: SceneSdfGridCollider;
}

/** F6 SDF 有界体素场（与引擎 sdfGrid.SdfGrid 同构；负 = 内部）。 */
export interface SceneSdfGridCollider {
  origin: Vector3Value;
  cellSize: number;
  dimensions: Vector3Value;
  distances: number[];
}

/**
 * Rapier KinematicCharacterController 的作者参数。
 * 全部字段可省略，省略时用引擎默认（坡度 45°、偏移 0.01、自动台阶关闭、贴地开启）。
 * 角度为弧度；offset/autostep/snapToGround 的长度单位为米，相对角色高度的比值由引擎自行换算。
 */
export interface SceneCharacterControllerState {
  /** 与环境的保持间隙；必须大于 0，过小会降低数值稳定性。 */
  offset?: number;
  /** 可攀爬的最大坡度（弧度）。 */
  maxSlopeClimbAngle?: number;
  /** 开始自动下滑的最小坡度（弧度）。 */
  minSlopeSlideAngle?: number;
  /** 自动跨越台阶；省略或 enabled=false 时关闭。 */
  autostep?: { enabled: boolean; maxHeight?: number; minWidth?: number; includeDynamicBodies?: boolean };
  /** 贴地吸附；省略或 enabled=false 时关闭。 */
  snapToGround?: { enabled: boolean; distance?: number };
}

export interface ScenePhysicsState {
  enabled: boolean;
  playing: boolean;
  gravity: Vector3Value;
  /** Product-authored joints. Omitted by legacy scenes. */
  joints?: ScenePhysicsJointState[];
  /** T17 gear couplings: keep a follower joint's coordinate at `ratio ×` the driver
   * joint coordinate via a position servo (both Rapier versions ship no native gear
   * joint). Impulse-solver joints of the same kind only. */
  gears?: SceneGearConstraintState[];
  /** F6 布料/软体 opt-in 通道：与刚体仿真并存，由引擎软体求解器会话消费（固定 1/60 时间基）。
   * id 唯一且按字典序；粒子/四面体预算在消费端 fail-closed（超限拒绝并给原因）。 */
  softBodies?: SceneSoftBodyState[];
}

/** F6 布料/软体作者侧判别联合。 */
export type SceneSoftBodyState = SceneClothState | SceneTetraSoftBodyState;

export interface SceneClothState {
  kind: "cloth";
  id: string;
  columns: number;
  rows: number;
  /** 网格静止间距（米）。 */
  spacing: number;
  /** 单质点质量（kg）。 */
  mass: number;
  /** XPBD compliance（m/N）；0 = 刚性约束。 */
  compliance: number;
  /** 每子步线性速度阻尼系数 [0,1)。 */
  damping: number;
  substeps: number;
  /** seed 驱动的初始 z 向扰动幅度（米），≥0。 */
  perturbation: number;
  seed: number;
  /** 初始布局平移（米）；布料铺在 XY 平面（y 上）。 */
  origin: Vector3Value;
  /** 锚点粒子索引（row*columns+col），严格升序。 */
  pinned: number[];
  /** 地面接触平面 y = groundY（米）；省略 = 无。 */
  groundY?: number;
  wind?: SceneClothWindState;
}

export interface SceneClothWindState {
  direction: Vector3Value;
  /** 米/秒，≥0。 */
  baseSpeed: number;
  gustFrequency: number;
  spatialScale: number;
  seed: number;
}

export interface SceneTetraSoftBodyState {
  kind: "soft-body";
  id: string;
  /** 初始顶点位置（米，世界系）。 */
  positions: Vector3Value[];
  /** 四面体顶点索引（环绕方向可不统一，构建期规整）。 */
  tets: [number, number, number, number][];
  mass: number;
  complianceDistance: number;
  complianceVolume: number;
  damping: number;
  substeps: number;
  /** 锚点顶点索引，严格升序。 */
  pinned: number[];
  groundY?: number;
}

/** T17 齿轮耦合：从动关节坐标 = ratio × 主动关节坐标（伺服跟随，非求解器级啮合）。
 * 外啮合反向用负 ratio 表达。 */
export interface SceneGearConstraintState {
  id: string;
  driverJointId: string;
  followerJointId: string;
  /** Follower coordinate per driver coordinate unit; finite and non-zero. */
  ratio: number;
  /** Servo gains of the follower position motor (Rapier stiffness/damping). */
  stiffness: number;
  damping: number;
}

export interface ScenePhysicsJointState {
  id: string;
  /** revolute: rotation about `axis` (limits/motor in rad, rad/s). prismatic: translation along `axis`
   * (limits/motor in m, m/s); impulse solver only — the reduced-coordinate multibody path stays revolute. */
  kind: "revolute" | "prismatic";
  /** Reduced-coordinate multibody joints currently exclude limits and motors in the Web product API. */
  solver?: "impulse" | "multibody";
  /** Model rigid body mounted to the fixed world body. */
  bodyId: string;
  /** Optional second authored rigid body. Omitted joints remain attached to the fixed world. */
  connectedBodyId?: string;
  /** Anchor on the fixed world body, in world metres. */
  worldAnchor: Vector3Value;
  /** Anchor on the model rigid body, in model-local metres. */
  localAnchor: Vector3Value;
  /** Revolute axis or prismatic slide direction in the joint local frame. */
  axis: Vector3Value;
  /** Linear limits are metres for prismatic joints, radians for revolute joints. */
  limits: { enabled: boolean; min: number; max: number };
  /** Rapier velocity motor. Strength is the solver factor, not a torque claim. */
  motor: { enabled: boolean; targetVelocity: number; strength: number;
    /** T17 position servo: overrides targetVelocity while enabled; `target` is the
     * joint coordinate (radians for revolute, metres for prismatic, impulse only). */
    position?: { enabled: boolean; target: number; stiffness: number; damping: number } };
}
