import * as THREE from "three";
import type { ModelKit } from "./prefabThumbnailKit";
import { ballAt, boltQuadAt, boxAt, cylAt, flangeAt, panelSeamAt, stackLightAt, stripesAt, subgroupAt, tubeAt, ventDotsAt } from "./prefabThumbnailKit";
import { addPendantScreen } from "./prefabThumbnailModelsProcess";

/**
 * 扩量机型小样(2026-09-12):机床新四工艺 gantry/grinding/pressing/heat-treat,
 * 公用工程新四族 heat-exchanger/tank/softener/dosing-station。
 * 比例取真实设备惯性印象(米制),取景交给渲染器包围盒自动适配。
 */

/** 龙门加工中心:底座 + 工作台 + 双立柱 + 顶横梁 + 滑枕主轴。 */
export function buildGantryMillModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 1.5, 0.18, 0.9, 0, 0.09, 0); // 底座
  boxAt(g, kit.metal, 0.8, 0.14, 0.55, 0, 0.25, 0.05); // 工作台(龙门两柱间)
  for (const z of [-0.12, 0.05, 0.22]) boxAt(g, kit.dark, 0.76, 0.01, 0.03, 0, 0.325, 0.05 + z); // T 型槽
  for (const x of [-0.55, 0.55]) boxAt(g, kit.body, 0.24, 1.42, 0.5, x, 0.89, -0.12); // 双立柱
  boxAt(g, kit.body, 1.34, 0.34, 0.42, 0, 1.74, -0.12); // 顶横梁
  boxAt(g, kit.bodyDeep, 0.32, 0.26, 0.46, 0, 1.46, -0.12); // 横溜板
  boxAt(g, kit.metal, 0.12, 0.5, 0.12, 0, 1.1, -0.12); // 垂直滑枕
  cylAt(g, kit.metal, 0.045, 0.045, 0.18, 0, 0.78, -0.12); // 主轴
  cylAt(g, kit.accent, 0.055, 0.055, 0.05, 0, 0.66, -0.12); // 刀柄
  stripesAt(g, kit, 0.24, 0.9, -0.55, 0.9, 0.15, 5, 31); // 立柱警示条纹(带磨损)
  boxAt(g, kit.bodyDeep, 0.42, 0.9, 0.36, -0.9, 0.63, 0.1); // 电气柜
  ventDotsAt(g, kit.dark, 0.26, 3, 4, -0.9, 0.55, 0.285);
  panelSeamAt(g, kit, 0.3, -0.9, 0.82, 0.285); // 电气柜门分缝(波次 E 贴花)
  boltQuadAt(g, kit, 0.32, 0.26, -0.9, 0.19, 0.1);
  addPendantScreen(g, kit, 0.55, 0.7, 0.4);
  stackLightAt(g, kit, 0.62, 1.91, -0.12, 0.22);
  return g;
}

/** 磨床:长床身 + 砂轮架(砂轮 + 罩壳)+ 往复磁台 + 冷却与电控。 */
export function buildGrinderModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 1.5, 0.16, 0.7, 0, 0.08, 0); // 底座
  boxAt(g, kit.metal, 1.4, 0.06, 0.5, 0, 0.19, 0); // 导轨面
  boxAt(g, kit.bodyDeep, 0.42, 0.62, 0.42, -0.38, 0.53, -0.08); // 砂轮架立柱
  ballAt(g, kit.bodyDeep, 0.25, -0.38, 0.5, 0.16, 1.2, 1.2, 0.8); // 砂轮罩
  cylAt(g, kit.metal, 0.2, 0.2, 0.07, -0.38, 0.5, 0.3, "z"); // 砂轮
  cylAt(g, kit.bodyDeep, 0.09, 0.09, 0.22, -0.38, 0.92, 0.05, "z"); // 砂轮架顶部主电机
  tubeAt(g, kit.accent, 0.05, 0.012, -0.3, 0.68, 0.3, "z"); // 冷却喷嘴环
  boxAt(g, kit.metal, 0.8, 0.08, 0.34, 0.18, 0.26, 0); // 往复工作台
  boxAt(g, kit.dark, 0.76, 0.02, 0.3, 0.18, 0.31, 0); // 磁台吸盘面
  boxAt(g, kit.dark, 0.44, 0.26, 0.32, 0.2, 0.13, 0.28); // 冷却水箱
  boxAt(g, kit.body, 0.36, 0.8, 0.3, 0.62, 0.48, -0.42); // 电控柜
  ventDotsAt(g, kit.dark, 0.2, 3, 3, 0.62, 0.4, -0.262, "z");
  stackLightAt(g, kit, -0.66, 0.84, -0.08, 0.2);
  return g;
}

