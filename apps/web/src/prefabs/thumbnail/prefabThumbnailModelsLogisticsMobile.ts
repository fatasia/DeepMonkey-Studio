import * as THREE from "three";
import type { ModelKit, PrefabThumbnailVariant } from "./prefabThumbnailKit";
import { THUMB_COLORS, ballAt, boneMaterial, boxAt, capsuleAt, cylAt, stackLightAt, subgroupAt, tubeAt } from "./prefabThumbnailKit";
import { buildUavModel } from "./prefabThumbnailModelsLogistics2";
import { buildAgvVariantModel, buildVehicleVariantModel } from "./prefabThumbnailModelsMobile2";
/** AGV:低底盘 + 差速轮 + 雷达塔 + 警示灯条,按 subtype 增配门架/顶板/挂钩/无人机。 */
export function buildAgvModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group {
  const g = kit.group;
  const subtype = variant.subtype ?? "carrier";
  if (subtype === "uav") return buildUavModel(g, kit);
  // 2026-09-12 扩量:堆高/潜伏顶升/料箱三型走专用构建器
  const waveC = buildAgvVariantModel(kit, variant);
  if (waveC) return waveC;
  boxAt(g, kit.dark, 0.95, 0.05, 0.62, 0, 0.025, 0);
  boxAt(g, kit.body, 0.9, 0.2, 0.58, 0, 0.15, 0);
  for (const x of [-0.3, 0.3]) for (const z of [-0.26, 0.26]) cylAt(g, kit.rubber, 0.1, 0.1, 0.05, x, 0.1, z, "z", 18);
  boxAt(g, kit.accent, 0.06, 0.12, 0.58, 0.48, 0.14, 0); // 前保险杠
  boxAt(g, kit.lampWarn, 0.9, 0.025, 0.015, 0, 0.24, 0.295); // 警示灯条
  boxAt(g, kit.lampDanger, 0.05, 0.025, 0.015, 0.42, 0.24, -0.293);
  cylAt(g, kit.dark, 0.05, 0.05, 0.1, -0.28, 0.3, 0); // 雷达塔
  cylAt(g, kit.metal, 0.045, 0.045, 0.045, -0.28, 0.37, 0, "y", 18); // 激光雷达
  if (subtype === "forklift") {
    for (const z of [-0.09, 0.09]) boxAt(g, kit.metal, 0.05, 0.7, 0.04, 0.5, 0.45, z); // 门架
    for (const z of [-0.12, 0.12]) {
      boxAt(g, kit.accent, 0.4, 0.03, 0.05, 0.72, 0.05, z); // 货叉
      boxAt(g, kit.accent, 0.05, 0.12, 0.05, 0.54, 0.1, z);
    }
  } else if (subtype === "tugger") {
    // 牵引式:后挂钩 + 拖杆 + 一节挂车(牵引列车语义,与背负式一眼区分)
    boxAt(g, kit.metal, 0.16, 0.03, 0.05, -0.62, 0.14, 0); // 拖杆
    cylAt(g, kit.dark, 0.035, 0.035, 0.05, -0.7, 0.16, 0, "z", 12); // 挂钩座
    const trailer = subgroupAt(g, -1.05, 0, 0);
    boxAt(trailer, kit.bodyDeep, 0.5, 0.07, 0.5, 0, 0.16, 0); // 挂车台面
    boxAt(trailer, kit.accent, 0.34, 0.16, 0.34, 0, 0.28, 0); // 载货
    for (const x of [-0.16, 0.16]) for (const z of [-0.2, 0.2]) cylAt(trailer, kit.rubber, 0.07, 0.07, 0.05, x, 0.07, z, "z", 14); // 挂车轮
  } else if (subtype === "shelf-amr") {
    for (const [x, z] of [[-0.38, -0.24], [0.38, -0.24], [-0.38, 0.24], [0.38, 0.24]] as const) {
      boxAt(g, kit.metal, 0.04, 0.34, 0.04, x, 0.42, z); // 顶升立柱
    }
    boxAt(g, kit.bodyDeep, 0.9, 0.05, 0.6, 0, 0.61, 0); // 背负货架板
    boxAt(g, kit.accent, 0.5, 0.3, 0.4, 0, 0.79, 0); // 货箱
  } else if (subtype === "amr") {
    // 自主移动机器人:圆背壳罩 + 前传感带,与单元载荷的平顶台拉开轮廓差
    ballAt(g, kit.bodyDeep, 0.42, 0, 0.4, 0, 1.12, 0.44, 0.9);
    boxAt(g, kit.dark, 0.88, 0.05, 0.05, 0, 0.3, 0.29);
    boxAt(g, kit.lampRun, 0.5, 0.018, 0.015, 0, 0.33, 0.3);
  } else if (subtype === "unit-load") {
    boxAt(g, kit.bodyDeep, 0.7, 0.08, 0.5, 0, 0.29, 0); // 载荷台
    // 台上标准托盘:与背负式(平顶)和 AMR(圆背壳)拉开轮廓
    boxAt(g, kit.rubber, 0.56, 0.035, 0.42, 0, 0.35, 0);
    for (const bx of [-0.19, 0.19]) boxAt(g, kit.rubber, 0.06, 0.03, 0.38, bx, 0.315, 0);
  }
  if (subtype === "carrier" || subtype === "tugger" || subtype === "unit-load") {
    // C5 空载态:顶面平坦 + 二维码导航标志与磁带路径标记
    const topY = subtype === "unit-load" ? 0.33 : 0.25;
    addNavigationMarks(g, kit, 0.18, topY);
  } else if (subtype === "amr") {
    addNavigationMarks(g, kit, 0.05, 0.585); // 壳顶导航码
  }
  return g;
}

