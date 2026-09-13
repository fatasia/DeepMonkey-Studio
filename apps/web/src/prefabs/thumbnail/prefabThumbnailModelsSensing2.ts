import * as THREE from "three";
import type { ModelKit, PrefabThumbnailVariant } from "./prefabThumbnailKit";
import { ballAt, boneMaterial, boxAt, cylAt, grilleAt, helixTubeAt, subgroupAt, tubeAt } from "./prefabThumbnailKit";

/**
 * 波次 C 感知与视觉扩量小样:感烟/感温/声光报警/振动监测探测器、RTU/边缘网关,
 * 枪型/半球/热成像摄像机与 AI 视频分析盒。同族靠"几何 + 姿态 + 材质"三重区分。
 */

/** 传感器族扩量分发:命中波次新变体返回模型,否则交回既有构建器。 */
export function buildSensingVariantModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group | undefined {
  switch (variant.family) {
    case "smoke-detector": return buildSmokeDetectorModel(kit);
    case "heat-detector": return buildHeatDetectorModel(kit);
    case "sounder-strobe": return buildSounderStrobeModel(kit);
    case "vibration": return buildVibrationMonitorModel(kit);
    case "rtu": return buildRtuModel(kit);
    case "edge-gateway": return buildEdgeGatewayModel(kit);
    default: return undefined;
  }
}

/** 摄像机族扩量分发。 */
export function buildCameraVariantModel(kit: ModelKit, variant: PrefabThumbnailVariant): THREE.Group | undefined {
  switch (variant.family) {
    case "bullet": return buildBulletCameraModel(kit);
    case "dome": return buildDomeCameraModel(kit);
    case "thermal": return buildThermalCameraModel(kit);
    case "ai-box": return buildAiBoxModel(kit);
    default: return undefined;
  }
}

/** 展示台座:深色底板 + 金属立柱,探测器类静置姿态的家族统一语言。 */
function detectorStand(g: THREE.Group, kit: ModelKit, height: number): void {
  boxAt(g, kit.dark, 0.4, 0.05, 0.4, 0, 0.025, 0);
  cylAt(g, kit.metal, 0.032, 0.045, height, 0, height / 2 + 0.05, 0);
}

/** 感烟探测器:白色圆盘基座 + 进烟缝环腔体 + 顶部报警 LED,白壳材质与既有传感器拉开。 */
function buildSmokeDetectorModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  const shell = boneMaterial(kit);
  detectorStand(g, kit, 0.48);
  cylAt(g, shell, 0.18, 0.2, 0.05, 0, 0.56, 0); // 吸顶底盘
  cylAt(g, shell, 0.15, 0.17, 0.1, 0, 0.635, 0); // 探测腔体
  for (const y of [0.605, 0.645, 0.685]) tubeAt(g, kit.dark, 0.152, 0.011, 0, y, 0, "z"); // 进烟缝环(水平环)
  cylAt(g, shell, 0.05, 0.1, 0.045, 0, 0.705, 0); // 顶盖
  ballAt(g, kit.lampDanger, 0.02, 0, 0.735, 0); // 报警 LED
  tubeAt(g, kit.accent, 0.171, 0.008, 0, 0.575, 0, "z"); // 铭牌环(安全黄)
  return g;
}

/** 感温探测器:红身 + 纵向散热鳍列,与烟感(白壳缝环)构成材质+几何双区分。 */
function buildHeatDetectorModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  const red = new THREE.MeshStandardMaterial({ color: 0xc95a5e, roughness: 0.42, metalness: 0.08 });
  detectorStand(g, kit, 0.44);
  cylAt(g, red, 0.15, 0.17, 0.09, 0, 0.51, 0); // 底盘
  cylAt(g, red, 0.115, 0.115, 0.14, 0, 0.625, 0); // 壳体
  for (let i = 0; i < 8; i++) {
    const fin = subgroupAt(g, 0, 0.625, 0);
    fin.rotation.y = (i * Math.PI) / 4;
    boxAt(fin, red, 0.014, 0.11, 0.034, 0, 0, 0.126); // 纵向散热鳍
  }
  cylAt(g, red, 0.05, 0.09, 0.04, 0, 0.715, 0); // 顶盖
  ballAt(g, kit.lampWarn, 0.018, 0.072, 0.685, 0.072); // 状态 LED
  return g;
}