/** 冲压机:双柱机身 + 顶冠缸体 + 滑块上下模 + 飞轮。 */
export function buildPressModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 1.3, 0.22, 0.9, 0, 0.11, 0); // 底座
  boxAt(g, kit.metal, 1.0, 0.12, 0.6, 0, 0.28, 0); // 垫板台面
  boxAt(g, kit.accent, 0.4, 0.1, 0.24, 0, 0.39, 0); // 下模
  for (const x of [-0.44, 0.44]) {
    boxAt(g, kit.body, 0.26, 1.5, 0.6, x, 1.03, 0); // 立柱
    boxAt(g, kit.metal, 0.04, 1.2, 0.04, x * 0.72, 0.9, -0.22); // 导轨(立柱内侧面)
    boxAt(g, kit.metal, 0.04, 1.2, 0.04, x * 0.72, 0.9, 0.22);
  }
  boxAt(g, kit.body, 1.14, 0.4, 0.6, 0, 1.98, 0); // 顶冠(缸体)
  boxAt(g, kit.bodyDeep, 0.9, 0.3, 0.5, 0, 1.55, 0); // 滑块
  boxAt(g, kit.accent, 0.5, 0.12, 0.24, 0, 1.34, 0); // 上模
  boxAt(g, kit.metal, 0.38, 0.016, 0.22, 0, 0.452, 0); // 下模上的被压薄板(冲压中语境)
  cylAt(g, kit.dark, 0.22, 0.22, 0.08, 0, 1.98, -0.36, "z"); // 飞轮
  cylAt(g, kit.metal, 0.05, 0.05, 0.14, 0, 1.98, -0.36, "z"); // 轮毂
  stripesAt(g, kit, 1.24, 0.09, 0, 0.22, 0.46, 7, 52); // 底座警示条纹(带磨损)
  boxAt(g, kit.bodyDeep, 0.24, 0.4, 0.2, 0.82, 0.51, 0.3); // 按钮站
  boxAt(g, kit.screen, 0.1, 0.06, 0.012, 0.82, 0.62, 0.41);
  stackLightAt(g, kit, 0, 2.18, -0.2, 0.2);
  return g;
}

/** 热处理炉:钢架箱式炉体 + 半升炉门(露出橙红高温腔)+ 顶部风机与烟囱 + 控制柜。 */
export function buildHeatTreatFurnaceModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 1.3, 0.16, 1.0, 0, 0.08, 0); // 钢架底座
  boxAt(g, kit.bodyDeep, 1.15, 1.0, 0.85, 0, 0.66, -0.05); // 炉体
  // 半升炉门(微交互"门留缝"的炉体版):门体上提,露出下部高温腔
  boxAt(g, kit.dark, 0.9, 0.56, 0.05, 0, 0.72, 0.395); // 开口内衬(腔体口)
  const chamber = new THREE.MeshStandardMaterial({ color: 0xff7a2a, emissive: 0xff5a16, emissiveIntensity: 1.1, roughness: 0.5 });
  boxAt(g, chamber, 0.86, 0.34, 0.09, 0, 0.6, 0.42); // 橙红高温腔(发光,凸出口沿保证俯视可见)
  boxAt(g, kit.accent, 0.9, 0.6, 0.07, 0, 1.24, 0.4); // 炉门(提升位)
  boxAt(g, kit.dark, 0.94, 0.03, 0.02, 0, 0.985, 0.4); // 门缝
  cylAt(g, kit.metal, 0.04, 0.04, 0.52, 0.56, 1.32, 0.4); // 门提升气缸(随门伸出)
  cylAt(g, kit.body, 0.1, 0.1, 0.18, 0.15, 1.25, -0.05); // 炉顶循环风机
  cylAt(g, kit.metal, 0.06, 0.07, 0.6, -0.38, 1.5, -0.3); // 烟囱
  tubeAt(g, kit.metal, 0.08, 0.014, -0.38, 1.84, -0.3, "y"); // 烟囱顶帽
  cylAt(g, kit.dark, 0.035, 0.035, 0.05, -0.3, 0.75, 0.44, "z"); // 观火孔(炉门表面)
  stripesAt(g, kit, 1.1, 0.08, 0, 0.28, 0.44, 6, 73); // 高温警示条纹(带磨损)
  boxAt(g, kit.body, 0.4, 0.9, 0.32, 0.88, 0.61, 0.12); // 控制柜
  boxAt(g, kit.screen, 0.14, 0.09, 0.012, 0.88, 0.82, 0.285); // 温控屏
  ventDotsAt(g, kit.dark, 0.22, 2, 4, 0.88, 0.5, 0.285);
  panelSeamAt(g, kit, 0.3, 0.88, 0.66, 0.285); // 控制柜门分缝(波次 E 贴花)
  stackLightAt(g, kit, -0.5, 1.16, -0.05, 0.2);
  return g;
}

