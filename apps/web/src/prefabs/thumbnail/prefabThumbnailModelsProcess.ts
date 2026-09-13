import * as THREE from "three";
import type { ModelKit, PrefabThumbnailVariant } from "./prefabThumbnailKit";
import { ballAt, boltQuadAt, boxAt, cylAt, flangeAt, grilleAt, panelSeamAt, stackLightAt, subgroupAt, tubeAt, ventDotsAt } from "./prefabThumbnailKit";
import { buildGantryMillModel, buildGrinderModel, buildHeatTreatFurnaceModel, buildPressModel } from "./prefabThumbnailModelsProcess2";

/**
 * 公用工程与生产设备小样:pump / valve / fan / compressor / cabinet / drive / meter / machine / display。
 * 轮廓按 family 分型,比例取真实设备惯性印象(米制),取景交给渲染器包围盒自动适配。
 */

export function buildPumpModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 1.0, 0.1, 0.46, 0, 0.05, 0); // 底座型钢
  if (variant.tail === "dosing") {
    // 计量泵:立式小电机 + 泵头 + 药箱
    cylAt(g, kit.body, 0.13, 0.13, 0.34, -0.1, 0.29, 0);
    boxAt(g, kit.metal, 0.16, 0.16, 0.16, 0.14, 0.24, 0);
    boxAt(g, kit.bodyDeep, 0.3, 0.36, 0.26, 0.34, 0.3, 0);
    boxAt(g, kit.screen, 0.1, 0.05, 0.01, 0.34, 0.38, 0.14);
    cylAt(g, kit.bodyDeep, 0.14, 0.14, 0.3, -0.1, 0.6, 0);
    return g;
  }
  // 离心泵:卧式电机(带散热环 + 接线盒)+ 蜗壳 + 竖直排出管 + 吸入法兰
  cylAt(g, kit.body, 0.18, 0.18, 0.46, -0.2, 0.33, 0, "x");
  for (const offset of [-0.12, 0, 0.12]) tubeAt(g, kit.bodyDeep, 0.185, 0.014, -0.2 + offset * 0.9, 0.33, 0, "x");
  boxAt(g, kit.dark, 0.14, 0.09, 0.14, -0.2, 0.47, 0);
  boltQuadAt(g, kit, 0.88, 0.36, 0, 0.1, 0); // 底座地脚螺栓(波次 E 贴花)
  cylAt(g, kit.bodyDeep, 0.23, 0.23, 0.18, 0.24, 0.33, 0, "x"); // 泵腔
  tubeAt(g, kit.body, 0.23, 0.05, 0.24, 0.33, 0, "x"); // 蜗壳外环
  cylAt(g, kit.metal, 0.075, 0.075, 0.2, 0.24, 0.48, 0, "y"); // 排出立管
  flangeAt(g, kit, 0.09, 0.24, 0.6, 0, "y");
  cylAt(g, kit.metal, 0.085, 0.085, 0.1, 0.42, 0.33, 0, "x"); // 吸入口
  flangeAt(g, kit, 0.1, 0.48, 0.33, 0, "x");
  stackLightAt(g, kit, 0.1, 0.58, 0, 0.2);
  return g;
}

export function buildValveModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group {
  const g = kit.group;
  // 两侧管线与端面法兰
  for (const side of [-1, 1]) {
    cylAt(g, kit.dark, 0.1, 0.1, 0.42, side * 0.44, 0.24, 0, "x");
    flangeAt(g, kit, 0.12, side * 0.64, 0.24, 0, "x");
  }
  ballAt(g, kit.body, 0.17, 0, 0.24, 0, 1, 0.82, 1); // 阀体
  cylAt(g, kit.bodyDeep, 0.075, 0.11, 0.14, 0, 0.4, 0, "y"); // 阀帽
  if (variant.tail === "control") {
    // 调节阀:薄膜执行器(圆顶)+ 拱形轭架 + 定位器
    cylAt(g, kit.metal, 0.03, 0.03, 0.12, 0, 0.52, 0, "y");
    ballAt(g, kit.accent, 0.17, 0, 0.72, 0, 1, 0.62, 1);
    tubeAt(g, kit.bodyDeep, 0.17, 0.02, 0, 0.66, 0, "y");
    boxAt(g, kit.dark, 0.09, 0.07, 0.05, 0.14, 0.62, 0);
  } else {
    // 闸阀:轭架 + 手轮(轮缘 + 三辐 + 毂)
    for (const offset of [-0.05, 0.05]) boxAt(g, kit.metal, 0.02, 0.1, 0.02, offset, 0.5, 0);
    tubeAt(g, kit.accent, 0.15, 0.016, 0, 0.58, 0, "y");
    const wheel = subgroupAt(g, 0, 0.58, 0);
    for (let i = 0; i < 3; i++) {
      const spoke = boxAt(wheel, kit.accent, 0.3, 0.012, 0.02, 0, 0, 0);
      spoke.rotation.y = (i * Math.PI) / 3;
    }
    cylAt(wheel, kit.metal, 0.024, 0.024, 0.05, 0, 0, 0);
  }
  return g;
}