/** 声光报警器:立柱机身 + 顶置玻璃爆闪罩 + 前伸红色号角,轮廓三件套一眼可读。 */
function buildSounderStrobeModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  const red = new THREE.MeshStandardMaterial({ color: 0xc95a5e, roughness: 0.42, metalness: 0.08 });
  boxAt(g, kit.dark, 0.36, 0.05, 0.36, 0, 0.025, 0); // 底座
  boxAt(g, kit.bodyDeep, 0.2, 0.5, 0.2, 0, 0.3, 0); // 接线柱身
  boxAt(g, kit.accent, 0.21, 0.06, 0.21, 0, 0.52, 0); // 柱顶座环
  // 爆闪单元:玻璃半球罩 + 琥珀色内芯(顶置)
  ballAt(g, kit.glass, 0.1, 0, 0.62, 0, 1, 0.85, 1);
  ballAt(g, kit.lampWarn, 0.045, 0, 0.6, 0.02);
  // 号角喇叭:双级张口,朝 +x 前下方
  const horn = subgroupAt(g, 0.11, 0.44, 0);
  horn.rotation.z = -1.35;
  cylAt(horn, red, 0.03, 0.05, 0.16, 0, 0.09, 0, "y", 18);
  cylAt(horn, red, 0.05, 0.1, 0.07, 0, 0.2, 0, "y", 18);
  cylAt(horn, kit.dark, 0.102, 0.102, 0.014, 0, 0.235, 0, "y", 18);
  ballAt(g, kit.lampDanger, 0.014, -0.08, 0.56, 0.09); // 柱身报警 LED
  return g;
}

/** 振动监测:轴承座(彩色分件)+ 轴 + 端面吸装加速度计 + 螺旋信号缆 + 调理盒,工业状态监测语境。 */
function buildVibrationMonitorModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.metal, 0.56, 0.1, 0.34, 0, 0.05, 0); // 铸铁底座(亮色离地)
  boxAt(g, kit.bodyDeep, 0.3, 0.24, 0.28, 0, 0.22, 0); // 轴承座
  cylAt(g, kit.metal, 0.085, 0.085, 0.3, 0, 0.3, 0, "x"); // 轴
  for (const s of [-1, 1]) cylAt(g, kit.accent, 0.105, 0.105, 0.045, s * 0.17, 0.3, 0, "x", 18); // 轴承端盖(安全黄)
  cylAt(g, kit.metal, 0.042, 0.05, 0.09, 0.2, 0.4, 0.08); // 加速度计(端面安装,放大)
  const coil = helixTubeAt(g, kit.rubber, { radius: 0.06, height: 0.18, turns: 4, tube: 0.01 }); // 螺旋信号缆
  coil.position.set(0.05, 0.15, 0.19);
  boxAt(g, kit.bodyDeep, 0.22, 0.16, 0.13, -0.17, 0.44, 0); // 信号调理盒
  boxAt(g, kit.screen, 0.14, 0.07, 0.012, -0.17, 0.46, 0.068); // 频谱读数窗
  ballAt(g, kit.lampRun, 0.014, -0.06, 0.46, 0.068);
  return g;
}

/** RTU 远程终端单元:开放式构架(背板+立柱+顶盖,任意机位可读)+ 双色端子排 + DIN 模块组 + 通信天线。 */
function buildRtuModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 0.52, 0.06, 0.42, 0, 0.03, 0); // 安装底担
  boxAt(g, kit.bodyDeep, 0.68, 0.09, 0.05, 0, 0.84, -0.12); // 背板上横梁
  boxAt(g, kit.bodyDeep, 0.68, 0.09, 0.05, 0, 0.14, -0.12); // 背板下横梁(开放式构架,背面机位不退化成色块)
  for (const x of [-0.32, 0.32]) boxAt(g, kit.body, 0.05, 0.8, 0.3, x, 0.48, 0.01); // 侧立柱
  boxAt(g, kit.body, 0.74, 0.05, 0.36, 0, 0.9, -0.02); // 顶盖
  boxAt(g, kit.metal, 0.6, 0.72, 0.02, 0, 0.48, 0.055); // 安装板(亮色衬底)
  for (let i = 0; i < 12; i++) {
    boxAt(g, i % 2 ? kit.accent : kit.dark, 0.034, 0.08, 0.05, -0.238 + i * 0.044, 0.76, 0.08); // 端子排
  }
  for (let i = 0; i < 4; i++) {
    const x = -0.21 + i * 0.14;
    boxAt(g, kit.metal, 0.12, 0.2, 0.07, x, 0.5, 0.085); // IO 模块
    boxAt(g, kit.bodyDeep, 0.1, 0.03, 0.012, x, 0.43, 0.122); // 模块铭牌
    ballAt(g, i % 2 ? kit.lampRun : kit.lampWarn, 0.014, x + 0.032, 0.565, 0.122); // 模块状态灯
  }
  boxAt(g, kit.body, 0.3, 0.15, 0.06, 0, 0.28, 0.085); // RTU 主处理器
  boxAt(g, kit.screen, 0.16, 0.09, 0.012, -0.05, 0.28, 0.118); // 液晶窗
  cylAt(g, kit.dark, 0.01, 0.01, 0.28, 0.26, 1.04, -0.1); // 通信天线
  ballAt(g, kit.dark, 0.024, 0.26, 1.19, -0.1);
  return g;
}