/** 管壳式换热器:卧式筒体 + 双封头 + 管箱法兰 + 上下接管 + 膨胀节 + 鞍座。 */
export function buildHeatExchangerModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 1.1, 0.06, 0.5, 0, 0.03, 0); // 底架
  for (const x of [-0.35, 0.35]) boxAt(g, kit.dark, 0.12, 0.24, 0.42, x, 0.18, 0); // 鞍座
  cylAt(g, kit.body, 0.24, 0.24, 1.0, 0, 0.46, 0, "x"); // 筒体
  ballAt(g, kit.body, 0.24, -0.5, 0.46, 0, 0.8, 1, 1); // 左封头
  ballAt(g, kit.body, 0.24, 0.5, 0.46, 0, 0.8, 1, 1); // 右封头
  for (const x of [-0.42, 0.42]) flangeAt(g, kit, 0.18, x, 0.46, 0, "x"); // 管箱法兰
  tubeAt(g, kit.bodyDeep, 0.245, 0.025, 0.12, 0.46, 0, "x"); // 膨胀节
  cylAt(g, kit.metal, 0.05, 0.05, 0.22, -0.22, 0.74, 0); // 壳程接管
  flangeAt(g, kit, 0.07, -0.22, 0.86, 0, "y");
  cylAt(g, kit.metal, 0.05, 0.05, 0.22, 0.22, 0.74, 0);
  flangeAt(g, kit, 0.07, 0.22, 0.86, 0, "y");
  cylAt(g, kit.metal, 0.045, 0.045, 0.16, 0, 0.34, 0.2, "z"); // 管程下接管
  flangeAt(g, kit, 0.06, 0, 0.34, 0.3, "z");
  boxAt(g, kit.screen, 0.08, 0.05, 0.008, -0.15, 0.46, 0.243); // 铭牌
  stackLightAt(g, kit, 0.48, 0.62, 0, 0.16);
  return g;
}

/** 立式储罐:罐体 + 拱顶 + 呼吸阀/人孔 + 液位计与爬梯 + 底出料阀。 */
export function buildTankModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  cylAt(g, kit.dark, 0.56, 0.56, 0.06, 0, 0.03, 0); // 基础环梁
  cylAt(g, kit.body, 0.5, 0.5, 1.05, 0, 0.585, 0); // 罐体
  ballAt(g, kit.body, 0.5, 0, 1.11, 0, 1, 0.42, 1); // 拱顶
  cylAt(g, kit.dark, 0.045, 0.045, 0.12, 0.2, 1.3, 0.1); // 呼吸阀
  cylAt(g, kit.metal, 0.09, 0.09, 0.05, -0.15, 1.26, 0.2); // 人孔
  cylAt(g, kit.dark, 0.02, 0.02, 0.9, 0.51, 0.62, 0.12); // 液位计连通管
  for (const y of [0.22, 0.98]) tubeAt(g, kit.dark, 0.028, 0.01, 0.51, y, 0.12, "y"); // 液位计上下阀
  boxAt(g, kit.metal, 0.03, 1.15, 0.03, 0.36, 0.63, 0.47); // 爬梯轨道
  boxAt(g, kit.metal, 0.03, 1.15, 0.03, 0.36, 0.63, 0.54);
  for (let i = 0; i < 6; i++) boxAt(g, kit.metal, 0.03, 0.014, 0.07, 0.36, 0.15 + i * 0.19, 0.505); // 踏步
  cylAt(g, kit.metal, 0.05, 0.05, 0.14, 0, 0.1, 0); // 底出料管
  tubeAt(g, kit.accent, 0.055, 0.012, 0, 0.14, 0.02, "y"); // 出料阀手轮
  return g;
}

