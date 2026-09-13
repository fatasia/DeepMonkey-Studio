import * as THREE from "three";
import type { ModelKit, PrefabThumbnailVariant } from "./prefabThumbnailKit";
import { ballAt, boneMaterial, boxAt, cylAt, grilleAt, subgroupAt } from "./prefabThumbnailKit";

/**
 * 波次 C 仓储扩量小样:贯通式货架(无横梁驶入式)、移动式密集架(轨道摇柄)、
 * 冷藏柜(保温柜体 + 顶部机组)、周转笼(网笼 + 脚轮,前门半开姿态)。
 */

/** 仓储扩量分发。 */
export function buildStorageVariantModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group | undefined {
  switch (variant.family) {
    case "drive-in": return buildDriveInRackModel(kit);
    case "mobile-shelving": return buildMobileShelvingModel(kit);
    case "cold-room": return buildColdRoomModel(kit);
    case "roll-cage": return buildRollCageModel(kit);
    default: return undefined;
  }
}

/** 贯通式货架:四榀立柱组纵深排布 + 顶部连系梁 + 悬臂托盘导轨,无横梁是它与托盘货架的决定性区分。 */
function buildDriveInRackModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  for (const x of [-0.66, -0.22, 0.22, 0.66]) {
    for (const z of [-0.26, 0.26]) {
      boxAt(g, kit.accent, 0.05, 1.5, 0.05, x, 0.75, z); // 立柱
      boxAt(g, kit.dark, 0.1, 0.03, 0.1, x, 0.015, z);
    }
    boxAt(g, kit.accent, 0.03, 1.32, 0.47, x, 0.75, 0); // 单榀柱间撑(竖向)
  }
  for (const z of [-0.26, 0.26]) boxAt(g, kit.body, 1.5, 0.05, 0.05, 0, 1.52, z); // 顶部连系梁
  // 悬臂托盘导轨:两列三段,托盘深入存放(纵深语义)
  for (const x of [-0.44, 0, 0.44]) {
    for (const z of [-0.18, 0.18]) boxAt(g, kit.metal, 0.4, 0.035, 0.06, x, 0.62, z);
    boxAt(g, kit.rubber, 0.5, 0.045, 0.46, x, 0.66, 0); // 托盘
    boxAt(g, x > 0 ? kit.bodyDeep : kit.body, 0.4, 0.28, 0.38, x, 0.83, 0); // 货箱
  }
  return g;
}

/** 移动式密集架:底部双轨 + 密排封闭架体 + 端面摇柄手轮,一列朝 -z 大幅拉出露出层板(姿态区分)。 */
function buildMobileShelvingModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  for (const z of [-0.24, 0.24]) boxAt(g, kit.metal, 1.56, 0.04, 0.05, 0, 0.04, z); // 底部导轨
  const bayXs = [-0.65, -0.39, -0.13, 0.13, 0.39, 0.65];
  bayXs.forEach((x, index) => {
    const opened = index === 2; // 中列朝 -z 大幅拉出,展示层板与档案盒
    const bay = subgroupAt(g, x, 0, opened ? -0.36 : 0);
    boxAt(bay, opened ? kit.body : kit.bodyDeep, 0.24, 1.3, 0.46, 0, 0.73, 0); // 架体(拉出列亮色区分)
    for (const z of [-0.22, 0.22]) cylAt(bay, kit.rubber, 0.045, 0.045, 0.05, 0, 0.09, z, "z", 12); // 轨上滚轮
    if (opened) {
      boxAt(bay, kit.metal, 0.2, 0.02, 0.42, 0, 0.42, 0);
      boxAt(bay, kit.metal, 0.2, 0.02, 0.42, 0, 0.72, 0);
      boxAt(bay, kit.metal, 0.2, 0.02, 0.42, 0, 1.02, 0); // 层板
      for (const y of [0.55, 0.85]) {
        boxAt(bay, kit.accent, 0.07, 0.24, 0.32, -0.045, y, 0); // 档案盒
        boxAt(bay, kit.bodyDeep, 0.06, 0.2, 0.3, 0.045, y + 0.02, 0);
      }
    } else {
      boxAt(bay, kit.accent, 0.2, 0.05, 0.02, 0, 0.73, 0.235); // 面板标签条
    }
  });
  // 摇柄手轮(端列 +x 端面,放大到可读)
  cylAt(g, kit.metal, 0.07, 0.07, 0.035, 0.81, 0.62, 0, "x", 18);
  boxAt(g, kit.metal, 0.022, 0.15, 0.022, 0.825, 0.72, 0);
  ballAt(g, kit.dark, 0.018, 0.825, 0.8, 0);
  return g;
}