export function buildFanModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group {
  const g = kit.group;
  if (variant.tail === "exhaust") {
    // 排风机:方形箱体 + 前圆开口 + 侧装电机
    boxAt(g, kit.body, 0.6, 0.6, 0.26, 0, 0.46, 0);
    cylAt(g, kit.bodyDeep, 0.23, 0.23, 0.08, 0, 0.46, 0.16, "z");
    tubeAt(g, kit.body, 0.23, 0.02, 0, 0.46, 0.21, "z");
    addImpeller(g, kit, 0, 0.46, 0.1, 0.2);
    cylAt(g, kit.bodyDeep, 0.09, 0.09, 0.2, 0, 0.46, -0.24, "z"); // 后置电机
    boxAt(g, kit.dark, 0.5, 0.08, 0.34, 0, 0.04, 0);
    grilleAt(g, kit.dark, 0.4, 5, 0, 0.62, -0.132);
    return g;
  }
  // 轴流风机:风筒 + 叶轮 + 前防护网 + 落地支架
  cylAt(g, kit.body, 0.33, 0.33, 0.3, 0, 0.44, 0, "z");
  for (const side of [-1, 1]) tubeAt(g, kit.bodyDeep, 0.335, 0.02, 0, 0.44, side * 0.15, "z");
  addImpeller(g, kit, 0, 0.44, -0.02, 0.26);
  tubeAt(g, kit.metal, 0.3, 0.01, 0, 0.44, 0.16, "z"); // 防护网外圈
  const guard = subgroupAt(g, 0, 0.44, 0.16);
  for (let i = 0; i < 2; i++) {
    const bar = boxAt(guard, kit.metal, 0.58, 0.008, 0.008, 0, 0, 0);
    bar.rotation.z = (i * Math.PI) / 2;
  }
  cylAt(g, kit.bodyDeep, 0.08, 0.08, 0.14, 0, 0.44, -0.24, "z"); // 电机
  for (const [x, z] of [[-0.22, 0.18], [0.22, 0.18], [0, -0.24]] as const) {
    boxAt(g, kit.dark, 0.04, 0.3, 0.04, x, 0.15, z);
    boxAt(g, kit.rubber, 0.09, 0.02, 0.09, x, 0.01, z);
  }
  return g;
}

function addImpeller(g: THREE.Group, kit: ModelKit, x: number, y: number, z: number, bladeLength: number): void {
  cylAt(g, kit.dark, 0.075, 0.075, 0.07, x, y, z, "z"); // 轮毂
  const hub = subgroupAt(g, x, y, z);
  for (let i = 0; i < 5; i++) {
    const arm = subgroupAt(hub);
    arm.rotation.z = (i * Math.PI * 2) / 5;
    const blade = boxAt(arm, kit.metal, 0.05, bladeLength, 0.016, 0, bladeLength / 2 + 0.05, 0);
    blade.rotation.x = 0.5; // 叶片攻角
  }
}

