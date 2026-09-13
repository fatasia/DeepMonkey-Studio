import * as THREE from "three";
import type { IndustrialPrefabDefinition, IndustrialPrefabKind } from "@bim-studio/contracts";

/**
 * 缩略图小样共享工具包:变体抽取、材质语言、几何摆件助手与资源释放。
 * 所有构建器共用同一套材质语义(机身漆/金属/深色塑料/安全黄/玻璃/发光件),
 * 保证 78 个预制体缩略图风格统一,像同一套设备目录的渲染小样。
 */

/** 从预制体定义抽出的分型键:各 kind 构建器据此微调轮廓(泵/阀、CNC 工艺、机器人族、输送布局…)。 */
export interface PrefabThumbnailVariant {
  id: string;
  /** 定义 id 的最后一段,如 "gate"、"dosing"、"amr-shelf"。 */
  tail: string;
  family?: string | undefined;
  subtype?: string | undefined;
  process?: string | undefined;
  layout?: string | undefined;
  surface?: string | undefined;
  tool?: string | undefined;
  panel?: string | undefined;
  /** 数值分型键:拼接大屏行列与画幅(C6 行列联动)。 */
  rows?: number | undefined;
  columns?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
}

export function prefabThumbnailVariant(definition: IndustrialPrefabDefinition): PrefabThumbnailVariant {
  const param = (key: string) => {
    const found = definition.parameters.find((item) => item.key === key);
    return typeof found?.defaultValue === "string" ? found.defaultValue : undefined;
  };
  const numberParam = (key: string) => {
    const found = definition.parameters.find((item) => item.key === key);
    return typeof found?.defaultValue === "number" ? found.defaultValue : undefined;
  };
  return {
    id: definition.id,
    tail: definition.id.split(".").at(-1) ?? definition.id,
    family: param("family"),
    subtype: param("subtype"),
    process: param("process"),
    layout: param("layout"),
    surface: param("surface"),
    tool: param("toolType"),
    panel: param("panel"),
    rows: numberParam("rows"),
    columns: numberParam("columns"),
    width: numberParam("widthM"),
    height: numberParam("heightM"),
  };
}

/** 3D 材质无法引用 CSS 变量,这里镜像 base.css 的语义令牌(--success/--warning/--danger)与安全黄点缀。 */
export const THUMB_COLORS = {
  success: 0x59c58d,
  warning: 0xd8ac52,
  danger: 0xe27478,
  safety: 0xe0a63c,
  ink: 0x222b30,
  metal: 0xb7c1c7,
  glass: 0x9fd4dd,
  bone: 0xe6ecef,
} as const;

/** 稳定字符串哈希(FNV-1a):同一 id/kind 永远得到同一风格种子,缩略图不会在会话间"变脸"。 */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 场景氛围模式:冷(蓝青工程夜)与暖(琥珀车间光),按 kind 交替,消除"全库一张图"感。 */
export type SceneMode = "cool" | "warm";
/** 材质表面处理:与色相微调、姿态一起构成变体三重区分中的"材质"一重。 */
export type FinishMode = "gloss" | "matte" | "brushed" | "oxidized";

export interface ThumbnailStyle {
  sceneMode: SceneMode;
  /** 取景模式:平视 3/4 / 高俯视 / 侧低视角,按变体轮换。 */
  cameraMode: 0 | 1 | 2;
  /** 变体主色微调(±15° 色相内),在 kind 代理色基础上拉开族内差异。 */
  hueShift: number;
  finish: FinishMode;
  /** 主光色温(K):4300~5600K 按种子微调,并排卡片有"同族不同照"的棚拍感。 */
  keyKelvin: number;
  /** 轮廓光强度倍率(0.8~1.2),按种子 ±20% 摆动。 */
  rimBoost: number;
  /** 环境小物种子:与 id 绑定,迷你环境物的种类/位置/朝向据此稳定散布。 */
  propsSeed: number;
}

