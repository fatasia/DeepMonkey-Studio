import * as THREE from "three";
import type { ModelKit, PrefabThumbnailVariant } from "./prefabThumbnailKit";
import { ballAt, boneMaterial, boxAt, capsuleAt, cylAt, subgroupAt, tubeAt } from "./prefabThumbnailKit";
import { buildDualArmModel, buildGantryRobotModel } from "./prefabThumbnailModelsLogistics2";
/** 机械臂骨架分发:底座 + 转台 + 大臂 + 肘 + 小臂 + 腕 + 末端工具。
 *  同族变体用"几何 + 姿态 + 材质"三重区分,缩略图并排必须肉眼可辨。 */
export function buildRobotArmModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group {
  const g = kit.group;
  const family = variant.family ?? "articulated";
  if (family === "delta") return buildDeltaRobot(g, kit, variant.tail === "delta-4");
  if (family === "scara") return buildScaraRobot(g, kit, variant.tail === "scara-4-fast");
  if (family === "cartesian") return buildCartesianRobot(g, kit);
  if (family === "gantry") return buildGantryRobotModel(g, kit);
  if (family === "dual-arm") return buildDualArmModel(g, kit);
  if (family === "collaborative") return buildCobotModel(g, kit, variant.tail === "cobot-7");
  if (family === "palletizer") {
    return variant.tail === "palletizer-6"
      ? buildPalletizer6Model(g, kit)
      : buildPalletizer4Model(g, kit, variant.tail === "palletizer-4-heavy");
  }
  return buildArticulatedModel(g, kit, variant);
}

/** 关节机家族:六轴标准 / 重载搬运(方臂巨铸件)/ 弧焊(焊枪+焊丝鼓)/ 点焊(点焊钳+变压器)。
 *  四者共用"关节机"拓扑,靠连杆形状、姿态、附件与体量拉开肉眼差距。 */