/** 双柱软水器:两只树脂罐 + 多路阀 + 盐箱 + 连接管路。 */
export function buildSoftenerModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 1.6, 0.08, 0.6, 0, 0.04, 0); // 底架
  for (const x of [-0.3, 0.3]) {
    cylAt(g, kit.body, 0.17, 0.17, 0.72, x, 0.44, 0); // 树脂罐
    tubeAt(g, kit.metal, 0.172, 0.012, x, 0.3, 0, "y"); // 罐体加强箍
    boxAt(g, kit.bodyDeep, 0.17, 0.13, 0.15, x, 0.87, 0); // 多路阀
    boxAt(g, kit.accent, 0.03, 0.03, 0.12, x, 0.9, 0.1); // 阀手柄
  }
  boxAt(g, kit.bodyDeep, 0.34, 0.32, 0.3, 0.64, 0.24, 0.06); // 盐箱
  const lid = boxAt(g, kit.body, 0.36, 0.04, 0.32, 0.64, 0.44, 0.06); // 盐箱盖(半开微翘,检维护语境)
  lid.rotation.x = 0.16;
  cylAt(g, kit.dark, 0.018, 0.018, 0.2, -0.3, 0.16, 0.14, "z"); // 底部连通管
  cylAt(g, kit.dark, 0.018, 0.018, 0.24, -0.3, 0.26, 0.24, "y");
  boxAt(g, kit.screen, 0.08, 0.05, 0.01, -0.3, 0.87, 0.078); // 控制阀头显示
  stackLightAt(g, kit, -0.52, 0.84, 0, 0.16);
  return g;
}

/** 成套加药装置:撬架 + 加药桶 + 搅拌电机 + 计量泵 + 管路与控制箱。 */
export function buildDosingStationModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 1.15, 0.1, 0.65, 0, 0.05, 0); // 撬动底架
  cylAt(g, kit.body, 0.26, 0.26, 0.5, -0.3, 0.35, 0); // 加药桶
  cylAt(g, kit.bodyDeep, 0.27, 0.27, 0.03, -0.3, 0.615, 0); // 桶盖
  for (const y of [0.2, 0.42]) tubeAt(g, kit.metal, 0.265, 0.012, -0.3, y, 0, "y"); // 桶箍
  cylAt(g, kit.dark, 0.06, 0.06, 0.14, -0.3, 0.69, 0); // 搅拌电机
  boxAt(g, kit.metal, 0.12, 0.12, 0.12, 0.12, 0.24, 0); // 计量泵泵头
  cylAt(g, kit.bodyDeep, 0.05, 0.05, 0.16, 0.26, 0.24, 0, "x"); // 泵驱动电机
  cylAt(g, kit.dark, 0.015, 0.015, 0.34, -0.1, 0.14, 0, "x"); // 吸入管
  cylAt(g, kit.dark, 0.015, 0.015, 0.3, 0.42, 0.28, 0); // 输出立管
  flangeAt(g, kit, 0.04, 0.42, 0.44, 0, "y");
  boxAt(g, kit.body, 0.2, 0.28, 0.14, 0.44, 0.55, 0); // 控制箱
  boxAt(g, kit.screen, 0.09, 0.06, 0.01, 0.44, 0.6, 0.075);
  stackLightAt(g, kit, 0.0, 0.62, -0.2, 0.16);
  return g;
}
