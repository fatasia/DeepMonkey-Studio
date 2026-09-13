import * as THREE from "three";
import type { ModelKit } from "./prefabThumbnailKit";
import { ballAt, boltQuadAt, boxAt, capsuleAt, cylAt, flangeAt, grilleAt, helixTubeAt, stackLightAt, subgroupAt, tubeAt, ventDotsAt } from "./prefabThumbnailKit";

/**
 * 扩量机型小样(2026-09-12):输送 screw/bucket-elevator,仓储 silo/asrs-rack,
 * 机器人 gantry/dual-arm,移动 agv.uav,仪表 level/flow/pressure-transmitter/temperature-transmitter。
 */

/** 螺旋输送机:U 槽 + 中心轴螺旋叶(C7 连续螺旋面)+ 端部驱动与进出料口。 */
export function buildScrewConveyorModel(g: THREE.Group, kit: ModelKit): THREE.Group {
  boxAt(g, kit.body, 1.24, 0.3, 0.42, 0, 0.5, 0); // 槽体
  boxAt(g, kit.bodyDeep, 1.2, 0.03, 0.42, 0, 0.67, 0); // 半开盖板
  cylAt(g, kit.metal, 0.04, 0.04, 1.14, 0, 0.5, 0, "x"); // 中心轴
  const blade = helixTubeAt(g, kit.metal, { radius: 0.16, height: 1.05, turns: 5, tube: 0.036 }); // 螺旋叶管
  blade.rotation.z = Math.PI / 2; // 螺旋推进方向沿 x
  blade.position.set(0.55, 0.5, 0);
  for (const x of [-0.64, 0.64]) boxAt(g, kit.dark, 0.1, 0.16, 0.18, x, 0.5, 0); // 端部轴承座
  cylAt(g, kit.bodyDeep, 0.09, 0.09, 0.16, -0.35, 0.74, 0); // 顶部进料口
  boxAt(g, kit.bodyDeep, 0.2, 0.14, 0.18, 0.42, 0.28, 0.26); // 侧面出料口
  cylAt(g, kit.bodyDeep, 0.1, 0.1, 0.22, 0.78, 0.5, 0, "x"); // 驱动电机
  for (const [x, z] of [[-0.45, 0.16], [0.45, 0.16], [-0.45, -0.16], [0.45, -0.16]] as const) {
    boxAt(g, kit.metal, 0.035, 0.36, 0.035, x, 0.18, z);
  }
  boxAt(g, kit.dark, 1.0, 0.04, 0.4, 0, 0.02, 0);
  return g;
}

/** 斗式提升机:机头驱动 + 双筒机身 + 视窗内料斗带 + 机座张紧。 */
export function buildBucketElevatorModel(g: THREE.Group, kit: ModelKit): THREE.Group {
  boxAt(g, kit.dark, 0.52, 0.22, 0.42, 0, 0.11, 0); // 机座
  boxAt(g, kit.body, 0.44, 1.5, 0.3, 0, 0.97, 0); // 机筒
  boxAt(g, kit.glass, 0.28, 1.1, 0.015, 0, 0.95, 0.158); // 前视窗
  for (const y of [0.5, 0.78, 1.06, 1.34]) {
    boxAt(g, kit.accent, 0.15, 0.1, 0.1, 0.04, y, 0.04); // 上行料斗
    boxAt(g, kit.accent, 0.15, 0.1, 0.1, -0.04, y + 0.14, -0.04); // 下行料斗
  }
  boxAt(g, kit.body, 0.58, 0.4, 0.46, 0, 1.92, 0); // 机头箱
  cylAt(g, kit.bodyDeep, 0.08, 0.08, 0.2, -0.37, 1.92, 0, "z"); // 驱动电机
  const chute = boxAt(g, kit.bodyDeep, 0.34, 0.05, 0.22, 0.42, 1.74, 0); // 卸料斜槽
  chute.rotation.z = -0.55;
  boxAt(g, kit.screen, 0.1, 0.07, 0.012, 0, 0.62, 0.156); // 检视口
  for (const x of [-0.16, 0.16]) cylAt(g, kit.metal, 0.02, 0.02, 0.16, x, 0.26, 0.17, "y"); // 张紧螺杆
  stackLightAt(g, kit, 0.34, 2.12, 0, 0.16);
  return g;
}