/** 冷藏柜:白色厚壁保温箱体 + 密封厚门(把手铰链)+ 顶部制冷机组 + 温控屏,冷链语义。 */
function buildColdRoomModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  const shell = boneMaterial(kit);
  boxAt(g, shell, 0.94, 1.34, 0.72, 0, 0.72, 0); // 保温柜身
  boxAt(g, shell, 1.0, 0.06, 0.78, 0, 0.04, 0); // 底沿
  // 厚门:门框密封线 + 长把手 + 双铰链
  boxAt(g, shell, 0.46, 1.14, 0.09, -0.12, 0.7, 0.38);
  boxAt(g, kit.dark, 0.5, 1.18, 0.02, -0.12, 0.7, 0.425); // 密封框线
  boxAt(g, kit.metal, 0.03, 0.3, 0.03, 0.06, 0.7, 0.435); // 长把手
  for (const y of [0.24, 1.16]) boxAt(g, kit.metal, 0.04, 0.07, 0.04, -0.37, y, 0.4); // 铰链
  // 顶部制冷机组:格栅 + 风扇盘 + 回气管
  boxAt(g, kit.metal, 0.52, 0.17, 0.42, 0.06, 1.48, -0.02);
  grilleAt(g, kit.dark, 0.4, 3, 0.06, 1.48, 0.196, 0.03);
  cylAt(g, kit.dark, 0.085, 0.085, 0.02, 0.06, 1.52, -0.14, "x", 16); // 冷凝风扇
  boxAt(g, kit.screen, 0.13, 0.07, 0.012, 0.24, 0.98, 0.363); // 温控显示(-18 °C)
  ballAt(g, kit.lampRun, 0.014, 0.32, 1.28, 0.363); // 门框运行灯
  return g;
}

/** 周转笼:脚轮底架 + 钢丝网笼四面 + 两层隔板,前门半开(姿态区分)并装载货箱。 */
function buildRollCageModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.metal, 0.62, 0.04, 0.5, 0, 0.14, 0); // 底架
  for (const [x, z] of [[-0.26, -0.19], [0.26, -0.19], [-0.26, 0.19], [0.26, 0.19]] as const) {
    cylAt(g, kit.rubber, 0.05, 0.055, 0.03, x, 0.055, z, "z", 12); // 脚轮
  }
  for (const [x, z] of [[-0.31, -0.25], [0.31, -0.25], [-0.31, 0.25], [0.31, 0.25]] as const) {
    boxAt(g, kit.metal, 0.03, 0.92, 0.03, x, 0.62, z); // 角立柱
  }
  // 侧网与背网:细丝网格(与围栏同语言,体量缩小)
  for (const z of [-0.25, 0.25]) {
    for (let i = 0; i < 9; i++) boxAt(g, kit.metal, 0.012, 0.88, 0.012, -0.28 + i * 0.07, 0.6, z);
    boxAt(g, kit.metal, 0.62, 0.012, 0.014, 0, 0.42, z);
    boxAt(g, kit.metal, 0.62, 0.012, 0.014, 0, 0.8, z);
  }
  for (let i = 0; i < 6; i++) boxAt(g, kit.metal, 0.012, 0.88, 0.012, -0.31, 0.6, -0.2 + i * 0.08); // 背网
  // 隔板与货物
  boxAt(g, kit.bodyDeep, 0.56, 0.02, 0.44, 0, 0.36, 0);
  boxAt(g, kit.accent, 0.2, 0.18, 0.24, -0.1, 0.46, 0);
  boxAt(g, kit.body, 0.18, 0.16, 0.22, 0.14, 0.44, 0.02);
  // 前门半开:绕左侧立柱外翻(姿态区分)
  const gate = subgroupAt(g, -0.31, 0, 0.25);
  gate.rotation.y = -0.7;
  for (let i = 0; i < 8; i++) boxAt(gate, kit.metal, 0.012, 0.88, 0.012, 0.07 + i * 0.07, 0.6, 0);
  for (const y of [0.42, 0.8]) boxAt(gate, kit.metal, 0.58, 0.012, 0.014, 0.31, y, 0);
  boxAt(gate, kit.accent, 0.12, 0.08, 0.012, 0.31, 0.96, 0); // 门顶编号牌
  return g;
}