/** 边缘计算网关:无风扇鳍片铝合金机身 + 双鞭状天线 + 前面板网口与状态灯,横置低趴轮廓。 */
function buildEdgeGatewayModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 0.5, 0.05, 0.34, 0, 0.025, 0);
  boxAt(g, kit.metal, 0.54, 0.17, 0.32, 0, 0.21, 0); // 铝合金机身
  boxAt(g, kit.bodyDeep, 0.42, 0.04, 0.26, 0, 0.315, 0); // 顶盖
  for (let i = 0; i < 6; i++) boxAt(g, kit.metal, 0.5, 0.018, 0.05, 0, 0.345, -0.105 + i * 0.042); // 顶面散热鳍
  boxAt(g, kit.dark, 0.52, 0.1, 0.014, 0, 0.21, 0.165); // 前面板
  boxAt(g, kit.screen, 0.09, 0.04, 0.012, 0.16, 0.21, 0.174); // 状态小屏
  for (let i = 0; i < 3; i++) boxAt(g, kit.metal, 0.04, 0.042, 0.016, -0.14 + i * 0.055, 0.21, 0.175); // 网口
  for (let i = 0; i < 4; i++) ballAt(g, i % 2 ? kit.lampRun : kit.lampWarn, 0.009, -0.2 + i * 0.026, 0.25, 0.174); // 状态灯
  for (const x of [-0.18, 0.06]) {
    cylAt(g, kit.dark, 0.008, 0.008, 0.26, x, 0.46, -0.11); // 鞭状天线
    ballAt(g, kit.dark, 0.016, x, 0.6, -0.11);
  }
  boxAt(g, kit.dark, 0.3, 0.03, 0.08, 0, 0.1, 0); // DIN 卡轨
  return g;
}

/** 枪型网络摄像机:白色加长机身 + 悬空遮阳罩 + IR 灯阵 + 万向壁装支架(与工业相机黑短身区分)。 */
function buildBulletCameraModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  const shell = boneMaterial(kit);
  const ir = new THREE.MeshStandardMaterial({ color: 0xd98880, emissive: 0xd98880, emissiveIntensity: 0.5, roughness: 0.4 }); // IR 补光灯
  boxAt(g, kit.dark, 0.05, 0.62, 0.05, -0.26, 0.31, 0); // 壁装立柱
  boxAt(g, kit.metal, 0.18, 0.045, 0.05, -0.16, 0.6, 0); // 横臂
  ballAt(g, kit.dark, 0.034, -0.07, 0.6, 0); // 万向节
  const body = subgroupAt(g, 0.15, 0.6, 0);
  body.rotation.z = -0.1;
  boxAt(body, shell, 0.46, 0.13, 0.13, 0, 0, 0); // 白色机身
  boxAt(body, shell, 0.5, 0.022, 0.15, -0.02, 0.09, 0); // 遮阳罩(悬空留缝)
  cylAt(body, kit.dark, 0.056, 0.056, 0.1, 0.27, 0, 0, "x", 18); // 镜头筒
  cylAt(body, kit.metal, 0.062, 0.062, 0.02, 0.31, 0, 0, "x", 18); // 镜头饰环
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    cylAt(body, i % 2 ? ir : kit.dark, 0.009, 0.009, 0.016, 0.245, Math.cos(angle) * 0.043, Math.sin(angle) * 0.043, "x", 8); // IR 灯阵
  }
  boxAt(body, kit.bodyDeep, 0.1, 0.12, 0.12, -0.27, 0, 0); // 尾部接线盒
  ballAt(body, kit.lampRun, 0.012, -0.16, 0.066, 0.066);
  return g;
}

