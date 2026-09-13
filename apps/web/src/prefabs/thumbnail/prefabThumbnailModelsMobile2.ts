import * as THREE from "three";
import type { ModelKit, PrefabThumbnailVariant } from "./prefabThumbnailKit";
import { ballAt, boneMaterial, boxAt, capsuleAt, cylAt, stackLightAt, subgroupAt } from "./prefabThumbnailKit";

/**
 * 波次 C 移动设备扩量小样:堆高/潜伏顶升/料箱三型 AGV,
 * 半挂牵引车、自卸车(举升姿态)、洒水车、曲臂登高车(举臂姿态)、皮卡巡查车五型车辆。
 * 同族靠"几何 + 姿态 + 材质"三重区分:举升/举臂动作姿态是本组最强的区分来源。
 */

/** AGV 扩量分发。 */
export function buildAgvVariantModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group | undefined {
  switch (variant.subtype) {
    case "stacker": return buildStackerAgvModel(kit);
    case "latent-jack": return buildLatentJackModel(kit);
    case "tote-robot": return buildToteRobotModel(kit);
    default: return undefined;
  }
}

/** 车辆扩量分发。 */
export function buildVehicleVariantModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group | undefined {
  switch (variant.subtype) {
    case "tractor-unit": return buildTractorUnitModel(kit);
    case "dump-truck": return buildDumpTruckModel(kit);
    case "water-truck": return buildWaterTruckModel(kit);
    case "boom-lift": return buildBoomLiftModel(kit);
    case "patrol-pickup": return buildPatrolPickupModel(kit);
    default: return undefined;
  }
}

function wheelAt(g: THREE.Group, kit: ModelKit, x: number, z: number, r = 0.13, w = 0.09): void {
  cylAt(g, kit.rubber, r, r, w, x, r, z, "z", 16);
}

/** 作业车辆底盘:深色车架 + 前向驾驶室 + 风挡,车头朝 +x 的家族统一语言。 */
function truckChassis(g: THREE.Group, kit: ModelKit, length: number): void {
  boxAt(g, kit.dark, length, 0.14, 0.5, 0, 0.28, 0);
}

/** 堆高 AGV:跨腿 + 窄门架 + 高位货叉托盘,与对重叉车 AGV(无跨腿)拉开轮廓。 */
function buildStackerAgvModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 0.95, 0.05, 0.6, 0, 0.025, 0);
  boxAt(g, kit.body, 0.9, 0.2, 0.56, -0.1, 0.15, 0); // 电池舱体
  boxAt(g, kit.accent, 0.06, 0.12, 0.56, 0.36, 0.14, 0); // 前保险杠
  boxAt(g, kit.lampWarn, 0.88, 0.024, 0.015, -0.1, 0.24, 0.285); // 警示灯条
  // 跨腿:前伸双支腿 + 承重轮
  for (const z of [-0.22, 0.22]) {
    boxAt(g, kit.bodyDeep, 0.34, 0.08, 0.09, 0.5, 0.08, z);
    cylAt(g, kit.rubber, 0.06, 0.06, 0.06, 0.62, 0.06, z, "z", 12);
  }
  // 窄门架(双立柱 + 顶横梁)与高位货叉托盘
  for (const z of [-0.12, 0.12]) boxAt(g, kit.metal, 0.05, 0.86, 0.045, 0.42, 0.52, z);
  boxAt(g, kit.metal, 0.05, 0.05, 0.3, 0.42, 0.97, 0);
  for (const z of [-0.13, 0.13]) boxAt(g, kit.accent, 0.4, 0.03, 0.05, 0.58, 0.6, z); // 货叉(举升位)
  boxAt(g, kit.rubber, 0.5, 0.035, 0.36, 0.58, 0.655, 0); // 托盘
  boxAt(g, kit.bodyDeep, 0.36, 0.22, 0.3, 0.58, 0.785, 0); // 载货
  cylAt(g, kit.dark, 0.05, 0.05, 0.1, -0.3, 0.3, 0); // 雷达塔
  cylAt(g, kit.metal, 0.042, 0.042, 0.04, -0.3, 0.37, 0, "y", 16); // 激光雷达
  addAgvNavigationMark(g, kit, -0.05, 0.255);
  return g;
}

