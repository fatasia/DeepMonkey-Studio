import * as THREE from "three";
import type { ModelKit, PrefabThumbnailVariant } from "./prefabThumbnailKit";
import { ballAt, boneMaterial, boxAt, cylAt, grilleAt, stackLightAt, subgroupAt, tubeAt } from "./prefabThumbnailKit";
import {
  buildAsrsRackModel,
  buildFlowMeterModel,
  buildLevelSensorModel,
  buildPressureTransmitterModel,
  buildSiloModel,
  buildTemperatureTransmitterModel,
} from "./prefabThumbnailModelsLogistics2";
import { buildCameraVariantModel, buildSensingVariantModel } from "./prefabThumbnailModelsSensing2";
import { buildStorageVariantModel } from "./prefabThumbnailModelsStorage2";
/** 闸机/道闸与安全互锁门。 */
export function buildAccessControlModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group {
  const g = kit.group;
  if (variant.tail === "interlock-door") {
    for (const x of [-0.6, 0.6]) boxAt(g, kit.metal, 0.07, 1.2, 0.09, x, 0.6, 0);
    boxAt(g, kit.metal, 1.27, 0.09, 0.09, 0, 1.24, 0);
    boxAt(g, kit.glass, 1.1, 1.0, 0.02, 0, 0.62, 0); // 门玻璃
    boxAt(g, kit.body, 1.1, 0.06, 0.05, 0, 0.12, 0); // 门框下槛
    boxAt(g, kit.lampRun, 0.1, 0.03, 0.03, 0, 1.3, 0); // 状态灯
    boxAt(g, kit.screen, 0.1, 0.07, 0.012, 0.55, 1.0, 0.06); // 读卡区
    return g;
  }
  // 道闸:机箱 + 读卡屏 + 红白闸臂(抬起)
  boxAt(g, kit.body, 0.26, 0.52, 0.22, 0, 0.48, 0);
  boxAt(g, kit.dark, 0.26, 0.05, 0.24, 0, 0.22, 0);
  boxAt(g, kit.screen, 0.12, 0.08, 0.012, 0, 0.6, 0.115);
  const arm = subgroupAt(g, 0.1, 0.66, 0);
  arm.rotation.z = 0.42;
  for (let i = 0; i < 4; i++) {
    boxAt(arm, i % 2 === 0 ? kit.lampDanger : boneMaterial(kit), 0.28, 0.045, 0.045, 0.14 + i * 0.28, 0, 0);
  }
  cylAt(g, kit.dark, 0.05, 0.05, 0.12, 0, 0.68, 0, "z", 14); // 臂座
  return g;
}

/** 参数化围栏:立柱 + 网片(金属网格 / 玻璃 / 实板 / 电子围栏)。 */
export function buildFenceModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group {
  const g = kit.group;
  for (const x of [-0.8, 0, 0.8]) {
    boxAt(g, kit.metal, 0.05, 1.1, 0.05, x, 0.55, 0);
    boxAt(g, kit.dark, 0.1, 0.03, 0.1, x, 0.015, 0);
  }
  boxAt(g, kit.metal, 1.68, 0.04, 0.04, 0, 1.12, 0); // 顶横梁
  const panel = variant.panel ?? "mesh";
  if (panel === "glass") {
    boxAt(g, kit.glass, 1.56, 0.95, 0.015, 0, 0.58, 0);
  } else if (panel === "solid") {
    boxAt(g, kit.bodyDeep, 1.56, 0.95, 0.02, 0, 0.58, 0);
  } else {
    for (let i = 0; i < 13; i++) boxAt(g, kit.metal, 0.016, 1.0, 0.016, -0.72 + i * 0.12, 0.56, 0); // 竖网条
    for (const y of [0.22, 0.56, 0.9]) boxAt(g, kit.metal, 1.6, 0.016, 0.02, 0, y, 0); // 横筋
  }
  if (panel === "electronic") boxAt(g, kit.lampWarn, 1.6, 0.02, 0.02, 0, 1.06, 0.02);
  return g;
}