/** C5 导航标志:二维码标识底 + 两个定位码块 + 前向磁带路径条。 */
function addNavigationMarks(g: THREE.Group, kit: ModelKit, x: number, topY: number): void {
  boxAt(g, boneMaterial(kit), 0.16, 0.006, 0.16, x, topY + 0.006, 0); // 二维码标志底
  boxAt(g, kit.dark, 0.05, 0.008, 0.05, x - 0.04, topY + 0.011, -0.04);
  boxAt(g, kit.dark, 0.03, 0.008, 0.03, x + 0.05, topY + 0.011, 0.05);
  boxAt(g, kit.accent, 0.46, 0.004, 0.02, x - 0.22, topY + 0.005, 0.14); // 磁带路径标
}

/** 车辆:叉车 / 前移式叉车 / 货车 / 园区车 / 牵引车。 */
export function buildVehicleModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group {
  const g = kit.group;
  const subtype = variant.subtype ?? "car";
  // 2026-09-12 扩量:牵引车/自卸车/洒水车/登高车/皮卡巡查走专用构建器
  const waveC = buildVehicleVariantModel(kit, variant);
  if (waveC) return waveC;
  const wheel = (x: number, z: number, r = 0.14) => cylAt(g, kit.rubber, r, r, 0.1, x, r, z, "z", 18);
  if (subtype === "forklift" || subtype === "reach-truck") {
    const narrow = subtype === "reach-truck";
    const bodyW = narrow ? 0.5 : 0.62;
    boxAt(g, kit.body, 1.0, 0.34, bodyW, -0.1, 0.3, 0); // 车体
    boxAt(g, kit.bodyDeep, 0.34, 0.3, bodyW + 0.06, -0.62, 0.32, 0); // 配重
    for (const z of [-0.12, 0.12]) { wheel(-0.55, z, 0.13); wheel(0.25, z, 0.11); }
    for (const z of [-0.09, 0.09]) boxAt(g, kit.metal, 0.05, 0.85, 0.05, 0.42, 0.55, z); // 门架
    for (const z of [-0.12, 0.12]) {
      boxAt(g, kit.accent, 0.42, 0.03, 0.05, 0.66, 0.06, z); // 货叉
      boxAt(g, kit.accent, 0.05, 0.14, 0.05, 0.47, 0.12, z);
    }
    // 驾驶护顶架
    for (const [x, z] of [[-0.28, -bodyW / 2 + 0.05], [-0.28, bodyW / 2 - 0.05], [0.02, -bodyW / 2 + 0.05], [0.02, bodyW / 2 - 0.05]] as const) {
      boxAt(g, kit.dark, 0.035, 0.55, 0.035, x, 0.75, z);
    }
    boxAt(g, kit.dark, 0.4, 0.03, bodyW, -0.13, 1.04, 0);
    boxAt(g, kit.dark, 0.24, 0.16, 0.2, -0.15, 0.55, 0); // 座椅
    stackLightAt(g, kit, 0.02, 1.06, 0, 0.16);
    return g;
  }
  if (subtype === "truck") {
    boxAt(g, kit.body, 0.5, 0.5, 0.55, 0.62, 0.42, 0); // 驾驶室
    boxAt(g, kit.glass, 0.04, 0.22, 0.45, 0.88, 0.5, 0); // 风挡
    boxAt(g, kit.bodyDeep, 1.3, 0.62, 0.6, -0.35, 0.5, 0); // 厢体
    boxAt(g, kit.dark, 1.7, 0.16, 0.5, 0, 0.25, 0); // 底盘
    for (const x of [0.6, -0.25, -0.75]) for (const z of [-0.26, 0.26]) wheel(x, z, 0.16);
    return g;
  }
  if (subtype === "tow-tractor") {
    boxAt(g, kit.body, 0.7, 0.36, 0.56, 0.1, 0.32, 0);
    boxAt(g, kit.glass, 0.2, 0.16, 0.44, 0.34, 0.56, 0);
    boxAt(g, kit.bodyDeep, 0.4, 0.3, 0.5, -0.42, 0.3, 0); // 配重 ballast
    for (const x of [0.32, -0.42]) for (const z of [-0.24, 0.24]) wheel(x, z, 0.13);
    cylAt(g, kit.metal, 0.04, 0.04, 0.06, -0.72, 0.2, 0, "z", 12);
    return g;
  }
  // 园区车辆:封闭厢式车
  boxAt(g, kit.body, 1.1, 0.42, 0.56, 0, 0.42, 0);
  boxAt(g, kit.glass, 0.9, 0.14, 0.58, -0.02, 0.56, 0); // 侧窗带
  boxAt(g, kit.dark, 1.15, 0.14, 0.52, 0, 0.16, 0);
  for (const x of [0.36, -0.38]) for (const z of [-0.25, 0.25]) wheel(x, z, 0.13);
  boxAt(g, kit.lampRun, 0.02, 0.04, 0.1, 0.56, 0.3, 0.16);
  return g;
}