/** 潜伏顶升 AGV:低趴车体 + 小圆罩 + 中央顶升盘上大托盘(低罩大盘,与 AMR 的大圆罩剪影拉开)。 */
function buildLatentJackModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 0.9, 0.05, 0.62, 0, 0.025, 0);
  boxAt(g, kit.body, 0.86, 0.16, 0.58, 0, 0.13, 0); // 低趴车体
  ballAt(g, kit.bodyDeep, 0.27, 0, 0.17, 0, 1.35, 0.42, 0.66); // 小圆罩(只盖中舱,顶面 0.28)
  for (const x of [-0.32, 0.32]) for (const z of [-0.25, 0.25]) cylAt(g, kit.rubber, 0.09, 0.09, 0.05, x, 0.09, z, "z", 14);
  boxAt(g, kit.accent, 0.06, 0.1, 0.58, 0.46, 0.13, 0); // 保险杠
  boxAt(g, kit.lampWarn, 0.84, 0.022, 0.014, 0, 0.215, 0.295); // 灯条
  // 中央顶升机构:丝杆 + 大顶升盘 + 盘上标准托盘(行程中位,盘沿环露黄)
  cylAt(g, kit.metal, 0.07, 0.09, 0.09, 0, 0.32, 0); // 顶升丝杆
  cylAt(g, kit.accent, 0.27, 0.27, 0.025, 0, 0.375, 0); // 顶升盘(大于托盘)
  boxAt(g, kit.rubber, 0.48, 0.04, 0.36, 0, 0.408, 0); // 托盘
  for (const bx of [-0.17, 0.17]) boxAt(g, kit.rubber, 0.055, 0.035, 0.32, bx, 0.375, 0); // 托盘纵梁
  // 四角扫描触头
  for (const [x, z] of [[-0.38, -0.25], [0.38, -0.25], [-0.38, 0.25], [0.38, 0.25]] as const) {
    cylAt(g, kit.dark, 0.03, 0.03, 0.05, x, 0.23, z);
  }
  boxAt(g, boneMaterial(kit), 0.1, 0.1, 0.012, 0.42, 0.14, 0.2); // 前脸导航二维码
  boxAt(g, kit.dark, 0.03, 0.03, 0.014, 0.42, 0.14, 0.201);
  return g;
}

/** 料箱机器人:举升柱 + 双层料箱(带箱沿盖口)+ 顶部激光塔,料箱语义一眼可读。 */
function buildToteRobotModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 0.84, 0.05, 0.58, 0, 0.025, 0);
  boxAt(g, kit.body, 0.8, 0.18, 0.54, 0, 0.14, 0); // 车体
  boxAt(g, kit.accent, 0.05, 0.11, 0.54, 0.43, 0.14, 0); // 保险杠
  boxAt(g, kit.lampWarn, 0.78, 0.022, 0.014, 0, 0.235, 0.275); // 灯条
  boxAt(g, kit.metal, 0.4, 0.05, 0.42, 0, 0.255, 0); // 举升台板
  // 双层料箱:黄身 + 深色盖沿
  for (const y of [0.43, 0.71]) {
    boxAt(g, kit.accent, 0.42, 0.24, 0.34, 0, y, 0);
    boxAt(g, kit.dark, 0.44, 0.03, 0.36, 0, y + 0.12, 0);
  }
  cylAt(g, kit.dark, 0.045, 0.045, 0.1, -0.22, 0.36, 0); // 激光塔
  cylAt(g, kit.metal, 0.04, 0.04, 0.035, -0.22, 0.43, 0, "y", 16);
  addAgvNavigationMark(g, kit, 0.26, 0.262);
  return g;
}

/** AGV 导航码标志:二维码底 + 定位码块(与既有 addNavigationMarks 同语言的轻量版)。 */
function addAgvNavigationMark(g: THREE.Group, kit: ModelKit, x: number, topY: number): void {
  boxAt(g, boneMaterial(kit), 0.14, 0.006, 0.14, x, topY + 0.006, 0);
  boxAt(g, kit.dark, 0.04, 0.008, 0.04, x - 0.035, topY + 0.011, -0.035);
  boxAt(g, kit.dark, 0.026, 0.008, 0.026, x + 0.04, topY + 0.011, 0.04);
}

