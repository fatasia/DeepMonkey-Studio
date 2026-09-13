import * as THREE from "three";
import type { ModelKit, PrefabThumbnailVariant } from "./prefabThumbnailKit";
import { ballAt, boxAt, cylAt, helixTubeAt, stackLightAt, subgroupAt, tubeAt } from "./prefabThumbnailKit";
import { buildBucketElevatorModel, buildScrewConveyorModel } from "./prefabThumbnailModelsLogistics2";
export function buildConveyorModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group {
  const g = kit.group;
  const layout = variant.layout ?? "straight";
  const surface = variant.surface ?? "belt";
  const tail = variant.tail;
  // 同名同布局的"参数变体"先分流,保证族内并排肉眼可辨(宽幅/重力/积放/链式)。
  if (tail === "belt-wide") return buildWideBeltConveyor(g, kit);
  if (tail === "roller-gravity") return buildGravityRollerConveyor(g, kit);
  if (tail === "roller-accumulation") return buildAccumulationRollerConveyor(g, kit);
  if (tail === "chain-pallet") return buildChainPalletConveyor(g, kit);
  if (layout === "spiral") return buildSpiralConveyor(g, kit);
  if (layout === "vertical-lift") return buildVerticalLift(g, kit);
  if (layout === "screw") return buildScrewConveyorModel(g, kit);
  if (layout === "bucket-elevator") return buildBucketElevatorModel(g, kit);
  if (layout === "curve-90" || layout === "curve-180") return buildCurveConveyor(g, kit, layout === "curve-90" ? Math.PI / 2 : Math.PI);
  if (layout === "sorter") return buildSorterConveyor(g, kit);
  if (layout === "merge") return buildMergeConveyor(g, kit);
  if (layout === "diverter") return buildDiverterConveyor(g, kit);
  if (layout === "transfer") return buildTransferConveyor(g, kit);
  const incline = layout === "incline";
  const bed = subgroupAt(g);
  if (incline) bed.rotation.z = -0.24;
  // 机架:两侧纵梁 + 输送面 + 头尾滚筒(爬坡时机架整体倾斜)
  boxAt(bed, kit.body, 1.5, 0.1, 0.5, 0, 0.42, 0);
  for (const z of [-0.27, 0.27]) boxAt(bed, kit.bodyDeep, 1.5, 0.07, 0.04, 0, 0.485, z);
  if (surface === "roller") {
    for (let i = 0; i < 9; i++) cylAt(bed, kit.metal, 0.045, 0.045, 0.56, -0.62 + i * 0.155, 0.475, 0, "z", 14);
  } else {
    boxAt(bed, kit.rubber, 1.44, 0.03, 0.44, 0, 0.48, 0); // 皮带面
  }
  cylAt(bed, kit.metal, 0.07, 0.07, 0.54, -0.72, 0.47, 0, "z"); // 头部滚筒
  cylAt(bed, kit.metal, 0.06, 0.06, 0.54, 0.72, 0.47, 0, "z");
  cylAt(bed, kit.dark, 0.05, 0.05, 0.16, -0.72, 0.47, 0.36, "z"); // 电机端盖
  // 支腿保持垂直落地:直段等高,爬坡段高端腿长、低端腿短
  const legTops: Array<[number, number]> = incline
    ? [[-0.6, 0.56], [0.6, 0.2]]
    : [[-0.62, 0.42], [0, 0.42], [0.62, 0.42]];
  for (const [x, topY] of legTops) for (const z of [-0.24, 0.24]) {
    boxAt(g, kit.metal, 0.035, topY, 0.035, x, topY / 2, z);
    boxAt(g, kit.rubber, 0.08, 0.015, 0.08, x, 0.008, z);
  }
  return g;
}