/** 人员:C1 分色胶囊人形。五型用"头部装备 + 背心有无 + 手持物"三重编码区分:
 *  作业员=黄帽+背心空手,巡检=深色鸭舌帽+手持检测仪(抬臂),访客=便装白帽+访客证,
 *  维修=橙帽+背心+侧挂工具箱,操作员=黄帽+背心+胸前记录板。 */
export function buildPersonModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group {
  const g = kit.group;
  const subtype = variant.subtype ?? "worker";
  const visitor = subtype === "visitor";
  const skin = boneMaterial(kit);
  const legs = subgroupAt(g);
  for (const x of [-0.07, 0.07]) capsuleAt(legs, kit.dark, 0.05, 0.34, x, 0.24, 0); // 工装裤(深色)
  for (const x of [-0.07, 0.07]) boxAt(legs, kit.rubber, 0.075, 0.06, 0.12, x, 0.045, 0.015); // C1 靴子分色
  capsuleAt(g, visitor ? skin : kit.body, 0.13, 0.3, 0, 0.66, 0); // 躯干(访客便装)
  if (!visitor) {
    boxAt(g, kit.lampWarn, 0.2, 0.15, 0.02, 0, 0.67, 0.128); // C1 反光背心前片
    boxAt(g, kit.lampWarn, 0.2, 0.15, 0.02, 0, 0.67, -0.128); // 背片
    for (const x of [-0.06, 0.06]) boxAt(g, skin, 0.018, 0.15, 0.024, x, 0.67, 0.138); // 银灰反光竖条
  } else {
    boxAt(g, kit.screen, 0.06, 0.08, 0.012, 0.05, 0.72, 0.125); // 访客证
  }
  ballAt(g, skin, 0.09, 0, 0.94, 0); // 头
  if (subtype === "inspector") {
    cylAt(g, kit.dark, 0.095, 0.1, 0.075, 0, 1.0, 0, "y", 18); // 鸭舌帽壳
    boxAt(g, kit.dark, 0.09, 0.014, 0.1, 0, 0.98, 0.1); // 帽舌
    boxAt(g, kit.lampDanger, 0.05, 0.02, 0.012, 0, 1.02, 0.096); // 帽徽
  } else {
    const helmetColor = visitor ? THUMB_COLORS.bone : subtype === "maintenance" ? 0xd97a2e : THUMB_COLORS.safety;
    const helmet = new THREE.MeshStandardMaterial({ color: helmetColor, roughness: 0.35, metalness: 0.1 });
    ballAt(g, helmet, 0.105, 0, 0.99, 0, 1, 0.72, 1); // 帽壳
    tubeAt(g, helmet, 0.1, 0.012, 0, 0.965, 0, "y", Math.PI * 2, 24); // 帽檐
    boxAt(g, helmet, 0.014, 0.05, 0.09, 0, 0.9, 0.095); // C1 帽壳前檐脊
  }
  const armMat = visitor ? skin : kit.body;
  const armLeft = capsuleAt(g, armMat, 0.045, 0.26, -0.17, 0.62, 0);
  armLeft.rotation.z = 0.32;
  const armRight = capsuleAt(g, armMat, 0.045, 0.26, 0.17, 0.62, 0);
  armRight.rotation.z = -0.32;
  if (subtype === "inspector") {
    armRight.rotation.z = -1.2;
    armRight.position.set(0.2, 0.68, 0.05);
    boxAt(g, kit.dark, 0.09, 0.14, 0.03, 0.25, 0.83, 0.09); // 手持检测仪
    boxAt(g, kit.lampRun, 0.03, 0.02, 0.01, 0.25, 0.88, 0.1);
  } else if (subtype === "maintenance") {
    boxAt(g, kit.accent, 0.18, 0.13, 0.13, 0.27, 0.36, 0.06); // 手提工具箱(抬臂手持高度,提手对齐掌位)
    boxAt(g, kit.metal, 0.09, 0.016, 0.02, 0.27, 0.44, 0.06); // 提手
  } else if (subtype === "operator") {
    const board = boxAt(g, skin, 0.14, 0.2, 0.015, 0.06, 0.6, 0.16); // 胸前记录板
    board.rotation.x = -0.5;
    boxAt(g, kit.screen, 0.1, 0.13, 0.008, 0.06, 0.61, 0.185); // 板上表格
  }
  return g;
}