/** 料仓:支腿 + 锥斗 + 仓体 + 锥顶(除尘器/人孔)+ 料位计 + 底部蝶阀。 */
export function buildSiloModel(g: THREE.Group, kit: ModelKit): THREE.Group {
  for (const [x, z] of [[-0.32, -0.32], [0.32, -0.32], [-0.32, 0.32], [0.32, 0.32]] as const) {
    boxAt(g, kit.metal, 0.05, 0.52, 0.05, x, 0.26, z); // 支腿
    boxAt(g, kit.dark, 0.1, 0.03, 0.1, x, 0.015, z);
  }
  boltQuadAt(g, kit, 0.64, 0.64, 0, 0.03, 0); // 支腿地脚螺栓(波次 E 贴花)
  cylAt(g, kit.bodyDeep, 0.42, 0.08, 0.5, 0, 0.77, 0); // 锥斗
  cylAt(g, kit.body, 0.42, 0.42, 0.95, 0, 1.5, 0); // 仓体
  for (const y of [1.1, 1.5, 1.9]) tubeAt(g, kit.metal, 0.422, 0.01, 0, y, 0, "y"); // 仓体加强箍
  cylAt(g, kit.body, 0.05, 0.42, 0.22, 0, 2.08, 0); // 锥顶
  boxAt(g, kit.bodyDeep, 0.2, 0.16, 0.2, 0.24, 2.12, 0.1); // 仓顶除尘器
  ventDotsAt(g, kit.dark, 0.14, 2, 3, 0.24, 2.08, 0.202);
  cylAt(g, kit.metal, 0.08, 0.08, 0.05, -0.16, 2.05, -0.12); // 人孔
  boxAt(g, kit.dark, 0.1, 0.08, 0.05, 0.43, 1.7, 0.1); // 料位计
  cylAt(g, kit.dark, 0.012, 0.012, 0.5, 0.43, 1.42, 0.1); // 料位计线管
  cylAt(g, kit.metal, 0.08, 0.08, 0.16, 0, 0.46, 0); // 出料口
  tubeAt(g, kit.accent, 0.07, 0.014, 0, 0.4, 0, "y"); // 蝶阀手轮
  boxAt(g, kit.metal, 0.03, 1.4, 0.03, 0.12, 1.3, 0.43); // 爬梯
  boxAt(g, kit.metal, 0.03, 1.4, 0.03, 0.12, 1.3, 0.5);
  for (let i = 0; i < 7; i++) boxAt(g, kit.metal, 0.03, 0.012, 0.07, 0.12, 0.66 + i * 0.19, 0.465);
  return g;
}

/** 立体库货柜:双排高位货架 + 中间巷道堆垛机(地轨/顶轨/载货台)。 */
export function buildAsrsRackModel(g: THREE.Group, kit: ModelKit): THREE.Group {
  for (const z of [-0.3, 0.3]) {
    for (const x of [-0.72, 0, 0.72]) boxAt(g, kit.accent, 0.05, 1.7, 0.05, x, 0.85, z); // 排立柱
    for (const y of [0.5, 0.95, 1.4]) {
      for (const dz of [-0.05, 0.05]) boxAt(g, kit.body, 1.5, 0.06, 0.04, 0, y, z + dz); // 层梁
      for (const x of [-0.42, 0.42]) boxAt(g, kit.bodyDeep, 0.5, 0.26, 0.4, x, y + 0.18, z); // 货箱
    }
  }
  boxAt(g, kit.metal, 1.6, 0.02, 0.06, 0, 0.02, 0); // 地轨
  boxAt(g, kit.metal, 1.6, 0.02, 0.06, 0, 1.76, 0); // 顶轨
  boxAt(g, kit.dark, 0.34, 0.08, 0.5, 0.24, 0.06, 0); // 堆垛机底座
  boxAt(g, kit.body, 0.08, 1.66, 0.1, 0.24, 0.93, 0); // 堆垛机立柱
  boxAt(g, kit.accent, 0.4, 0.05, 0.36, 0.24, 0.85, 0); // 载货台
  boxAt(g, kit.bodyDeep, 0.3, 0.24, 0.3, 0.24, 1.0, 0); // 台上货箱
  cylAt(g, kit.bodyDeep, 0.05, 0.05, 0.06, 0.24, 0.12, 0, "z", 14); // 行走轮
  return g;
}