/** 仓储:托盘货架 / 重力流利架 / 穿梭车立体库 / 垂直提升货柜 / 料仓 / 立体库货柜。 */
export function buildStorageModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group {
  const g = kit.group;
  const family = variant.family ?? "pallet-rack";
  // 2026-09-12 扩量:贯通式货架/密集架/冷藏柜/周转笼走专用构建器
  const waveC = buildStorageVariantModel(kit, variant);
  if (waveC) return waveC;
  if (family === "silo") return buildSiloModel(g, kit);
  if (family === "asrs-rack") return buildAsrsRackModel(g, kit);
  if (family === "vertical-lift") {
    boxAt(g, kit.body, 0.9, 1.6, 0.7, 0, 0.8, 0);
    boxAt(g, kit.dark, 0.94, 0.1, 0.74, 0, 0.05, 0);
    // 微交互:提取口卷帘降到 2/3,画面只露下 1/3(取货中语境)
    boxAt(g, kit.dark, 0.34, 0.34, 0.014, 0, 1.02, 0.362); // 卷帘帘面
    for (const y of [0.93, 1.02, 1.11]) boxAt(g, kit.bodyDeep, 0.3, 0.018, 0.016, 0, y, 0.37); // 帘面横筋
    boxAt(g, kit.metal, 0.34, 0.02, 0.02, 0, 0.85, 0.37); // 卷帘底梁
    boxAt(g, kit.screen, 0.3, 0.16, 0.012, 0, 0.69, 0.36); // 提取口画面(下 1/3)
    // 背面语义:双开库门缝 + 通风百叶,背视角不退化为色块
    boxAt(g, kit.dark, 0.012, 1.3, 0.008, 0, 0.85, -0.352);
    grilleAt(g, kit.dark, 0.5, 4, 0, 1.3, -0.356, 0.03);
    boxAt(g, kit.dark, 0.66, 0.02, 0.008, 0, 0.44, -0.352); // 背面检修门下沿
    stackLightAt(g, kit, 0.38, 1.6, 0, 0.18);
    return g;
  }
  if (family === "shuttle-asrs") {
    for (const x of [-0.75, 0.75]) for (const z of [-0.3, 0.3]) boxAt(g, kit.accent, 0.05, 1.7, 0.05, x, 0.85, z);
    for (const y of [0.45, 0.9, 1.35]) {
      for (const z of [-0.3, 0.3]) boxAt(g, kit.body, 1.56, 0.06, 0.05, 0, y, z);
      for (const x of [-0.38, 0.38]) boxAt(g, kit.bodyDeep, 0.5, 0.28, 0.44, x, y + 0.19, 0); // 货箱
    }
    boxAt(g, kit.metal, 0.3, 0.06, 0.5, 0, 1.62, 0); // 穿梭车
    return g;
  }
  if (family === "carton-flow") {
    for (const z of [-0.28, 0.28]) {
      boxAt(g, kit.accent, 1.4, 0.06, 0.05, 0, 0.5, z);
      boxAt(g, kit.accent, 1.4, 0.06, 0.05, 0, 0.95, z);
    }
    for (const x of [-0.66, 0.66]) for (const z of [-0.28, 0.28]) boxAt(g, kit.metal, 0.05, 1.0, 0.05, x, 0.5, z);
    for (let i = 0; i < 4; i++) {
      const carton = boxAt(g, i % 2 ? kit.body : kit.bodyDeep, 0.3, 0.24, 0.3, -0.5 + i * 0.34, 1.11, 0);
      carton.rotation.z = 0; // 流利架上层纸箱
    }
    for (let i = 0; i < 3; i++) cylAt(g, kit.rubber, 0.02, 0.02, 0.5, -0.4 + i * 0.4, 0.56, 0, "z", 8); // 流利滚轮
    return g;
  }
  // 托盘货架:两榀立柱 + 两层横梁 + 托盘货箱
  for (const x of [-0.7, 0.7]) for (const z of [-0.28, 0.28]) {
    boxAt(g, kit.accent, 0.05, 1.5, 0.05, x, 0.75, z);
    boxAt(g, kit.dark, 0.11, 0.03, 0.11, x, 0.015, z);
  }
  for (const x of [-0.7, 0.7]) boxAt(g, kit.accent, 0.03, 0.7, 0.53, x, 0.75, 0); // 柱间撑
  for (const y of [0.62, 1.2]) {
    for (const z of [-0.28, 0.28]) boxAt(g, kit.body, 1.52, 0.07, 0.06, 0, y, z);
    for (const x of [-0.38, 0.38]) {
      boxAt(g, kit.rubber, 0.55, 0.05, 0.5, x, y + 0.06, 0); // 托盘
      for (const dx of [-0.16, 0.16]) boxAt(g, kit.dark, 0.1, 0.032, 0.42, x + dx, y + 0.016, 0); // 叉孔(叉车取货语义)
      boxAt(g, x > 0 ? kit.bodyDeep : kit.body, 0.46, 0.3, 0.42, x, y + 0.24, 0); // 货箱
    }
  }
  return g;
}