export function buildCompressorModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  // 卧式储气罐:圆柱 + 两端半球封头
  cylAt(g, kit.body, 0.25, 0.25, 0.85, 0, 0.42, 0, "x");
  ballAt(g, kit.body, 0.25, -0.425, 0.42, 0);
  ballAt(g, kit.body, 0.25, 0.425, 0.42, 0);
  for (const x of [-0.26, 0.26]) boxAt(g, kit.dark, 0.09, 0.3, 0.3, x, 0.15, 0); // 支脚
  // 顶部机头:电机 + 泵头 + 散热格栅
  cylAt(g, kit.bodyDeep, 0.11, 0.11, 0.36, -0.08, 0.78, 0, "x");
  grilleAt(g, kit.dark, 0.3, 5, -0.08, 0.66, 0.115);
  boxAt(g, kit.dark, 0.16, 0.13, 0.15, 0.18, 0.78, 0);
  // 压力表 + 安全阀 + 电气盒
  cylAt(g, kit.metal, 0.012, 0.012, 0.1, 0.32, 0.6, 0.08, "y");
  ballAt(g, kit.metal, 0.045, 0.32, 0.68, 0.08);
  tubeAt(g, kit.accent, 0.03, 0.012, 0.05, 0.7, 0, "y");
  boxAt(g, kit.accent, 0.14, 0.16, 0.1, 0.4, 0.24, 0.24);
  boxAt(g, kit.screen, 0.08, 0.05, 0.008, 0.4, 0.28, 0.295);
  return g;
}

export function buildCabinetModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group {
  const g = kit.group;
  if (variant.family === "meter") {
    // 智能电表:壁挂小方盒 + LCD + 端子盖;背面挂装细节保证背视角不退化为色块
    boxAt(g, kit.body, 0.34, 0.44, 0.12, 0, 0.5, 0);
    boxAt(g, kit.dark, 0.26, 0.1, 0.02, 0, 0.62, 0.07);
    boxAt(g, kit.screen, 0.14, 0.07, 0.01, 0, 0.62, 0.085);
    boxAt(g, kit.dark, 0.28, 0.14, 0.02, 0, 0.42, 0.07);
    for (let i = 0; i < 4; i++) cylAt(g, kit.metal, 0.012, 0.012, 0.03, -0.09 + i * 0.06, 0.42, 0.085, "z");
    boxAt(g, kit.dark, 0.2, 0.3, 0.03, 0, 0.5, -0.07); // 背面挂装支架
    cylAt(g, kit.dark, 0.02, 0.024, 0.05, 0.08, 0.3, -0.09, "z", 10); // 电缆入线嘴
    grilleAt(g, kit.dark, 0.16, 3, -0.06, 0.56, -0.062, 0.02); // 背面散热槽
    return g;
  }
  const isDrive = variant.family === "drive";
  const w = 0.6;
  const h = 1.05;
  const d = 0.42;
  // 柜体:深色槽钢底座 + 机身 + 门缝 + 把手 + 格栅 + HMI + 三色灯
  boxAt(g, kit.dark, w - 0.06, 0.08, d - 0.05, 0, 0.04, 0);
  boxAt(g, kit.body, w, h, d, 0, 0.08 + h / 2, 0);
  const faceZ = d / 2 + 0.004;
  if (variant.tail === "mcc") {
    // MCC 双门缝 + 三只电流表圆窗(与 PLC/变频柜拉开正面语义)
    for (const x of [-w / 4, w / 4]) boxAt(g, kit.dark, 0.01, h - 0.1, 0.006, x, 0.08 + h / 2, faceZ);
    for (const x of [-0.15, 0, 0.15]) {
      cylAt(g, kit.dark, 0.042, 0.042, 0.012, x, 0.93, faceZ + 0.006, "z", 16);
      tubeAt(g, kit.metal, 0.044, 0.008, x, 0.93, faceZ + 0.012, "z", Math.PI * 2, 16);
      boxAt(g, kit.lampRun, 0.014, 0.014, 0.006, x, 0.955, faceZ + 0.014);
    }
  } else if (variant.tail === "plc") {
    // PLC 柜:观察窗内三排 I/O 模块指示灯,正面即"控制柜"语义(层次错开防 z-fighting)
    boxAt(g, kit.dark, 0.42, 0.56, 0.012, 0, 0.5, faceZ + 0.001);
    for (let row = 0; row < 3; row++) {
      boxAt(g, kit.bodyDeep, 0.32, 0.1, 0.016, 0, 0.64 - row * 0.17, faceZ + 0.016); // 模块排
      for (let col = 0; col < 5; col += 1) {
        const lamp = [kit.lampRun, kit.lampWarn, kit.lampDanger][(row + col) % 3] ?? kit.lampRun;
        boxAt(g, lamp, 0.024, 0.024, 0.012, -0.12 + col * 0.06, 0.66 - row * 0.17, faceZ + 0.026);
      }
    }
  } else {
    boxAt(g, kit.dark, 0.01, h - 0.1, 0.006, 0, 0.08 + h / 2, faceZ);
  }
  for (const x of [-w / 2 + 0.06, w / 2 - 0.06]) cylAt(g, kit.metal, 0.011, 0.011, 0.15, x, 0.35, faceZ + 0.012, "y"); // 把手(靠两侧立柱,给 PLC 模块窗让位)
  grilleAt(g, kit.dark, w * 0.55, 5, 0, 0.2, faceZ + 0.002);
  boxAt(g, kit.dark, 0.2, 0.16, 0.012, -0.12, 0.78, faceZ + 0.004); // HMI 边框
  boxAt(g, kit.screen, 0.165, 0.125, 0.01, -0.12, 0.78, faceZ + 0.012);
  grilleAt(g, kit.dark, w * 0.55, 4, 0, 0.98, faceZ + 0.002);
  panelSeamAt(g, kit, w - 0.1, 0, 0.62, faceZ + 0.003); // 柜门横向分缝(波次 E 贴花)
  panelSeamAt(g, kit, w - 0.1, 0, 0.33, faceZ + 0.003);
  boltQuadAt(g, kit, w - 0.08, d - 0.08, 0, 0.085, 0); // 槽钢底座四角地脚螺栓
  stackLightAt(g, kit, w / 2 - 0.06, 0.08 + h, 0, 0.22);
  if (isDrive) {
    // 变频柜:正面散热风圈 + 参数显示屏
    tubeAt(g, kit.dark, 0.09, 0.014, 0.18, 0.78, faceZ + 0.004, "z");
    boxAt(g, kit.screen, 0.13, 0.05, 0.01, 0.18, 0.62, faceZ + 0.008);
  }
  return g;
}