/** kind 清单顺序即"冷/暖交替"的序:相邻 kind 场景氛围相反。 */
const SCENE_MODE_ORDER: IndustrialPrefabKind[] = [
  "machine", "utility", "electrical", "conveyor", "robot-arm", "person", "agv", "vehicle",
  "access-control", "display", "fence", "sensor", "camera", "storage",
];

/** 变体风格种子:场景模式按 kind 交替;取景/色相/表面处理/光梯度按 definition id 稳定散布。 */
export function thumbnailStyleFor(kind: IndustrialPrefabKind, id: string): ThumbnailStyle {
  const kindIndex = Math.max(0, SCENE_MODE_ORDER.indexOf(kind));
  const seed = hashSeed(id);
  const FINISHES: FinishMode[] = ["gloss", "matte", "brushed", "oxidized"];
  return {
    sceneMode: kindIndex % 2 === 0 ? "cool" : "warm",
    cameraMode: (seed % 3) as ThumbnailStyle["cameraMode"],
    hueShift: (Math.floor(seed / 7) % 31) - 15,
    finish: FINISHES[Math.floor(seed / 11) % FINISHES.length] ?? "gloss",
    keyKelvin: 4300 + (Math.floor(seed / 17) % 14) * 100, // 4300K~5600K,百 K 步进
    rimBoost: 0.8 + (Math.floor(seed / 23) % 5) * 0.1, // 0.8~1.2
    propsSeed: hashSeed(`${id}:props`),
  };
}

/** 色温(K)→ 线性 RGB(Tanner Helland 近似):主光色温梯度的换算来源,避免引入查找表。 */
export function kelvinToColor(kelvin: number): THREE.Color {
  const t = Math.min(Math.max(kelvin, 1000), 40000) / 100;
  const clamp01 = (value: number) => Math.min(Math.max(value / 255, 0), 1);
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return new THREE.Color(clamp01(r), clamp01(g), clamp01(b)).convertSRGBToLinear();
}

/** 每个小样一套材质;渲染完由 disposeThumbnailModel 统一释放,渲染器常驻复用。 */
export interface ModelKit {
  group: THREE.Group;
  /** 机身漆(主色,来自 kind 的场景代理色彩语义) */
  body: THREE.MeshStandardMaterial;
  /** 副色机身(主色向 --bg-0 压暗一档) */
  bodyDeep: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  /** 发光屏/HMI/读卡区 */
  screen: THREE.MeshStandardMaterial;
  lampRun: THREE.MeshStandardMaterial;
  lampWarn: THREE.MeshStandardMaterial;
  lampDanger: THREE.MeshStandardMaterial;
  /** 惰性创建的肤色/浅色件(人头部、闸臂白段),首次使用时生成。 */
  bone?: THREE.MeshStandardMaterial | undefined;
}

function lampMaterial(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.85, roughness: 0.35, metalness: 0.05 });
}

/** 表面处理库:同族变体在哑光/拉丝/氧化黑间轮换,是"材质"维度的区分来源。 */
const FINISH_PRESETS: Record<FinishMode, { roughness: number; metalness: number; inkLerp: number }> = {
  gloss: { roughness: 0.5, metalness: 0.2, inkLerp: 0 },
  matte: { roughness: 0.74, metalness: 0.05, inkLerp: 0.1 },
  brushed: { roughness: 0.32, metalness: 0.55, inkLerp: 0 },
  oxidized: { roughness: 0.62, metalness: 0.32, inkLerp: 0.45 },
};