/** 半挂牵引车:高顶长驾驶室 + 排气歧管 + 车架尾部鞍座板,无货厢(与货车一眼区分)。 */
function buildTractorUnitModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  truckChassis(g, kit, 1.75);
  boxAt(g, kit.body, 0.52, 0.6, 0.56, 0.6, 0.65, 0); // 高顶驾驶室
  boxAt(g, kit.bodyDeep, 0.4, 0.16, 0.5, 0.56, 1.0, 0); // 导流罩
  boxAt(g, kit.glass, 0.04, 0.22, 0.46, 0.87, 0.72, 0); // 风挡
  boxAt(g, kit.glass, 0.34, 0.13, 0.5, 0.6, 0.82, 0); // 侧窗带
  boxAt(g, kit.metal, 0.5, 0.1, 0.4, 0.6, 0.26, 0); // 保险杠格栅
  cylAt(g, kit.metal, 0.035, 0.035, 0.72, 0.32, 0.62, -0.31); // 排气歧管
  // 尾部鞍座(第五轮)与牵引销
  boxAt(g, kit.metal, 0.36, 0.03, 0.46, -0.5, 0.38, 0);
  boxAt(g, kit.dark, 0.12, 0.035, 0.1, -0.5, 0.4, 0);
  cylAt(g, kit.dark, 0.028, 0.028, 0.05, -0.5, 0.42, 0, "y", 10);
  cylAt(g, kit.metal, 0.09, 0.09, 0.4, -0.1, 0.34, 0.31, "x"); // 侧挂油箱
  boxAt(g, kit.bodyDeep, 0.7, 0.06, 0.04, -0.35, 0.16, -0.28); // 侧防护板
  for (const x of [0.55, -0.35, -0.72]) for (const z of [-0.25, 0.25]) wheelAt(g, kit, x, z, 0.16, 0.11);
  stackLightAt(g, kit, 0.72, 1.1, 0.22, 0.14);
  return g;
}

/** 自卸车:前顶驾驶室 + 后倾举升货厢(姿态区分)+ 液压油缸。 */
function buildDumpTruckModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  truckChassis(g, kit, 1.65);
  boxAt(g, kit.body, 0.46, 0.42, 0.54, 0.58, 0.55, 0); // 驾驶室
  boxAt(g, kit.glass, 0.04, 0.16, 0.44, 0.82, 0.66, 0); // 风挡
  // 后倾举升货厢:绕尾部铰点旋转
  const bed = subgroupAt(g, -0.72, 0.36, 0);
  bed.rotation.z = 0.2;
  boxAt(bed, kit.bodyDeep, 1.05, 0.07, 0.56, 0.42, 0.04, 0); // 厢底
  for (const z of [-0.28, 0.28]) boxAt(bed, kit.bodyDeep, 1.05, 0.24, 0.05, 0.42, 0.19, z); // 侧板
  boxAt(bed, kit.bodyDeep, 0.05, 0.24, 0.56, 0.92, 0.19, 0); // 前板
  boxAt(bed, kit.accent, 0.9, 0.045, 0.04, 0.42, 0.24, 0); // 上沿加强筋
  // 液压油缸:车架中段斜顶厢底
  const hoist = cylAt(g, kit.metal, 0.03, 0.03, 0.36, -0.2, 0.47, 0);
  hoist.rotation.z = 0.5;
  for (const x of [0.52, -0.5, -0.78]) for (const z of [-0.25, 0.25]) wheelAt(g, kit, x, z, 0.15);
  return g;
}

/** 洒水车:横向胶囊罐体 + 罐顶人孔 + 前喷炮 + 尾部喷杆,罐车轮廓在车辆族唯一。 */
function buildWaterTruckModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  truckChassis(g, kit, 1.7);
  boxAt(g, kit.body, 0.44, 0.4, 0.52, 0.6, 0.54, 0); // 驾驶室
  boxAt(g, kit.glass, 0.04, 0.15, 0.42, 0.83, 0.64, 0); // 风挡
  capsuleAt(g, kit.body, 0.3, 0.75, -0.3, 0.62, 0, "x"); // 罐体
  for (const x of [-0.72, -0.3, 0.12]) cylAt(g, kit.metal, 0.308, 0.308, 0.025, x, 0.62, 0, "x", 24); // 罐体加强箍
  cylAt(g, kit.metal, 0.06, 0.06, 0.05, -0.3, 0.95, 0); // 人孔
  cylAt(g, kit.dark, 0.062, 0.062, 0.02, -0.3, 0.985, 0, "y", 14);
  // 前喷炮(罐肩斜置)
  const cannon = subgroupAt(g, 0.0, 0.95, 0);
  cannon.rotation.z = -0.5;
  cylAt(cannon, kit.metal, 0.028, 0.035, 0.18, 0, 0.09, 0, "y", 12);
  // 尾部喷杆 + 雾化喷头
  boxAt(g, kit.metal, 0.03, 0.5, 0.03, -0.8, 0.18, -0.2);
  boxAt(g, kit.metal, 0.03, 0.5, 0.03, -0.8, 0.18, 0.2);
  boxAt(g, kit.metal, 0.04, 0.03, 0.44, -0.8, 0.2, 0);
  for (const z of [-0.15, 0, 0.15]) cylAt(g, kit.dark, 0.016, 0.016, 0.05, -0.8, 0.16, z);
  boxAt(g, kit.bodyDeep, 0.9, 0.05, 0.08, -0.3, 0.34, 0.28); // 侧走台
  for (const x of [0.5, -0.45, -0.85]) for (const z of [-0.25, 0.25]) wheelAt(g, kit, x, z, 0.15);
  return g;
}