/** 宽幅皮带线:1.4× 输送面 + 双侧导料栏 + 中加腿,体量与直线皮带明显拉开。 */
function buildWideBeltConveyor(g: THREE.Group, kit: ModelKit): THREE.Group {
  boxAt(g, kit.body, 1.5, 0.1, 0.72, 0, 0.42, 0);
  boxAt(g, kit.rubber, 1.44, 0.03, 0.64, 0, 0.48, 0);
  for (const z of [-0.38, 0.38]) boxAt(g, kit.bodyDeep, 1.5, 0.07, 0.04, 0, 0.485, z);
  for (const z of [-0.37, 0.37]) {
    boxAt(g, kit.metal, 1.5, 0.025, 0.02, 0, 0.56, z); // 导料栏
    for (const x of [-0.6, 0, 0.6]) boxAt(g, kit.metal, 0.02, 0.1, 0.02, x, 0.53, z);
  }
  cylAt(g, kit.metal, 0.07, 0.07, 0.72, -0.72, 0.47, 0, "z");
  cylAt(g, kit.metal, 0.06, 0.06, 0.72, 0.72, 0.47, 0, "z");
  cylAt(g, kit.dark, 0.05, 0.05, 0.2, -0.72, 0.47, 0.44, "z");
  for (const x of [-0.62, 0, 0.62]) for (const z of [-0.34, 0.34]) {
    boxAt(g, kit.metal, 0.035, 0.42, 0.035, x, 0.21, z);
    boxAt(g, kit.rubber, 0.08, 0.015, 0.08, x, 0.008, z);
  }
  return g;
}

/** 无动力滚筒线:重力微坡 + 无电机端盖 + 尾端止挡 + 低端滑出货箱。 */
function buildGravityRollerConveyor(g: THREE.Group, kit: ModelKit): THREE.Group {
  const bed = subgroupAt(g);
  bed.rotation.z = -0.09;
  boxAt(bed, kit.body, 1.5, 0.08, 0.5, 0, 0.42, 0);
  for (let i = 0; i < 9; i++) cylAt(bed, kit.metal, 0.045, 0.045, 0.56, -0.62 + i * 0.155, 0.46, 0, "z", 14);
  boxAt(bed, kit.accent, 0.03, 0.12, 0.5, -0.72, 0.53, 0); // 进料端止挡
  // 高低支腿顺应坡度
  for (const z of [-0.24, 0.24]) {
    boxAt(g, kit.metal, 0.035, 0.44, 0.035, -0.62, 0.22, z);
    boxAt(g, kit.metal, 0.035, 0.3, 0.035, 0.62, 0.15, z);
    boxAt(g, kit.rubber, 0.08, 0.015, 0.08, -0.62, 0.008, z);
    boxAt(g, kit.rubber, 0.08, 0.015, 0.08, 0.62, 0.008, z);
  }
  boxAt(g, kit.bodyDeep, 0.3, 0.22, 0.3, 0.55, 0.62, 0); // 滑出端料箱
  return g;
}

/** 积放滚筒线:动力滚筒 + 两道分区止挡 + 光电传感器柱(积放区语义)。 */
function buildAccumulationRollerConveyor(g: THREE.Group, kit: ModelKit): THREE.Group {
  boxAt(g, kit.body, 1.5, 0.1, 0.5, 0, 0.42, 0);
  for (const z of [-0.27, 0.27]) boxAt(g, kit.bodyDeep, 1.5, 0.07, 0.04, 0, 0.485, z);
  for (let i = 0; i < 9; i++) cylAt(g, kit.metal, 0.045, 0.045, 0.56, -0.62 + i * 0.155, 0.475, 0, "z", 14);
  cylAt(g, kit.metal, 0.07, 0.07, 0.54, -0.72, 0.47, 0, "z");
  cylAt(g, kit.dark, 0.05, 0.05, 0.16, -0.72, 0.47, 0.36, "z");
  for (const x of [-0.62, 0, 0.62]) for (const z of [-0.24, 0.24]) {
    boxAt(g, kit.metal, 0.035, 0.42, 0.035, x, 0.21, z);
    boxAt(g, kit.rubber, 0.08, 0.015, 0.08, x, 0.008, z);
  }
  for (const x of [-0.35, 0.35]) {
    boxAt(g, kit.accent, 0.028, 0.15, 0.5, x, 0.565, 0); // 分区止摆挡板
    for (const z of [-0.29, 0.29]) {
      boxAt(g, kit.dark, 0.045, 0.2, 0.045, x + 0.16, 0.6, z); // 光电柱
      ballAt(g, kit.lampRun, 0.018, x + 0.16, 0.72, z);
    }
  }
  return g;
}