export function createModelKit(primaryColor: string, style?: ThumbnailStyle): ModelKit {
  const base = new THREE.Color(primaryColor);
  if (style?.hueShift) {
    // ±15° 色相微调:保持 kind 语义色的同时,让族内每个变体不完全同色。
    const hsl = { h: 0, s: 0, l: 0 };
    base.getHSL(hsl);
    base.setHSL((hsl.h + style.hueShift / 360 + 1) % 1, hsl.s, hsl.l);
  }
  const bg = new THREE.Color(0x0b1114); // --bg-0
  const finish = FINISH_PRESETS[style?.finish ?? "gloss"];
  const bodyColor = base.clone().lerp(new THREE.Color(0x2a3138), finish.inkLerp);
  return {
    group: new THREE.Group(),
    body: new THREE.MeshStandardMaterial({ color: bodyColor, roughness: finish.roughness, metalness: finish.metalness }),
    bodyDeep: new THREE.MeshStandardMaterial({ color: base.clone().lerp(bg, 0.42 + finish.inkLerp * 0.3), roughness: finish.roughness + 0.05, metalness: finish.metalness + 0.05 }),
    // 金属件 envMapIntensity 拉满:RoomEnvironment 反射让金属"活"起来(Unity 级 PBR 质感)。
    metal: new THREE.MeshStandardMaterial({ color: THUMB_COLORS.metal, roughness: 0.22, metalness: 0.92, envMapIntensity: 1.45 }),
    dark: new THREE.MeshStandardMaterial({ color: THUMB_COLORS.ink, roughness: 0.6, metalness: 0.1 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x161d21, roughness: 0.9, metalness: 0 }),
    accent: new THREE.MeshStandardMaterial({ color: THUMB_COLORS.safety, roughness: 0.45, metalness: 0.15 }),
    glass: new THREE.MeshStandardMaterial({ color: THUMB_COLORS.glass, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.3, depthWrite: false, envMapIntensity: 1.3 }),
    screen: new THREE.MeshStandardMaterial({ color: base.clone().lerp(new THREE.Color(0xffffff), 0.55), emissive: base.clone().lerp(new THREE.Color(0xffffff), 0.4), emissiveIntensity: 0.55, roughness: 0.3 }),
    lampRun: lampMaterial(THUMB_COLORS.success),
    lampWarn: lampMaterial(THUMB_COLORS.warning),
    lampDanger: lampMaterial(THUMB_COLORS.danger),
  };
}

export type Axis = "x" | "y" | "z";

const AXIS_ROTATION: Record<Axis, [number, number, number]> = {
  x: [0, 0, Math.PI / 2],
  y: [0, 0, 0],
  z: [Math.PI / 2, 0, 0],
};

function place(mesh: THREE.Mesh, target: THREE.Object3D, x: number, y: number, z: number, axis: Axis): THREE.Mesh {
  mesh.position.set(x, y, z);
  const [rx, ry, rz] = AXIS_ROTATION[axis];
  if (rx || ry || rz) mesh.rotation.set(rx, ry, rz);
  target.add(mesh);
  return mesh;
}

export function boxAt(target: THREE.Object3D, material: THREE.Material, w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.Mesh {
  return place(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material), target, x, y, z, "y");
}

export function cylAt(target: THREE.Object3D, material: THREE.Material, rTop: number, rBottom: number, h: number, x = 0, y = 0, z = 0, axis: Axis = "y", segments = 22): THREE.Mesh {
  return place(new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, segments), material), target, x, y, z, axis);
}

export function tubeAt(target: THREE.Object3D, material: THREE.Material, radius: number, tube: number, x = 0, y = 0, z = 0, axis: Axis = "y", arc = Math.PI * 2, tubularSegments = 36): THREE.Mesh {
  return place(new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 12, tubularSegments, arc), material), target, x, y, z, axis);
}

export function ballAt(target: THREE.Object3D, material: THREE.Material, r: number, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1): THREE.Mesh {
  const mesh = place(new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), material), target, x, y, z, "y");
  mesh.scale.set(sx, sy, sz);
  return mesh;
}

export function capsuleAt(target: THREE.Object3D, material: THREE.Material, r: number, length: number, x = 0, y = 0, z = 0, axis: Axis = "y"): THREE.Mesh {
  return place(new THREE.Mesh(new THREE.CapsuleGeometry(r, length, 6, 18), material), target, x, y, z, axis);
}

export function subgroupAt(target: THREE.Object3D, x = 0, y = 0, z = 0): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  target.add(group);
  return group;
}