/** 半球型摄像机:吊装杆 + 吸顶底盘 + 玻璃半球罩内藏机芯,全库唯一半球语言。 */
function buildDomeCameraModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  const shell = boneMaterial(kit);
  boxAt(g, kit.dark, 0.44, 0.05, 0.44, 0, 0.025, 0); // 吸顶盘座
  cylAt(g, kit.metal, 0.02, 0.02, 0.42, 0, 0.26, 0); // 吊装杆
  cylAt(g, shell, 0.17, 0.17, 0.06, 0, 0.51, 0); // 底盘
  ballAt(g, kit.glass, 0.14, 0, 0.5, 0, 1, 0.75, 1); // 半球罩(下半沉入底盘)
  ballAt(g, kit.bodyDeep, 0.052, 0, 0.495, 0.05); // 内藏机芯球
  cylAt(g, kit.metal, 0.026, 0.026, 0.024, 0, 0.495, 0.098, "z", 14); // 镜头
  for (let i = 0; i < 3; i++) {
    const lug = subgroupAt(g, 0, 0.535, 0);
    lug.rotation.y = (i * Math.PI * 2) / 3;
    boxAt(lug, shell, 0.05, 0.018, 0.028, 0.165, 0, 0); // 安装耳
  }
  return g;
}

/** 热成像摄像机:深灰双镜筒(可见光/红外双通道)+ 锗镜警示环 + 侧面测温屏。 */
function buildThermalCameraModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 0.05, 0.62, 0.05, -0.26, 0.31, 0);
  boxAt(g, kit.metal, 0.16, 0.045, 0.05, -0.17, 0.6, 0);
  const body = subgroupAt(g, 0.1, 0.58, 0);
  body.rotation.z = -0.08;
  boxAt(body, kit.bodyDeep, 0.42, 0.16, 0.13, 0, 0, 0); // 深灰双通道机身
  boxAt(body, kit.metal, 0.3, 0.02, 0.15, 0, 0.1, 0); // 遮阳罩
  cylAt(body, kit.dark, 0.055, 0.055, 0.09, 0.24, 0.04, 0, "x", 18); // 红外锗镜(大)
  cylAt(body, kit.accent, 0.06, 0.06, 0.014, 0.28, 0.04, 0, "x", 18); // 锗镜警示环
  cylAt(body, kit.dark, 0.038, 0.038, 0.07, 0.24, -0.042, 0, "x", 14); // 可见光通道(小)
  cylAt(body, kit.metal, 0.042, 0.042, 0.014, 0.275, -0.042, 0, "x", 14);
  boxAt(body, kit.screen, 0.11, 0.06, 0.012, -0.1, 0.02, 0.068); // 测温屏(最高/最低温)
  ballAt(body, kit.lampWarn, 0.012, 0.12, 0.082, 0.066);
  return g;
}

/** AI 视频分析盒:1U 横置机箱 + 机柜耳 + 网口排 + 通道状态灯阵 + 双天线。 */
function buildAiBoxModel(kit: ModelKit): THREE.Group {
  const g = kit.group;
  boxAt(g, kit.dark, 0.56, 0.05, 0.38, 0, 0.025, 0);
  boxAt(g, kit.metal, 0.62, 0.15, 0.34, 0, 0.2, 0); // 1U 机身
  boxAt(g, kit.bodyDeep, 0.64, 0.03, 0.36, 0, 0.29, 0); // 顶盖
  for (const x of [-0.33, 0.33]) boxAt(g, kit.metal, 0.03, 0.17, 0.3, x, 0.2, 0); // 机柜耳
  boxAt(g, kit.dark, 0.58, 0.13, 0.012, 0, 0.2, 0.172); // 前面板
  for (let i = 0; i < 4; i++) boxAt(g, kit.metal, 0.05, 0.045, 0.016, -0.21 + i * 0.07, 0.175, 0.182); // 网口排
  for (let r = 0; r < 2; r++) for (let c = 0; c < 6; c++) {
    ballAt(g, c < 4 ? kit.lampRun : kit.lampWarn, 0.008, -0.05 + c * 0.026, 0.205 + r * 0.032, 0.182); // 通道状态灯阵
  }
  boxAt(g, kit.screen, 0.1, 0.05, 0.012, 0.18, 0.21, 0.18); // 算力状态屏
  for (const x of [-0.22, 0.22]) {
    cylAt(g, kit.dark, 0.008, 0.008, 0.24, x, 0.42, -0.13); // 天线
    ballAt(g, kit.dark, 0.015, x, 0.55, -0.13);
  }
  return g;
}