/** 链式托盘线:双链条 + 链节 + 托盘货箱(与皮带/滚筒面完全不同语言)。 */
function buildChainPalletConveyor(g: THREE.Group, kit: ModelKit): THREE.Group {
  boxAt(g, kit.body, 1.5, 0.1, 0.56, 0, 0.42, 0);
  for (const z of [-0.17, 0.17]) {
    boxAt(g, kit.dark, 1.44, 0.045, 0.07, 0, 0.475, z); // 链条
    for (let i = 0; i < 8; i++) boxAt(g, kit.metal, 0.03, 0.055, 0.05, -0.63 + i * 0.18, 0.483, z); // 链节
  }
  cylAt(g, kit.metal, 0.06, 0.06, 0.6, -0.72, 0.47, 0, "z");
  cylAt(g, kit.dark, 0.05, 0.05, 0.16, -0.72, 0.47, 0.36, "z");
  for (const x of [-0.62, 0, 0.62]) for (const z of [-0.26, 0.26]) {
    boxAt(g, kit.metal, 0.035, 0.42, 0.035, x, 0.21, z);
    boxAt(g, kit.rubber, 0.08, 0.015, 0.08, x, 0.008, z);
  }
  for (const x of [-0.4, 0.32]) {
    boxAt(g, kit.rubber, 0.4, 0.035, 0.34, x, 0.515, 0); // 托盘铺板
    for (const bx of [-0.14, 0.14]) boxAt(g, kit.rubber, 0.05, 0.035, 0.3, x + bx, 0.48, 0); // 托盘纵梁
    boxAt(g, x > 0 ? kit.bodyDeep : kit.accent, 0.3, 0.22, 0.28, x, 0.65, 0); // 货箱
  }
  return g;
}

/** 合流输送机:主皮带 + 45° 侧线汇入 + 汇入口警示灯。 */
function buildMergeConveyor(g: THREE.Group, kit: ModelKit): THREE.Group {
  const main = buildStraightBelt(g, kit, 1.9);
  const lane = subgroupAt(g, 0.35, 0, -0.6);
  lane.rotation.y = -Math.PI / 4;
  boxAt(lane, kit.body, 0.8, 0.08, 0.4, 0, 0.42, 0);
  boxAt(lane, kit.rubber, 0.74, 0.03, 0.34, 0, 0.47, 0);
  cylAt(lane, kit.metal, 0.06, 0.06, 0.44, -0.4, 0.47, 0, "z");
  for (const [x, z] of [[-0.34, -0.16], [0.34, -0.16], [-0.34, 0.16], [0.34, 0.16]] as const) {
    boxAt(lane, kit.metal, 0.035, 0.42, 0.035, x, 0.21, z);
  }
  boxAt(g, kit.accent, 0.34, 0.03, 0.04, 0.42, 0.55, -0.28); // 合流鼻梁
  cylAt(g, kit.lampWarn, 0.03, 0.03, 0.05, 0.42, 0.63, -0.33, "y", 12);
  return main;
}

/** 摆轮分流机:直皮带床 + 中段 45° 斜置摆轮列 + 侧向滑出槽与分流料箱。 */
function buildDiverterConveyor(g: THREE.Group, kit: ModelKit): THREE.Group {
  const main = buildStraightBelt(g, kit, 1.9);
  for (let i = 0; i < 5; i++) {
    const wheel = cylAt(g, kit.accent, 0.05, 0.05, 0.05, -0.3 + i * 0.15, 0.53, 0.04, "z", 14);
    wheel.rotation.x = Math.PI / 4; // 斜置摆轮
    cylAt(g, kit.dark, 0.014, 0.014, 0.12, -0.3 + i * 0.15, 0.53, 0.04, "z", 8);
  }
  boxAt(g, kit.accent, 0.8, 0.02, 0.12, -0.1, 0.5, 0.16); // 顶升托板
  const chute = boxAt(g, kit.bodyDeep, 0.44, 0.03, 0.32, 0.1, 0.5, 0.42);
  chute.rotation.x = -0.12; // 侧向滑出槽
  for (const x of [-0.06, 0.26]) boxAt(g, kit.metal, 0.03, 0.42, 0.03, x, 0.21, 0.52);
  const carton = boxAt(g, kit.body, 0.24, 0.2, 0.24, 0.1, 0.63, 0.4);
  carton.rotation.x = -0.1; // 分流中的料箱
  return main;
}