/** 三色柱灯(自上而下红/黄/绿),工业设备通用状态语义,顶盖深色收口。 */
export function stackLightAt(target: THREE.Object3D, kit: ModelKit, x = 0, yBase = 0, z = 0, h = 0.26): THREE.Group {
  const group = subgroupAt(target, x, yBase, z);
  const segment = h / 3;
  cylAt(group, kit.dark, 0.012, 0.012, 0.04, 0, 0.02, 0);
  cylAt(group, kit.lampDanger, 0.026, 0.026, segment, 0, 0.04 + segment / 2, 0);
  cylAt(group, kit.lampWarn, 0.026, 0.026, segment, 0, 0.04 + segment * 1.5, 0);
  cylAt(group, kit.lampRun, 0.026, 0.026, segment, 0, 0.04 + segment * 2.5, 0);
  cylAt(group, kit.dark, 0.028, 0.028, 0.014, 0, 0.04 + h, 0);
  return group;
}

/** 环形法兰盘(管道端口的通用收口)。 */
export function flangeAt(target: THREE.Object3D, kit: ModelKit, radius: number, x: number, y: number, z: number, axis: Axis): THREE.Mesh {
  return tubeAt(target, kit.metal, radius, Math.max(radius * 0.24, 0.014), x, y, z, axis);
}

/** 散热格栅:一组平行细条(柜体/电机罩通用)。 */
export function grilleAt(target: THREE.Object3D, material: THREE.Material, width: number, rows: number, x: number, y: number, z: number, step = 0.024): THREE.Group {
  const group = subgroupAt(target, x, y, z);
  for (let i = 0; i < rows; i++) {
    const offset = (i - (rows - 1) / 2) * step;
    boxAt(group, material, width, 0.008, 0.006, 0, offset, 0);
  }
  return group;
}

/** 散热孔阵(波次 E 升级):rows×cols 凹凸格栅——InstancedMesh 小方块沿壁面法向交替
 *  下沉/微凸,实例色区分孔腔(暗)与肋条(亮)。波次 E 前是平面圆点阵;material 参数
 *  保留兼容旧调用,格栅视觉改由内置基材 + 实例色呈现。 */
export function ventDotsAt(target: THREE.Object3D, material: THREE.Material, width: number, rows: number, cols: number, x = 0, y = 0, z = 0, axis: Axis = "z"): THREE.Group {
  const group = subgroupAt(target, x, y, z);
  const step = width / cols;
  const cell = Math.min(step * 0.52, 0.016);
  const depth = 0.009;
  // 内置中灰金属基材:实例色可双向调制(肋条提亮 / 孔腔压暗),不被机身主色吞掉。
  const grille = new THREE.MeshStandardMaterial({ color: 0x8a949a, roughness: 0.5, metalness: 0.6 });
  const instanced = new THREE.InstancedMesh(
    axis === "x" ? new THREE.BoxGeometry(depth, cell, cell) : new THREE.BoxGeometry(cell, cell, depth),
    grille,
    rows * cols,
  );
  const matrix = new THREE.Matrix4();
  const cavity = new THREE.Color(0.16, 0.19, 0.2); // 孔腔阴影(乘法压暗)
  const rib = new THREE.Color(1.35, 1.4, 1.45); // 肋条受光(乘法提亮,允许 >1)
  let index = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const across = -width / 2 + step * (c + 0.5); // 沿壁面横向
      const up = (r - (rows - 1) / 2) * step; // 沿壁面纵向
      const raised = (r + c) % 2 === 0; // 凹凸交替:孔腔下沉、肋条微凸
      const sink = raised ? depth * 0.34 : -depth * 0.3;
      if (axis === "x") matrix.makeTranslation(sink, up, across);
      else matrix.makeTranslation(across, up, sink);
      instanced.setMatrixAt(index, matrix);
      instanced.setColorAt(index, raised ? rib : cavity);
      index += 1;
    }
  }
  instanced.instanceMatrix.needsUpdate = true;
  if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
  group.add(instanced);
  return group;
}

/** 警示条纹(波次 E 升级):黄黑交替小段;传入 seed 后按种子产生磨损变化——
 *  掉漆缺口(缩矮)、错位(凸出)、断条(缺失),模拟使用痕迹但不花哨。 */