export function buildMachineModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group {
  switch (variant.process) {
    case "turning": return buildLatheModel(kit);
    case "laser-welding": return buildWeldingCellModel(kit);
    case "bending": return buildPressBrakeModel(kit);
    case "injection": return buildInjectionMolderModel(kit);
    case "inspection": return buildInspectionModel(kit);
    case "gantry": return buildGantryMillModel(kit);
    case "grinding": return buildGrinderModel(kit);
    case "pressing": return buildPressModel(kit);
    case "heat-treat": return buildHeatTreatFurnaceModel(kit);
    default: return buildMillModel(kit);
  }
}

/** 数控加工中心:底座 + 立柱 + 主轴头 + 工作台 + 半透明防护罩 + 悬臂屏。 */
function buildMillModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 1.15, 0.18, 0.85, 0, 0.09, 0);
  boxAt(g, kit.body, 0.68, 0.95, 0.3, 0, 0.68, -0.28); // 立柱
  boxAt(g, kit.bodyDeep, 0.34, 0.3, 0.24, 0, 0.84, -0.08); // 主轴头滑座
  cylAt(g, kit.metal, 0.045, 0.045, 0.22, 0, 0.58, -0.08, "y"); // 主轴
  cylAt(g, kit.accent, 0.055, 0.055, 0.05, 0, 0.46, -0.08, "y"); // 刀柄
  boxAt(g, kit.metal, 0.62, 0.06, 0.42, 0, 0.3, 0.08); // 工作台
  boxAt(g, kit.accent, 0.3, 0.035, 0.2, -0.1, 0.35, 0.06); // 台上铝锭工件(加工中语境)
  for (const x of [-0.26, 0.26]) boxAt(g, kit.bodyDeep, 0.05, 0.08, 0.42, x, 0.36, 0.08); // 导轨挡块
  addGuard(g, kit, 1.0, 0.72, 0.72, -0.1);
  addPendantScreen(g, kit, 0.48, 0.66, 0.32);
  stackLightAt(g, kit, -0.5, 0.95, -0.28, 0.22);
  return g;
}