/** 传感器:检测盒 + 支架 + 状态灯,按 family 变化头部形态。 */
export function buildSensorModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group {
  const g = kit.group;
  const family = variant.family ?? "photoelectric";
  // 2026-09-12 扩量:感烟/感温/声光/振动/RTU/边缘网关走专用构建器
  const waveC = buildSensingVariantModel(kit, variant);
  if (waveC) return waveC;
  if (family === "proximity") {
    cylAt(g, kit.metal, 0.07, 0.07, 0.3, 0, 0.5, 0); // 螺纹罐体
    for (const y of [0.4, 0.48, 0.56]) tubeAt(g, kit.metal, 0.07, 0.012, 0, y, 0, "y", Math.PI * 2, 18);
    cylAt(g, kit.body, 0.075, 0.075, 0.08, 0, 0.69, 0); // 感应面
    boxAt(g, kit.dark, 0.16, 0.16, 0.16, 0, 0.24, 0); // 安装块
    boxAt(g, kit.dark, 0.3, 0.04, 0.2, 0, 0.02, 0);
    return g;
  }
  if (family === "rfid") {
    for (const x of [-0.35, 0.35]) {
      boxAt(g, kit.body, 0.4, 0.55, 0.05, x, 0.7, 0); // 门型天线
      boxAt(g, kit.screen, 0.3, 0.42, 0.01, x, 0.7, 0.03);
      boxAt(g, kit.metal, 0.07, 0.7, 0.07, x, 0.35, 0);
    }
    boxAt(g, kit.dark, 0.3, 0.2, 0.2, 0, 0.1, 0); // 读写器主机
    return g;
  }
  if (family === "load-cell") {
    // C3 秤台特征:底框 + 四角称重传感器柱 + 防滑台面 + 接线盒与仪表
    boxAt(g, kit.dark, 0.72, 0.06, 0.5, 0, 0.03, 0); // 底框
    for (const [x, z] of [[-0.3, -0.18], [0.3, -0.18], [-0.3, 0.18], [0.3, 0.18]] as const) {
      cylAt(g, kit.metal, 0.045, 0.055, 0.1, x, 0.11, z, "y", 14); // 称重传感器柱
    }
    boxAt(g, kit.metal, 0.66, 0.035, 0.44, 0, 0.185, 0); // 台面
    for (let i = 0; i < 5; i++) boxAt(g, kit.dark, 0.6, 0.006, 0.012, 0, 0.206, -0.16 + i * 0.08); // 防滑纹
    boxAt(g, kit.bodyDeep, 0.12, 0.09, 0.1, 0.26, 0.14, -0.26); // 接线盒
    boxAt(g, kit.body, 0.2, 0.1, 0.14, 0, 0.05, 0.24); // 变送盒
    boxAt(g, kit.screen, 0.12, 0.05, 0.01, 0, 0.07, 0.315);
    return g;
  }
  if (family === "level") return buildLevelSensorModel(g, kit);
  if (family === "flow") return buildFlowMeterModel(g, kit);
  if (family === "pressure-transmitter") return buildPressureTransmitterModel(g, kit);
  if (family === "temperature-transmitter") return buildTemperatureTransmitterModel(g, kit);
  if (family === "temperature") {
    boxAt(g, kit.body, 0.2, 0.28, 0.09, 0, 0.6, 0);
    grilleAt(g, kit.dark, 0.14, 5, 0, 0.6, 0.048, 0.02);
    boxAt(g, kit.screen, 0.08, 0.05, 0.01, 0, 0.68, 0.048);
    cylAt(g, kit.dark, 0.03, 0.03, 0.1, 0, 0.42, 0); // 引线喉
    boxAt(g, kit.dark, 0.22, 0.04, 0.22, 0, 0.02, 0);
    return g;
  }
  if (family === "safety-lidar") {
    cylAt(g, kit.metal, 0.035, 0.035, 0.75, 0, 0.375, 0); // 立柱
    cylAt(g, kit.body, 0.09, 0.11, 0.14, 0, 0.82, 0, "y", 20); // 扫描头
    tubeAt(g, kit.lampRun, 0.095, 0.012, 0, 0.82, 0, "y", Math.PI * 2, 24); // 扫描环
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.26, 18, 1, true), kit.glass);
    cone.position.set(0.2, 0.74, 0);
    cone.rotation.z = Math.PI / 2;
    g.add(cone); // 扇形扫描视锥(低透明度,克制)
    return g;
  }
  // 光电/默认:L 支架 + 检测盒 + 镜头 + 状态灯
  boxAt(g, kit.metal, 0.05, 0.6, 0.05, -0.2, 0.3, 0);
  boxAt(g, kit.metal, 0.3, 0.05, 0.05, -0.08, 0.58, 0);
  boxAt(g, kit.body, 0.24, 0.14, 0.1, 0.1, 0.52, 0);
  cylAt(g, kit.dark, 0.045, 0.045, 0.07, 0.26, 0.52, 0, "x", 16); // 镜头
  tubeAt(g, kit.metal, 0.045, 0.01, 0.3, 0.52, 0, "x", Math.PI * 2, 16);
  ballAt(g, kit.lampRun, 0.014, 0.06, 0.56, 0.052);
  return g;
}