export function stripesAt(target: THREE.Object3D, kit: ModelKit, width: number, height: number, x = 0, y = 0, z = 0, count = 5, seed?: number): THREE.Group {
  const group = subgroupAt(target, x, y, z);
  const step = width / count;
  for (let i = 0; i < count; i++) {
    const wear = seed === undefined ? 0 : (hashSeed(`wear:${seed}:${i}`) % 97) / 97;
    if (wear > 0.94) continue; // 断条:整段缺失(重度磨损)
    const chipped = wear > 0.82; // 掉漆缺口:段缩矮并向后退
    const shifted = wear > 0.58 && !chipped; // 错位:段向前凸出
    const segHeight = chipped ? height * 0.58 : height;
    const segZ = chipped ? -0.004 : shifted ? 0.005 : 0;
    boxAt(group, i % 2 === 0 ? kit.accent : kit.dark, step, segHeight, 0.008, -width / 2 + step * (i + 0.5), chipped ? -height * 0.18 : 0, segZ);
  }
  return group;
}

/** 面板分割线(波次 E 新增贴花):大面积机身漆面上的横向分缝——暗槽条 + 上缘
 *  金属受光线,两枚 mesh 制造"钣金折边"立体感,克制不花。axis 为所在壁面法向。 */
export function panelSeamAt(target: THREE.Object3D, kit: ModelKit, width: number, x: number, y: number, z: number, axis: Axis = "z"): THREE.Group {
  const group = subgroupAt(target, x, y, z);
  if (axis === "x") {
    boxAt(group, kit.bodyDeep, 0.005, 0.008, width, 0, 0, 0);
    boxAt(group, kit.metal, 0.004, 0.003, width, 0.006, 0.004, 0);
  } else {
    boxAt(group, kit.bodyDeep, width, 0.008, 0.005, 0, 0, 0);
    boxAt(group, kit.metal, width, 0.003, 0.004, 0, 0.007, 0);
  }
  return group;
}

/** 四角螺栓点阵(波次 E 新增贴花):法兰/盖板/底座的四角地脚螺栓,金属小圆柱。 */
export function boltQuadAt(target: THREE.Object3D, kit: ModelKit, spreadX: number, spreadZ: number, x = 0, y = 0, z = 0): THREE.Group {
  const group = subgroupAt(target, x, y, z);
  for (const sx of [-spreadX / 2, spreadX / 2]) {
    for (const sz of [-spreadZ / 2, spreadZ / 2]) {
      cylAt(group, kit.metal, 0.012, 0.012, 0.016, sx, 0, sz, "y", 8);
    }
  }
  return group;
}

/** 螺旋管(C7 连续曲面):沿螺旋线扫掠的管体,用于螺旋输送带缘与螺旋输送机叶片。 */
export function helixTubeAt(target: THREE.Object3D, material: THREE.Material, options: { radius: number; height: number; turns: number; tube: number; startAngle?: number }): THREE.Mesh {
  const { radius, height, turns, tube } = options;
  const points: THREE.Vector3[] = [];
  const total = Math.max(32, Math.round(turns * 20));
  for (let i = 0; i <= total; i++) {
    const t = i / total;
    const angle = (options.startAngle ?? 0) + t * turns * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(angle) * radius, t * height, Math.sin(angle) * radius));
  }
  const curve = new THREE.CatmullRomCurve3(points);
  return place(new THREE.Mesh(new THREE.TubeGeometry(curve, total, tube, 10, false), material), target, 0, 0, 0, "y");
}

/** 惰性浅色件(人员头部、白色摄像机壳、吸顶探测器等),首次使用时生成并挂到 kit 上统一释放。 */
export function boneMaterial(kit: ModelKit): THREE.MeshStandardMaterial {
  return (kit.bone ??= new THREE.MeshStandardMaterial({ color: THUMB_COLORS.bone, roughness: 0.5, metalness: 0 }));
}

/** 释放小样全部几何与材质;调用后 root 不应再被渲染。InstancedMesh 额外释放实例缓冲。 */
export function disposeThumbnailModel(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    if ((mesh as Partial<THREE.InstancedMesh>).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose();
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) if (material) materials.add(material);
  });
  for (const material of materials) material.dispose();
  root.removeFromParent();
}