/** 数控车床:长床身 + 头架卡盘 + 尾座 + 顶部玻璃罩。 */
function buildLatheModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 1.3, 0.16, 0.7, 0, 0.08, 0);
  boxAt(g, kit.body, 1.1, 0.22, 0.4, 0, 0.27, 0); // 床身
  boxAt(g, kit.bodyDeep, 0.34, 0.42, 0.44, -0.38, 0.52, 0); // 头架
  cylAt(g, kit.metal, 0.17, 0.17, 0.09, -0.12, 0.52, 0, "x"); // 卡盘
  const chuck = subgroupAt(g, -0.06, 0.52, 0);
  for (let i = 0; i < 3; i++) {
    const arm = subgroupAt(chuck);
    arm.rotation.x = (i * Math.PI * 2) / 3;
    boxAt(arm, kit.accent, 0.04, 0.05, 0.04, 0, 0.19, 0); // 卡爪沿卡盘圆周分布
  }
  boxAt(g, kit.bodyDeep, 0.14, 0.24, 0.24, 0.34, 0.46, 0); // 尾座
  cylAt(g, kit.metal, 0.03, 0.03, 0.12, 0.44, 0.5, 0, "x");
  cylAt(g, kit.accent, 0.035, 0.035, 0.4, 0.1, 0.52, 0, "x"); // 卡盘夹持的棒料(加工中语境)
  addGuard(g, kit, 1.25, 0.5, 0.58, 0);
  addPendantScreen(g, kit, 0.52, 0.5, 0.4);
  stackLightAt(g, kit, -0.58, 0.75, 0, 0.2);
  return g;
}

/** 激光焊接工作站:围栏工作胞 + 内藏机械臂 + 激光电源。 */
function buildWeldingCellModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 1.3, 0.14, 1.0, 0, 0.07, 0);
  for (const [x, z] of [[-0.62, -0.46], [0.62, -0.46], [-0.62, 0.46], [0.62, 0.46]] as const) {
    boxAt(g, kit.body, 0.06, 1.15, 0.06, x, 0.72, z); // 型材立柱
  }
  boxAt(g, kit.bodyDeep, 1.3, 0.1, 0.06, 0, 1.32, -0.46); // 顶梁
  boxAt(g, kit.glass, 1.14, 0.9, 0.015, 0, 0.68, -0.42); // 后玻璃
  boxAt(g, kit.glass, 0.015, 0.9, 0.86, -0.58, 0.68, 0); // 侧玻璃
  boxAt(g, kit.body, 0.5, 0.9, 0.05, 0.38, 0.68, 0.45); // 前门(留半开视口)
  boxAt(g, kit.glass, 0.3, 0.62, 0.015, -0.16, 0.66, 0.45);
  // 胞内小臂:底座 + 两节臂 + 焊枪
  cylAt(g, kit.body, 0.14, 0.16, 0.12, 0.2, 0.2, -0.05);
  boxAt(g, kit.accent, 0.09, 0.5, 0.09, 0.2, 0.5, -0.05, );
  boxAt(g, kit.body, 0.07, 0.36, 0.07, -0.06, 0.82, -0.05);
  cylAt(g, kit.dark, 0.025, 0.008, 0.14, -0.16, 0.92, -0.05, "x"); // 焊枪
  boxAt(g, kit.bodyDeep, 0.34, 0.8, 0.3, -0.48, 0.55, 0.1); // 激光电源柜
  stackLightAt(g, kit, 0.62, 1.37, -0.46, 0.2);
  return g;
}