/** 相机:枪机 / 云台 / 视觉检测相机。 */
export function buildCameraModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group {
  const g = kit.group;
  const family = variant.family ?? "fixed";
  // 2026-09-12 扩量:枪机/半球/热成像/AI 分析盒走专用构建器
  const waveC = buildCameraVariantModel(kit, variant);
  if (waveC) return waveC;
  if (family === "ptz") {
    boxAt(g, kit.metal, 0.12, 0.5, 0.12, 0, 0.25, 0); // 立杆
    boxAt(g, kit.body, 0.3, 0.08, 0.12, 0, 0.54, 0); // 横臂
    const yoke = subgroupAt(g, 0, 0.54, 0.12);
    boxAt(yoke, kit.bodyDeep, 0.06, 0.16, 0.06, -0.1, -0.02, 0);
    boxAt(yoke, kit.bodyDeep, 0.06, 0.16, 0.06, 0.1, -0.02, 0);
    ballAt(yoke, kit.body, 0.11, 0, -0.06, 0); // 云台球机
    ballAt(yoke, kit.glass, 0.075, 0, -0.06, 0.04, 1, 1, 0.7); // 罩面
    return g;
  }
  if (family === "vision") {
    cylAt(g, kit.body, 0.12, 0.13, 0.3, 0, 0.55, 0, "z", 24); // 相机机身
    boxAt(g, kit.dark, 0.2, 0.24, 0.08, 0, 0.55, -0.14); // 后部接口
    cylAt(g, kit.metal, 0.07, 0.07, 0.14, 0, 0.55, 0.2, "z", 20); // 镜头
    tubeAt(g, kit.dark, 0.07, 0.012, 0, 0.55, 0.26, "z", Math.PI * 2, 20);
    tubeAt(g, kit.lampRun, 0.13, 0.016, 0, 0.55, 0.18, "z", Math.PI * 2, 26); // 环形光源
    boxAt(g, kit.metal, 0.3, 0.5, 0.05, 0, 0.3, -0.16); // 支架
    return g;
  }
  // 枪机:L 支架 + 长方机身 + 镜头环 + 遮阳罩
  boxAt(g, kit.metal, 0.05, 0.6, 0.05, -0.18, 0.3, 0);
  boxAt(g, kit.metal, 0.26, 0.05, 0.05, -0.08, 0.58, 0);
  const body = subgroupAt(g, 0.08, 0.5, 0);
  body.rotation.z = -0.12;
  boxAt(body, kit.body, 0.3, 0.11, 0.11, 0, 0, 0);
  boxAt(body, kit.bodyDeep, 0.32, 0.02, 0.13, 0, 0.075, 0); // 遮阳罩
  cylAt(body, kit.dark, 0.045, 0.045, 0.08, 0.18, -0.01, 0, "x", 16); // 镜头
  tubeAt(body, kit.metal, 0.045, 0.01, 0.22, -0.01, 0, "x", Math.PI * 2, 16);
  ballAt(body, kit.lampRun, 0.013, 0.1, 0.05, 0.056);
  return g;
}