/** 顶升移载机:直滚筒床 + 正交横移模块(交叉辊道)+ 双侧护栏。 */
function buildTransferConveyor(g: THREE.Group, kit: ModelKit): THREE.Group {
  boxAt(g, kit.body, 1.5, 0.1, 0.5, 0, 0.42, 0);
  for (const z of [-0.27, 0.27]) boxAt(g, kit.bodyDeep, 1.5, 0.07, 0.04, 0, 0.485, z);
  for (let i = 0; i < 9; i++) cylAt(g, kit.metal, 0.045, 0.045, 0.56, -0.62 + i * 0.155, 0.475, 0, "z", 14);
  cylAt(g, kit.metal, 0.07, 0.07, 0.54, -0.72, 0.47, 0, "z");
  cylAt(g, kit.dark, 0.05, 0.05, 0.16, -0.72, 0.47, 0.36, "z");
  for (const x of [-0.62, 0, 0.62]) for (const z of [-0.24, 0.24]) {
    boxAt(g, kit.metal, 0.035, 0.42, 0.035, x, 0.21, z);
    boxAt(g, kit.rubber, 0.08, 0.015, 0.08, x, 0.008, z);
  }
  // 正交移载模块:侧向穿出,顶升板 + 交叉辊
  boxAt(g, kit.bodyDeep, 0.5, 0.26, 0.34, 0.35, 0.32, -0.52);
  boxAt(g, kit.accent, 0.44, 0.03, 0.3, 0.35, 0.47, -0.52);
  for (let i = 0; i < 4; i++) cylAt(g, kit.metal, 0.035, 0.035, 0.3, 0.2 + i * 0.1, 0.51, -0.52, "x", 12);
  boxAt(g, kit.lampWarn, 0.5, 0.02, 0.02, 0.35, 0.5, -0.33);
  // 双侧护栏
  for (const z of [-0.31, 0.31]) {
    boxAt(g, kit.metal, 1.6, 0.03, 0.02, 0, 0.62, z);
    for (const x of [-0.7, 0, 0.7]) boxAt(g, kit.metal, 0.02, 0.16, 0.02, x, 0.55, z);
  }
  return g;
}

function buildCurveConveyor(g: THREE.Group, kit: ModelKit, arc: number): THREE.Group {
  const radius = 0.8;
  // C7 连续曲面:环形输送面 + 机架环带整体成型,替代旧弦段拼接近似;弧段中心落在 +z。
  const thetaStart = -Math.PI / 2 - arc / 2;
  const belt = new THREE.Mesh(new THREE.RingGeometry(radius - 0.21, radius + 0.21, 48, 1, thetaStart, arc), kit.rubber);
  belt.rotation.x = -Math.PI / 2;
  belt.position.y = 0.48;
  g.add(belt);
  const frame = new THREE.Mesh(new THREE.RingGeometry(radius - 0.25, radius + 0.25, 48, 1, thetaStart, arc), kit.bodyDeep);
  frame.rotation.x = -Math.PI / 2;
  frame.position.y = 0.42;
  g.add(frame);
  for (const r of [radius - 0.21, radius + 0.21]) {
    // 内外弧缘护栏:torus 弧段仅支持从 +x 起弧,用父级组绕 y 转正起始角并保持水平面
    const holder = subgroupAt(g, 0, 0.55, 0);
    holder.rotation.y = arc / 2 - Math.PI / 2; // 弧心转到 +z,与环带朝向一致
    tubeAt(holder, kit.body, r, 0.03, 0, 0, 0, "x", arc, 48);
  }
  for (let i = 0; i < 3; i++) {
    const phi = thetaStart + (arc * (i + 0.5)) / 3;
    const x = Math.cos(phi) * radius;
    const z = -Math.sin(phi) * radius;
    boxAt(g, kit.metal, 0.035, 0.42, 0.035, x, 0.21, z);
    boxAt(g, kit.rubber, 0.08, 0.015, 0.08, x, 0.008, z);
  }
  cylAt(g, kit.dark, 0.06, 0.06, 0.16, Math.cos(thetaStart) * 0.92, 0.32, -Math.sin(thetaStart) * 0.92, "y", 14); // 弧端驱动(机架下方)
  return g;
}

function buildSorterConveyor(g: THREE.Group, kit: ModelKit): THREE.Group {
  const g2 = buildStraightBelt(g, kit, 1.9);
  for (const x of [-0.55, -0.1, 0.35, 0.8]) {
    boxAt(g2, kit.bodyDeep, 0.34, 0.1, 0.5, x, 0.53, 0); // 交叉带小车
    boxAt(g2, kit.rubber, 0.3, 0.02, 0.44, x, 0.59, 0);
  }
  return g2;
}