/** 龙门桁架机械手:双纵梁 + 横梁滑车 + 垂直 Z 轴 + 末端夹爪。 */
export function buildGantryRobotModel(g: THREE.Group, kit: ModelKit): THREE.Group {
  boxAt(g, kit.dark, 1.5, 0.06, 0.95, 0, 0.03, 0); // 底板
  for (const x of [-0.62, 0.62]) for (const z of [-0.38, 0.38]) boxAt(g, kit.metal, 0.06, 1.12, 0.06, x, 0.59, z); // 立柱
  for (const z of [-0.38, 0.38]) boxAt(g, kit.body, 1.5, 0.15, 0.12, 0, 1.22, z); // 双纵梁
  boxAt(g, kit.body, 0.13, 0.15, 0.86, 0.24, 1.22, 0); // 横梁
  boxAt(g, kit.bodyDeep, 0.24, 0.26, 0.3, 0.24, 1.18, -0.12); // 滑车
  boxAt(g, kit.metal, 0.08, 0.62, 0.08, 0.24, 0.82, -0.12); // Z 轴
  boxAt(g, kit.accent, 0.16, 0.04, 0.16, 0.24, 0.48, -0.12); // 末端法兰
  for (const dx of [-0.045, 0.045]) boxAt(g, kit.metal, 0.02, 0.12, 0.04, 0.24 + dx, 0.4, -0.12); // 夹爪指
  boxAt(g, kit.metal, 0.06, 0.02, 0.2, 0.24, 0.36, -0.12); // 爪间夹持的板料工件(微交互)
  boxAt(g, kit.dark, 0.6, 0.07, 0.07, -0.2, 1.33, 0.38); // 拖链
  return g;
}

/** 双臂协作机器人:共享立柱躯干 + 头部 + 左右对称双臂(V 形展开)。 */
export function buildDualArmModel(g: THREE.Group, kit: ModelKit): THREE.Group {
  cylAt(g, kit.dark, 0.2, 0.24, 0.09, 0, 0.045, 0); // 底座
  cylAt(g, kit.body, 0.13, 0.16, 0.58, 0, 0.38, 0); // 躯干立柱
  ballAt(g, kit.bodyDeep, 0.1, 0, 0.76, 0); // 头部
  boxAt(g, kit.screen, 0.07, 0.03, 0.012, 0, 0.77, 0.095); // 头部 visor
  for (const side of [-1, 1]) {
    const shoulder = subgroupAt(g, side * 0.17, 0.6, 0);
    shoulder.rotation.z = side * -0.75; // 向外展开
    capsuleAt(shoulder, kit.body, 0.055, 0.26, 0, 0.17, 0); // 上臂
    tubeAt(shoulder, kit.metal, 0.058, 0.01, 0, 0.06, 0, "y"); // 肩关节环
    const elbow = subgroupAt(shoulder, 0, 0.34, 0);
    elbow.rotation.z = side * 0.95; // 前臂收回
    ballAt(elbow, kit.bodyDeep, 0.06); // 肘关节
    capsuleAt(elbow, kit.body, 0.048, 0.2, 0, 0.13, 0); // 前臂
    const wrist = subgroupAt(elbow, 0, 0.26, 0);
    cylAt(wrist, kit.bodyDeep, 0.035, 0.04, 0.07, 0, 0.03, 0); // 腕
    boxAt(wrist, kit.dark, 0.07, 0.03, 0.05, 0, 0.08, 0); // 夹爪掌
    for (const fx of [-0.022, 0.022]) boxAt(wrist, kit.metal, 0.014, 0.06, 0.025, fx, 0.12, 0); // 夹爪指
  }
  return g;
}

/** 巡检无人机:四旋翼机身 + 桨叶 + 云台相机 + 滑橇起落架。 */
export function buildUavModel(g: THREE.Group, kit: ModelKit): THREE.Group {
  boxAt(g, kit.body, 0.4, 0.13, 0.4, 0, 0.42, 0); // 机身
  boxAt(g, kit.bodyDeep, 0.3, 0.05, 0.3, 0, 0.5, 0); // 顶舱盖
  boxAt(g, kit.screen, 0.1, 0.04, 0.012, 0, 0.42, 0.202); // 尾部状态屏
  boxAt(g, kit.lampRun, 0.03, 0.02, 0.012, 0.18, 0.42, 0.19); // 前航行灯
  for (let i = 0; i < 4; i++) {
    const arm = subgroupAt(g, 0, 0.44, 0);
    arm.rotation.y = Math.PI / 4 + (i * Math.PI) / 2;
    boxAt(arm, kit.metal, 0.3, 0.03, 0.045, 0.22, 0, 0); // 机臂
    cylAt(arm, kit.dark, 0.045, 0.045, 0.06, 0.36, 0.01, 0); // 电机座
    for (const bladeAngle of [0, Math.PI / 2]) {
      const blade = boxAt(arm, kit.rubber, 0.3, 0.006, 0.032, 0.36, 0.06, 0);
      blade.rotation.y = bladeAngle + (i % 2) * 0.4; // 桨叶
    }
  }
  cylAt(g, kit.dark, 0.035, 0.035, 0.05, 0, 0.33, 0); // 云台挂载
  ballAt(g, kit.body, 0.07, 0, 0.27, 0.02); // 云台相机
  cylAt(g, kit.glass, 0.026, 0.026, 0.03, 0, 0.27, 0.08, "z"); // 镜头
  for (const x of [-0.14, 0.14]) {
    boxAt(g, kit.rubber, 0.34, 0.018, 0.03, x, 0.06, 0); // 滑橇
    for (const z of [-0.12, 0.12]) boxAt(g, kit.metal, 0.02, 0.16, 0.02, x, 0.15, z); // 支腿
  }
  return g;
}