function buildArticulatedModel(g: THREE.Group, kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group {
  const tool = variant.tool ?? "gripper";
  if (variant.tail === "handling-6-heavy") {
    // 重载搬运:方正铸件臂 + 摇枕基座 + 前伸低姿态 + 宽指重载夹爪
    boxAt(g, kit.dark, 0.72, 0.14, 0.58, 0, 0.07, 0);
    cylAt(g, kit.body, 0.3, 0.37, 0.2, 0, 0.24, 0);
    boxAt(g, kit.bodyDeep, 0.44, 0.08, 0.44, 0, 0.37, 0); // 肩摇枕
    const shoulder = subgroupAt(g, 0, 0.42, 0);
    shoulder.rotation.z = 0.95;
    boxAt(shoulder, kit.body, 0.24, 0.62, 0.3, 0, 0.3, 0); // 方形大臂
    const elbow = subgroupAt(shoulder, 0, 0.62, 0);
    elbow.rotation.z = -1.55;
    cylAt(elbow, kit.bodyDeep, 0.13, 0.13, 0.3, 0, 0, 0, "z"); // 大直径肘壳
    boxAt(elbow, kit.body, 0.2, 0.5, 0.24, 0, 0.24, 0); // 方形小臂
    const wrist = subgroupAt(elbow, 0, 0.5, 0);
    wrist.rotation.z = 0.5;
    boxAt(wrist, kit.bodyDeep, 0.12, 0.12, 0.16, 0, 0.07, 0);
    boxAt(wrist, kit.dark, 0.16, 0.06, 0.1, 0, 0.18, 0);
    for (const side of [-1, 1]) boxAt(wrist, kit.metal, 0.035, 0.17, 0.09, side * 0.07, 0.3, 0); // 宽指夹爪
    return g;
  }
  const isSpot = variant.tail === "spot-welding-6";
  const isWeld = variant.tail === "welding-6";
  const scale = isSpot ? 1.12 : 1;
  // 底座与转台(点焊机加大)
  cylAt(g, kit.dark, 0.24 * scale, 0.28 * scale, 0.08, 0, 0.04, 0);
  cylAt(g, kit.body, 0.17 * scale, 0.2 * scale, 0.16 * scale, 0, 0.16 * scale, 0);
  const shoulder = subgroupAt(g, 0, 0.26 * scale, 0);
  shoulder.rotation.z = isSpot ? 0.34 : isWeld ? 0.62 : 0.5; // 姿态:点焊抬肩 / 弧焊引臂 / 标准待机
  capsuleAt(shoulder, kit.body, 0.11 * scale, 0.42 * scale, 0, 0.28 * scale, 0); // 大臂
  if (isSpot) boxAt(shoulder, kit.bodyDeep, 0.16, 0.3, 0.18, 0.12 * scale, 0.24 * scale, 0); // 点焊变压器(大臂侧面)
  const elbow = subgroupAt(shoulder, 0, 0.56 * scale, 0);
  elbow.rotation.z = isSpot ? -1.05 : isWeld ? -1.5 : -1.25;
  ballAt(elbow, kit.bodyDeep, 0.1 * scale); // 肘关节
  capsuleAt(elbow, kit.body, 0.085 * scale, 0.36 * scale, 0, 0.26 * scale, 0); // 小臂
  const wrist = subgroupAt(elbow, 0, 0.52 * scale, 0);
  wrist.rotation.z = isSpot ? 0.75 : isWeld ? 0.5 : 0.6;
  attachTool(kit, wrist, tool, scale);
  if (isWeld) {
    // 弧焊语境:基座旁焊丝盘 + 沿臂送丝管
    cylAt(g, kit.dark, 0.14, 0.14, 0.09, 0.36, 0.12, 0.16, "y", 20);
    cylAt(g, kit.metal, 0.05, 0.05, 0.095, 0.36, 0.12, 0.16, "y", 12);
    boxAt(elbow, kit.dark, 0.03, 0.3, 0.03, 0.1 * scale, 0.2, -0.06); // 送丝管
  }
  return g;
}

/** 协作机器人:白色圆角壳 + 深色关节鼓(与人涂装关节机形成材质区分)。
 *  六轴向内折叠;七轴 S 形后弯 + 前臂中段第 7 轴鼓,轮廓一眼可分。 */
function buildCobotModel(g: THREE.Group, kit: ModelKit, isSeven: boolean): THREE.Group {
  const shell = boneMaterial(kit);
  cylAt(g, kit.dark, 0.22, 0.26, 0.08, 0, 0.04, 0);
  cylAt(g, shell, 0.16, 0.18, 0.12, 0, 0.14, 0);
  const shoulder = subgroupAt(g, 0, 0.22, 0);
  if (isSeven) {
    shoulder.rotation.z = -0.42; // 向后展开
    tubeAt(shoulder, kit.dark, 0.082, 0.02, 0, 0.045, 0, "y"); // 肩关节鼓
    capsuleAt(shoulder, shell, 0.07, 0.46, 0, 0.27, 0);
    const elbow = subgroupAt(shoulder, 0, 0.53, 0);
    elbow.rotation.z = -2.15;
    ballAt(elbow, kit.dark, 0.072);
    capsuleAt(elbow, shell, 0.058, 0.34, 0, 0.2, 0);
    tubeAt(elbow, kit.dark, 0.066, 0.016, 0, 0.2, 0, "y"); // 第 7 轴鼓(前臂中段)
    const wrist = subgroupAt(elbow, 0, 0.41, 0);
    wrist.rotation.z = 1.4; // 腕部回勾,整体成 S 形
    cylAt(wrist, kit.dark, 0.042, 0.042, 0.08, 0, 0.03, 0);
    attachTool(kit, wrist, "gripper", 0.66);
  } else {
    shoulder.rotation.z = 0.95; // 向内折叠的紧凑姿态
    tubeAt(shoulder, kit.dark, 0.096, 0.02, 0, 0.05, 0, "y");
    capsuleAt(shoulder, shell, 0.088, 0.36, 0, 0.22, 0);
    const elbow = subgroupAt(shoulder, 0, 0.44, 0);
    elbow.rotation.z = -2.0;
    ballAt(elbow, kit.dark, 0.085);
    capsuleAt(elbow, shell, 0.07, 0.28, 0, 0.17, 0);
    const wrist = subgroupAt(elbow, 0, 0.34, 0);
    wrist.rotation.z = 0.85;
    cylAt(wrist, kit.dark, 0.05, 0.05, 0.09, 0, 0.035, 0);
    attachTool(kit, wrist, "gripper", 0.76);
  }
  return g;
}

/** 四轴码垛:平行四杆连杆 + 宽吸盘板 + 地面货垛语境;heavy 双侧双杆、吸盘 2×4、货垛更高。 */
function buildPalletizer4Model(g: THREE.Group, kit: ModelKit, heavy: boolean): THREE.Group {
  const s = heavy ? 1.42 : 1.1;
  cylAt(g, kit.dark, 0.3 * s, 0.38 * s, 0.1, 0, 0.05, 0);
  cylAt(g, kit.body, 0.2 * s, 0.25 * s, 0.22 * s, 0, 0.21 * s, 0);
  const shoulder = subgroupAt(g, 0, 0.32 * s, 0);
  shoulder.rotation.z = 0.6;
  capsuleAt(shoulder, kit.body, 0.12 * s, 0.4 * s, 0, 0.26 * s, 0);
  for (const z of heavy ? [-0.12, 0.12] : [0.12]) {
    for (const dx of [-0.05, 0.05]) boxAt(shoulder, kit.metal, 0.026, 0.58 * s, 0.026, dx * s, 0.3 * s, z * s); // 平行四杆
  }
  const elbow = subgroupAt(shoulder, 0, 0.56 * s, 0);
  elbow.rotation.z = -1.32;
  ballAt(elbow, kit.bodyDeep, 0.1 * s);
  capsuleAt(elbow, kit.body, 0.09 * s, 0.3 * s, 0, 0.22 * s, 0);
  const wrist = subgroupAt(elbow, 0, 0.44 * s, 0);
  wrist.rotation.z = 0.55;
  cylAt(wrist, kit.bodyDeep, 0.06 * s, 0.07 * s, 0.1 * s, 0, 0.05 * s, 0);
  boxAt(wrist, kit.dark, 0.06 * s, 0.07 * s, 0.06 * s, 0, 0.14 * s, 0);
  const cols = heavy ? 4 : 3;
  boxAt(wrist, kit.accent, (heavy ? 0.56 : 0.42) * s, 0.03 * s, 0.34 * s, 0, 0.21 * s, 0); // 吸盘板
  for (let c = 0; c < cols; c++) for (const cz of [-0.08, 0.08]) {
    cylAt(wrist, kit.dark, 0.03 * s, 0.042 * s, 0.035 * s, (c - (cols - 1) / 2) * 0.13 * s, 0.24 * s, cz * s, "y", 12);
  }
  buildPalletStack(g, kit, heavy ? -0.9 : -0.55, heavy ? 3 : 2, heavy ? 0.36 : 0.3);
  return g;
}

/** 六轴码垛:重载方臂 + 真空阵列头 + 侧旁货垛(与四杆码垛、重载搬运夹爪式一眼区分)。 */
function buildPalletizer6Model(g: THREE.Group, kit: ModelKit): THREE.Group {
  cylAt(g, kit.dark, 0.34, 0.4, 0.1, 0, 0.05, 0);
  cylAt(g, kit.body, 0.24, 0.3, 0.24, 0, 0.26, 0);
  const shoulder = subgroupAt(g, 0, 0.38, 0);
  shoulder.rotation.z = 0.72;
  boxAt(shoulder, kit.bodyDeep, 0.3, 0.12, 0.36, 0, 0.02, 0); // 肩铸件
  boxAt(shoulder, kit.body, 0.26, 0.6, 0.32, 0, 0.3, 0); // 厚重方臂
  const elbow = subgroupAt(shoulder, 0, 0.6, 0);
  elbow.rotation.z = -1.6;
  cylAt(elbow, kit.bodyDeep, 0.13, 0.13, 0.32, 0, 0, 0, "z");
  boxAt(elbow, kit.body, 0.22, 0.5, 0.26, 0, 0.22, 0);
  const wrist = subgroupAt(elbow, 0, 0.48, 0);
  wrist.rotation.z = 0.85;
  boxAt(wrist, kit.bodyDeep, 0.14, 0.14, 0.18, 0, 0.07, 0);
  boxAt(wrist, kit.accent, 0.5, 0.03, 0.36, 0, 0.2, 0); // 真空板
  for (const cx of [-0.15, 0, 0.15]) for (const cz of [-0.1, 0.1]) {
    cylAt(wrist, kit.dark, 0.032, 0.045, 0.04, cx, 0.25, cz, "y", 12);
  }
  buildPalletStack(g, kit, 0.72, 2, 0.34);
  return g;
}

/** 码垛语境:托盘 + 交错货箱层(层色交替),给"码垛"一个可读的应用场景。 */
function buildPalletStack(g: THREE.Group, kit: ModelKit, x: number, layers: number, size: number): void {
  boxAt(g, kit.rubber, size * 1.3, 0.045, size, x, 0.022, 0.12);
  for (let layer = 0; layer < layers; layer += 1) {
    boxAt(g, layer % 2 ? kit.bodyDeep : kit.accent, size, size * 0.55, size * 0.85, x, 0.05 + layer * size * 0.6 + size * 0.28, 0.12);
  }
}

function attachTool(kit: ModelKit, wrist: THREE.Group, tool: string, scale: number, isPalletizer = false): void {
  cylAt(wrist, kit.bodyDeep, 0.06 * scale, 0.07 * scale, 0.1 * scale, 0, 0.05 * scale, 0); // 腕
  if (tool === "vacuum") {
    if (isPalletizer) {
      // C4 码垛抓手组:宽吸盘板 + 2×3 吸盘阵列 + 两侧导料板
      boxAt(wrist, kit.dark, 0.06 * scale, 0.07 * scale, 0.06 * scale, 0, 0.14 * scale, 0);
      boxAt(wrist, kit.accent, 0.4 * scale, 0.03 * scale, 0.3 * scale, 0, 0.2 * scale, 0);
      for (const cx of [-0.12, 0, 0.12]) for (const cz of [-0.08, 0.08]) {
        cylAt(wrist, kit.dark, 0.03 * scale, 0.042 * scale, 0.035 * scale, cx * scale, 0.23 * scale, cz * scale, "y", 12);
      }
      for (const dx of [-0.21, 0.21]) boxAt(wrist, kit.metal, 0.015 * scale, 0.12 * scale, 0.3 * scale, dx * scale, 0.27 * scale, 0);
      return;
    }
    cylAt(wrist, kit.dark, 0.05 * scale, 0.05 * scale, 0.08 * scale, 0, 0.14 * scale, 0); // 真空吸盘杆
    boxAt(wrist, kit.accent, 0.34 * scale, 0.03 * scale, 0.22 * scale, 0, 0.2 * scale, 0); // 吸盘板
  } else if (tool === "welder") {
    cylAt(wrist, kit.dark, 0.02, 0.006, 0.16, 0, 0.16, 0.03, "y", 10); // 焊枪
    cylAt(wrist, kit.metal, 0.012, 0.008, 0.035, 0, 0.255, 0.03, "y", 10); // 导电嘴
    tubeAt(wrist, kit.metal, 0.07, 0.012, 0, 0.21, 0.03, "y", Math.PI * 2, 20); // C4 火花防护罩
  } else if (tool === "spot-gun") {
    cylAt(wrist, kit.bodyDeep, 0.03, 0.03, 0.16, 0.05, 0.14, 0, "z", 10); // 点焊钳臂
    cylAt(wrist, kit.metal, 0.045, 0.045, 0.06, 0.05, 0.06, 0, "y", 12); // 电极
  } else {
    // 二指夹爪 + 指间夹持的工件(微交互:机械臂作业中语境)
    boxAt(wrist, kit.dark, 0.1 * scale, 0.05 * scale, 0.06 * scale, 0, 0.12 * scale, 0);
    for (const side of [-1, 1]) boxAt(wrist, kit.metal, 0.02 * scale, 0.09 * scale, 0.04 * scale, side * 0.04 * scale, 0.18 * scale, 0);
    boxAt(wrist, kit.accent, 0.048 * scale, 0.048 * scale, 0.048 * scale, 0, 0.185 * scale, 0);
  }
}

function buildDeltaRobot(g: THREE.Group, kit: ModelKit, fourArm: boolean): THREE.Group {
  // 蜘蛛型并行机构:伺服电机座 120°(三轴)/ 90°(四轴)分布 + 主动/从动臂 + 中央动平台。
  // delta-3 与 delta-4 的臂数与顶部轮毂尺寸不同,并排一眼可辨。
  const arms = fourArm ? 4 : 3;
  const frameY = 1.28;
  const podRadius = fourArm ? 0.38 : 0.34;
  boxAt(g, kit.dark, fourArm ? 0.74 : 0.62, 0.06, fourArm ? 0.74 : 0.5, 0, 0.03, 0); // 底座
  boxAt(g, kit.body, 0.1, frameY, 0.1, -0.2, frameY / 2, -0.18); // 支撑立柱
  cylAt(g, kit.bodyDeep, fourArm ? 0.1 : 0.07, fourArm ? 0.1 : 0.07, 0.09, 0, frameY + 0.04, 0, "y", 18); // 顶部中毂
  for (let i = 0; i < arms; i++) {
    const mount = subgroupAt(g, 0, frameY, 0);
    mount.rotation.y = (i * Math.PI * 2) / arms;
    boxAt(mount, kit.body, 0.42, 0.06, 0.05, 0.21, 0, 0); // 径向梁
    cylAt(mount, kit.bodyDeep, 0.062, 0.062, 0.11, podRadius, -0.03, 0, "z", 14); // 伺服电机
    // 主动臂:电机 → 肘(角度按几何位置反推)
    const upper = subgroupAt(mount, podRadius, -0.04, 0);
    upper.rotation.z = 2.76;
    boxAt(upper, kit.bodyDeep, 0.028, 0.28, 0.036, 0, 0.14, 0);
    // 从动臂:肘 → 动平台(细金属杆)
    const lower = subgroupAt(upper, 0, 0.28, 0);
    lower.rotation.z = 2.28;
    boxAt(lower, kit.metal, 0.012, 0.58, 0.012, 0, 0.29, 0);
  }
  const platform = subgroupAt(g, 0, 0.62, 0);
  cylAt(platform, kit.body, fourArm ? 0.12 : 0.1, fourArm ? 0.12 : 0.1, 0.05, 0, 0, 0, "y", 18); // 动平台
  cylAt(platform, kit.dark, 0.03, 0.02, 0.08, 0, -0.06, 0, "y", 12); // 拾取头
  return g;
}

function buildScaraRobot(g: THREE.Group, kit: ModelKit, fast: boolean): THREE.Group {
  // 高速装配型:电子/食品行业白色壳 + 纤细连杆 + 折叠姿态 + 顶部同步带罩,
  // 与标准 SCARA(蓝色涂装、平伸姿态)构成三重区分。
  const shellMat = fast ? boneMaterial(kit) : kit.body;
  cylAt(g, kit.dark, 0.2, 0.24, 0.1, 0, 0.05, 0);
  cylAt(g, shellMat, 0.13, 0.15, 0.34, 0, 0.27, 0);
  const link1 = subgroupAt(g, 0, 0.5, 0);
  link1.rotation.y = fast ? -0.85 : 0.4;
  boxAt(link1, shellMat, fast ? 0.4 : 0.44, 0.09, fast ? 0.07 : 0.09, 0.2, 0, 0);
  if (fast) boxAt(link1, kit.dark, 0.34, 0.022, 0.05, 0.2, 0.056, 0); // 同步带罩
  cylAt(link1, kit.bodyDeep, 0.055, 0.055, 0.1, 0.4, 0, 0, "y");
  const link2 = subgroupAt(link1, 0.4, 0, 0);
  link2.rotation.y = fast ? 1.5 : -0.9;
  boxAt(link2, shellMat, 0.3, 0.08, fast ? 0.065 : 0.08, 0.15, 0, 0);
  cylAt(link2, kit.bodyDeep, 0.04, 0.04, 0.26, 0.3, -0.1, 0, "y"); // 升降轴
  boxAt(link2, kit.metal, 0.05, 0.03, 0.05, 0.3, -0.24, 0);
  return g;
}

function buildCartesianRobot(g: THREE.Group, kit: ModelKit): THREE.Group {
  for (const x of [-0.55, 0.55]) for (const z of [-0.3, 0.3]) boxAt(g, kit.metal, 0.05, 0.9, 0.05, x, 0.45, z); // 立柱
  boxAt(g, kit.body, 1.3, 0.12, 0.12, 0, 0.96, -0.3); // X 横梁
  boxAt(g, kit.bodyDeep, 0.16, 0.2, 0.3, 0.18, 0.96, -0.3); // 滑座
  boxAt(g, kit.metal, 0.06, 0.4, 0.06, 0.18, 0.7, -0.3); // Z 轴
  boxAt(g, kit.accent, 0.16, 0.04, 0.16, 0.18, 0.48, -0.3); // 末端法兰
  boxAt(g, kit.dark, 0.7, 0.05, 0.7, 0, 0.03, 0); // 底板
  return g;
}