function buildStraightBelt(g: THREE.Group, kit: ModelKit, length: number): THREE.Group {
  boxAt(g, kit.body, length, 0.1, 0.5, 0, 0.42, 0);
  boxAt(g, kit.rubber, length - 0.06, 0.03, 0.44, 0, 0.48, 0);
  for (const x of [-length / 2 + 0.12, 0, length / 2 - 0.12]) for (const z of [-0.24, 0.24]) {
    boxAt(g, kit.metal, 0.035, 0.42, 0.035, x, 0.21, z);
  }
  cylAt(g, kit.metal, 0.07, 0.07, 0.54, -length / 2, 0.47, 0, "z");
  cylAt(g, kit.dark, 0.05, 0.05, 0.16, -length / 2, 0.47, 0.36, "z");
  return g;
}

function buildSpiralConveyor(g: THREE.Group, kit: ModelKit): THREE.Group {
  cylAt(g, kit.metal, 0.07, 0.07, 1.3, 0, 0.65, 0); // 中心柱
  // C7 连续螺旋面:双道螺旋管构成输送带缘,替代旧弦段台阶
  helixTubeAt(g, kit.rubber, { radius: 0.42, height: 1.15, turns: 1.5, tube: 0.04 });
  helixTubeAt(g, kit.bodyDeep, { radius: 0.42, height: 1.15, turns: 1.5, tube: 0.026, startAngle: Math.PI * 0.92 });
  const turns = 1.5;
  for (let i = 0; i <= 9; i++) {
    const t = i / 9;
    const angle = t * turns * Math.PI * 2;
    const spoke = boxAt(g, kit.bodyDeep, 0.4, 0.026, 0.06, Math.cos(angle) * 0.22, 0.1 + t * 1.17, Math.sin(angle) * 0.22); // 螺旋辐板
    spoke.rotation.y = -angle;
  }
  boxAt(g, kit.bodyDeep, 0.32, 0.2, 0.3, 0.48, 0.12, 0); // 底部进料口
  boxAt(g, kit.bodyDeep, 0.32, 0.2, 0.3, -0.48, 1.32, 0); // 顶部卸料口
  for (const [x, z] of [[-0.3, 0.3], [0.3, 0.3], [0, -0.3]] as const) boxAt(g, kit.metal, 0.04, 0.12, 0.04, x, 0.06, z);
  return g;
}

function buildVerticalLift(g: THREE.Group, kit: ModelKit): THREE.Group {
  // C2 内部机构:四柱框架 + 导轨 + 提升平台 + 配重吊链 + 顶梁电机
  for (const [x, z] of [[-0.3, -0.2], [0.3, -0.2], [-0.3, 0.2], [0.3, 0.2]] as const) {
    boxAt(g, kit.body, 0.07, 1.5, 0.07, x, 0.75, z); // 框架立柱
    boxAt(g, kit.metal, 0.025, 1.4, 0.025, x * 0.8, 0.75, z * 0.8); // 导轨
  }
  boxAt(g, kit.bodyDeep, 0.72, 0.1, 0.5, 0, 1.56, 0); // 顶梁
  cylAt(g, kit.bodyDeep, 0.07, 0.07, 0.12, 0, 1.67, 0); // 提升电机
  boxAt(g, kit.accent, 0.5, 0.04, 0.38, 0, 0.85, 0); // 提升平台
  boxAt(g, kit.metal, 0.46, 0.06, 0.05, 0, 0.94, 0.16); // 平台挡货护栏
  boxAt(g, kit.bodyDeep, 0.4, 0.3, 0.34, 0, 1.02, 0); // 载货
  boxAt(g, kit.dark, 0.18, 0.42, 0.09, 0, 0.45, -0.24); // 配重块
  for (const dx of [-0.05, 0.05]) cylAt(g, kit.dark, 0.012, 0.012, 1.12, dx, 0.98, -0.24); // 配重吊链
  boxAt(g, kit.dark, 0.64, 0.06, 0.46, 0, 0.03, 0); // 底座
  stackLightAt(g, kit, 0.32, 1.61, 0, 0.18);
  return g;
}