/** 液位计(导波雷达式):表头在上 + 安装法兰 + 波导缆垂下 + 重锤。 */
export function buildLevelSensorModel(g: THREE.Group, kit: ModelKit): THREE.Group {
  boxAt(g, kit.body, 0.2, 0.24, 0.12, 0, 0.74, 0); // 表头
  boxAt(g, kit.screen, 0.12, 0.07, 0.012, 0, 0.78, 0.063); // 显示窗
  cylAt(g, kit.dark, 0.02, 0.02, 0.06, 0.09, 0.88, 0); // 接线喉
  grilleAt(g, kit.dark, 0.12, 3, -0.05, 0.65, 0.062, 0.016); // 散热格栅
  cylAt(g, kit.metal, 0.03, 0.03, 0.08, 0, 0.58, 0); // 过渡接管
  flangeAt(g, kit, 0.11, 0, 0.53, 0, "y"); // 安装法兰
  cylAt(g, kit.dark, 0.008, 0.008, 0.4, 0, 0.3, 0); // 波导缆
  cylAt(g, kit.accent, 0.03, 0.018, 0.06, 0, 0.06, 0); // 重锤
  return g;
}

/** 流量计:测量管段 + 两端法兰 + 加粗表体 + 表头与接线。 */
export function buildFlowMeterModel(g: THREE.Group, kit: ModelKit): THREE.Group {
  cylAt(g, kit.dark, 0.09, 0.09, 0.6, 0, 0.3, 0, "x"); // 管段
  flangeAt(g, kit, 0.13, -0.32, 0.3, 0, "x"); // 端法兰
  flangeAt(g, kit, 0.13, 0.32, 0.3, 0, "x");
  cylAt(g, kit.body, 0.15, 0.15, 0.26, 0, 0.3, 0, "x"); // 加粗表体
  boxAt(g, kit.body, 0.18, 0.2, 0.12, 0, 0.56, 0); // 表头
  boxAt(g, kit.screen, 0.11, 0.06, 0.012, 0, 0.59, 0.063); // 显示窗
  cylAt(g, kit.dark, 0.02, 0.02, 0.07, 0, 0.7, 0); // 接线喉
  tubeAt(g, kit.metal, 0.152, 0.012, 0, 0.3, 0, "x"); // 表体端环
  return g;
}

/** 压力变送器:取压管 + 根阀手轮 + 圆饼表体 + 圆形表头。 */
export function buildPressureTransmitterModel(g: THREE.Group, kit: ModelKit): THREE.Group {
  boxAt(g, kit.dark, 0.24, 0.05, 0.16, 0, 0.025, 0); // 底座
  cylAt(g, kit.dark, 0.024, 0.024, 0.3, 0, 0.2, 0); // 取压引管
  boxAt(g, kit.bodyDeep, 0.09, 0.07, 0.07, 0, 0.14, 0.05); // 根阀
  tubeAt(g, kit.metal, 0.042, 0.01, 0, 0.14, 0.1, "y"); // 阀手轮
  cylAt(g, kit.body, 0.09, 0.09, 0.08, 0, 0.4, 0, "z"); // 圆饼表体
  ballAt(g, kit.bodyDeep, 0.11, 0, 0.55, 0, 1, 1.1, 0.72); // 表头壳
  boxAt(g, kit.screen, 0.09, 0.05, 0.012, 0, 0.58, 0.082); // 液晶窗
  cylAt(g, kit.dark, 0.018, 0.018, 0.05, 0.08, 0.66, 0); // 接线喉
  return g;
}

/** 温度变送器:保护套管 + 安装法兰 + 转角接线表头。 */
export function buildTemperatureTransmitterModel(g: THREE.Group, kit: ModelKit): THREE.Group {
  boxAt(g, kit.dark, 0.22, 0.05, 0.14, 0, 0.025, 0); // 底座
  cylAt(g, kit.dark, 0.05, 0.05, 0.08, 0, 0.09, 0); // 连接短管
  cylAt(g, kit.metal, 0.02, 0.02, 0.42, 0, 0.3, 0); // 保护套管
  flangeAt(g, kit, 0.075, 0, 0.52, 0, "y"); // 安装法兰
  boxAt(g, kit.body, 0.16, 0.18, 0.11, 0, 0.62, 0); // 接线表头
  boxAt(g, kit.screen, 0.1, 0.06, 0.012, 0, 0.65, 0.058); // 显示窗
  cylAt(g, kit.dark, 0.018, 0.018, 0.05, 0.07, 0.73, 0); // 出线喉
  return g;
}