/** 数控折弯机:C 型机身 + 上模压头 + 下模工作台。 */
function buildPressBrakeModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 1.2, 0.18, 0.9, 0, 0.09, 0);
  for (const x of [-0.44, 0.44]) boxAt(g, kit.body, 0.24, 1.05, 0.62, x, 0.7, -0.08); // 两侧立柱
  boxAt(g, kit.body, 1.12, 0.3, 0.6, 0, 1.36, -0.08); // 顶梁(缸体)
  boxAt(g, kit.bodyDeep, 1.0, 0.22, 0.4, 0, 1.06, -0.08); // 快速滑块
  boxAt(g, kit.accent, 0.9, 0.06, 0.1, 0, 0.93, -0.08); // 上模
  boxAt(g, kit.metal, 1.0, 0.12, 0.44, 0, 0.52, -0.08); // 工作台
  boxAt(g, kit.accent, 0.9, 0.05, 0.08, 0, 0.62, -0.08); // 下模
  boxAt(g, kit.metal, 0.86, 0.014, 0.3, 0, 0.6, -0.08); // 待折薄板搭在下模上(加工中语境)
  for (const x of [-0.44, 0.44]) boxAt(g, kit.glass, 0.015, 0.5, 0.4, x, 0.86, 0.18); // 侧防护
  boxAt(g, kit.dark, 1.2, 0.1, 0.14, 0, 0.44, 0.36); // 前托料臂
  // 背面语义:液压管路 + 电气盒,背视角可辨
  for (const dx of [-0.18, 0, 0.18]) cylAt(g, kit.dark, 0.02, 0.02, 1.0, dx, 0.85, -0.42, "y", 10);
  boxAt(g, kit.bodyDeep, 0.3, 0.36, 0.14, 0.42, 0.4, -0.42);
  ventDotsAt(g, kit.dark, 0.18, 2, 3, 0.42, 0.42, -0.492, "z");
  addPendantScreen(g, kit, 0.5, 0.72, 0.34);
  stackLightAt(g, kit, 0, 1.52, -0.08, 0.2);
  return g;
}

/** 注塑机:合模单元(模板 + 拉杆)+ 射出单元(料筒 + 料斗)。 */
function buildInjectionMolderModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 1.5, 0.2, 0.7, 0, 0.1, 0);
  boxAt(g, kit.body, 0.5, 0.4, 0.42, 0.4, 0.42, 0); // 合模箱体
  for (const x of [0.18, 0.66]) {
    boxAt(g, kit.bodyDeep, 0.08, 0.44, 0.44, x, 0.42, 0); // 定/动模板
    for (const z of [-0.14, 0.14]) for (const y of [0.28, 0.56]) cylAt(g, kit.metal, 0.02, 0.02, 0.56, x, y, z, "x"); // 拉杆
  }
  cylAt(g, kit.metal, 0.05, 0.05, 0.6, -0.22, 0.4, 0, "x"); // 料筒
  cylAt(g, kit.bodyDeep, 0.09, 0.09, 0.24, -0.56, 0.4, 0, "x"); // 射出台
  cylAt(g, kit.accent, 0.05, 0.14, 0.2, -0.56, 0.66, 0, "y", 18); // 料斗锥段
  boxAt(g, kit.body, 0.36, 0.5, 0.4, -0.36, 0.5, 0);
  addPendantScreen(g, kit, 0.05, 0.68, 0.42);
  stackLightAt(g, kit, 0.66, 0.66, 0, 0.2);
  return g;
}

/** 机器视觉检测机:大理石基座 + 龙门 + 相机头 + 环形光。 */
function buildInspectionModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.rubber, 1.0, 0.14, 0.7, 0, 0.07, 0); // 花岗岩基座
  boxAt(g, kit.metal, 0.9, 0.03, 0.5, 0, 0.16, 0); // 检测台面
  for (const x of [-0.42, 0.42]) boxAt(g, kit.body, 0.08, 0.95, 0.08, x, 0.63, 0);
  boxAt(g, kit.body, 1.0, 0.12, 0.14, 0, 1.14, 0); // 龙门梁
  boxAt(g, kit.bodyDeep, 0.2, 0.26, 0.2, 0, 0.98, 0); // 相机滑座
  cylAt(g, kit.dark, 0.06, 0.06, 0.14, 0, 0.8, 0, "y"); // 镜头筒
  tubeAt(g, kit.screen, 0.1, 0.018, 0, 0.72, 0, "y"); // 环形光
  boxAt(g, kit.body, 0.05, 0.5, 0.3, 0.5, 0.45, 0.2); // 电控立柱
  boxAt(g, kit.screen, 0.3, 0.2, 0.015, 0.5, 0.82, 0.2);
  stackLightAt(g, kit, 0.42, 1.2, 0, 0.18);
  return g;
}