/** 曲臂式登高车:小驾驶室 + 二节曲臂(举臂姿态)+ 顶部吊篮 + 后支腿,高扬轮廓全族唯一。 */
function buildBoomLiftModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  truckChassis(g, kit, 1.5);
  boxAt(g, kit.body, 0.4, 0.34, 0.5, 0.55, 0.52, 0); // 驾驶室
  boxAt(g, kit.glass, 0.04, 0.14, 0.4, 0.76, 0.6, 0); // 风挡
  // 后支腿(斜撑落地)
  for (const z of [-0.3, 0.3]) {
    const leg = boxAt(g, kit.metal, 0.5, 0.05, 0.05, -0.45, 0.16, z);
    leg.rotation.y = z > 0 ? -0.35 : 0.35;
    boxAt(g, kit.dark, 0.1, 0.05, 0.1, -0.68, 0.03, z * 1.35);
  }
  // 转台 + 二节曲臂
  cylAt(g, kit.bodyDeep, 0.14, 0.16, 0.14, -0.35, 0.42, 0);
  const boom1 = subgroupAt(g, -0.35, 0.5, 0);
  boom1.rotation.z = 0.85;
  boxAt(boom1, kit.body, 0.72, 0.09, 0.1, 0.1, 0.3, 0); // 大臂(斜上)
  const elbow = subgroupAt(boom1, 0.14, 0.62, 0);
  elbow.rotation.z = -1.15;
  boxAt(elbow, kit.bodyDeep, 0.62, 0.08, 0.09, 0.1, 0.26, 0); // 小臂(折臂)
  // 顶部吊篮:底板 + 四柱 + 顶栏
  const basket = subgroupAt(elbow, 0.12, 0.55, 0);
  boxAt(basket, kit.accent, 0.3, 0.03, 0.28, 0, 0, 0);
  for (const [x, z] of [[-0.13, -0.11], [0.13, -0.11], [-0.13, 0.11], [0.13, 0.11]] as const) {
    boxAt(basket, kit.metal, 0.025, 0.26, 0.025, x, 0.15, z);
  }
  for (const z of [-0.11, 0.11]) boxAt(basket, kit.metal, 0.3, 0.025, 0.025, 0, 0.28, z);
  boxAt(basket, kit.bodyDeep, 0.18, 0.12, 0.16, 0, 0.09, 0); // 篮内人员/物料块
  for (const x of [0.45, -0.55]) for (const z of [-0.24, 0.24]) wheelAt(g, kit, x, z, 0.14);
  stackLightAt(g, kit, 0.55, 0.72, 0.2, 0.13);
  return g;
}

/** 皮卡巡查车:乘员舱 + 开放货斗 + 顶部警灯条 + 前防杠,巡逻语境三重编码。 */
function buildPatrolPickupModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 1.5, 0.14, 0.52, 0, 0.28, 0);
  boxAt(g, kit.body, 1.35, 0.24, 0.56, 0, 0.47, 0); // 下部车体
  boxAt(g, kit.body, 0.56, 0.3, 0.54, 0.28, 0.72, 0); // 乘员舱
  boxAt(g, kit.glass, 0.4, 0.14, 0.5, 0.34, 0.8, 0); // 舱玻璃带
  boxAt(g, kit.bodyDeep, 0.62, 0.2, 0.5, -0.42, 0.66, 0); // 货斗围板
  boxAt(g, kit.dark, 0.58, 0.03, 0.46, -0.42, 0.57, 0); // 货斗底
  boxAt(g, kit.metal, 0.08, 0.12, 0.5, 0.72, 0.42, 0); // 前防杠
  boxAt(g, kit.dark, 0.36, 0.045, 0.09, 0.28, 0.9, 0); // 警灯条座
  boxAt(g, kit.lampWarn, 0.34, 0.035, 0.07, 0.28, 0.935, 0); // 黄段警灯
  boxAt(g, kit.lampDanger, 0.08, 0.035, 0.07, 0.07, 0.935, 0); // 红段警灯
  cylAt(g, kit.dark, 0.008, 0.008, 0.2, -0.05, 0.95, -0.22); // 云台立杆
  ballAt(g, kit.bodyDeep, 0.035, -0.05, 1.06, -0.22); // 车载云台
  boxAt(g, kit.lampRun, 0.02, 0.04, 0.1, 0.75, 0.44, 0.18); // 前示宽灯
  for (const x of [0.5, -0.55]) for (const z of [-0.27, 0.27]) wheelAt(g, kit, x, z, 0.14);
  return g;
}