/**
 * 电视与拼接大屏(C6 行列联动):按 rows/columns 参数生成 m×n 单元阵列,
 * 画幅比取 widthM/heightM,屏幕分块微差亮度模拟画面,总幅宽归一到取景友好尺寸。
 */
export function buildDisplayModel(kit: ModelKit, variant?: PrefabThumbnailVariant): THREE.Group {
  const g = kit.group;
  const columns = Math.max(1, Math.min(10, Math.round(variant?.columns ?? 2)));
  const rows = Math.max(1, Math.min(6, Math.round(variant?.rows ?? 2)));
  const aspect = variant?.width && variant?.height ? variant.width / variant.height : 16 / 9;
  const totalWidth = 1.7; // 归一总宽,高度由画幅比反推
  const totalHeight = totalWidth / aspect;
  const bezel = 0.035; // 拼缝
  const cellWidth = (totalWidth - bezel * (columns - 1)) / columns;
  const cellHeight = (totalHeight - bezel * (rows - 1)) / rows;
  boxAt(g, kit.metal, totalWidth * 0.35, 0.04, totalWidth * 0.18, 0, 0.02, 0);
  boxAt(g, kit.dark, 0.08, totalHeight * 0.5, 0.08, 0, totalHeight * 0.25, 0); // 立柱
  boxAt(g, kit.dark, totalWidth + 0.1, 0.06, 0.05, 0, totalHeight + 0.08, 0); // 顶部横梁
  for (let col = 0; col < columns; col++) {
    for (let row = 0; row < rows; row++) {
      const x = (col - (columns - 1) / 2) * (cellWidth + bezel);
      const y = totalHeight - ((row + 0.5) * cellHeight + row * bezel) + 0.08;
      boxAt(g, kit.dark, cellWidth + 0.04, cellHeight + 0.04, 0.045, x, y, 0); // 单元边框
      const cell = boxAt(g, kit.screen, cellWidth, cellHeight, 0.012, x, y, 0.026);
      cell.material = (cell.material as THREE.MeshStandardMaterial).clone();
      (cell.material as THREE.MeshStandardMaterial).emissiveIntensity = (col + row) % 2 === 0 ? 0.62 : 0.4; // 画面分块
    }
  }
  return g;
}

/** 半透明防护罩:顶 + 前 + 两侧玻璃与型材包边立柱,centerZ 为罩体中心。 */
function addGuard(g: THREE.Group, kit: ModelKit, w: number, h: number, d: number, centerZ: number): void {
  const baseY = 0.3;
  const centerY = baseY + h / 2;
  boxAt(g, kit.glass, w, 0.015, d, 0, baseY + h, centerZ); // 顶
  boxAt(g, kit.glass, w * 0.86, h, 0.015, 0, centerY, centerZ + d / 2); // 前玻璃
  for (const x of [-w / 2, w / 2]) boxAt(g, kit.glass, 0.015, h, d, x, centerY, centerZ); // 侧玻璃
  for (const x of [-w / 2, 0, w / 2]) boxAt(g, kit.bodyDeep, 0.03, h + 0.02, 0.03, x, centerY, centerZ + d / 2); // 前包边立柱
}

/** 悬臂控制屏:立管 + 横臂 + 发光面板(机床类通用附件,导出给扩量机型复用)。 */
export function addPendantScreen(g: THREE.Group, kit: ModelKit, x: number, y: number, z: number): void {
  const arm = subgroupAt(g, x, y, z);
  cylAt(arm, kit.metal, 0.02, 0.02, y, 0, -y / 2, 0); // 立管
  boxAt(arm, kit.metal, 0.02, 0.02, 0.2, 0, 0.08, 0.1);
  boxAt(arm, kit.dark, 0.24, 0.17, 0.02, 0, 0.16, 0.2);
  const panel = boxAt(arm, kit.screen, 0.2, 0.13, 0.012, 0, 0.16, 0.212);
  panel.rotation.x = -0.22;
}
