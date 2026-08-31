import type { IndustrialPrefabDefinition } from "@bim-studio/contracts";
import { actions, bool, definition, fixed, number, select, text } from "./industrialPrefabShared";

const ROBOT_ACTIONS = actions([
  ["home", "回零", "Home"],
  ["start-program", "运行程序", "Run program"],
  ["pause", "暂停", "Pause"],
  ["stop", "停止", "Stop"],
  ["jog", "关节点动", "Jog joint"],
  ["move-tool", "移动工具中心", "Move tool center"],
  ["clear-fault", "清除故障", "Clear fault"],
]);

const ROBOT_VARIANTS = [
  ["cartesian-3", "三轴直角坐标机器人", "3-axis Cartesian robot", "cartesian", 3, 20, 1.2, "搬运"],
  ["delta-3", "三轴 Delta 机器人", "3-axis Delta robot", "delta", 3, 3, 0.65, "分拣"],
  ["delta-4", "四轴 Delta 机器人", "4-axis Delta robot", "delta", 4, 5, 0.8, "包装"],
  ["scara-4", "四轴 SCARA 机器人", "4-axis SCARA robot", "scara", 4, 10, 0.8, "装配"],
  ["palletizer-4", "四轴码垛机器人", "4-axis palletizing robot", "palletizer", 4, 120, 2.4, "码垛"],
  ["articulated-6", "六轴关节机器人", "6-axis articulated robot", "articulated", 6, 20, 1.8, "搬运"],
  ["cobot-6", "六轴协作机器人", "6-axis collaborative robot", "collaborative", 6, 10, 1.3, "协作装配"],
  ["cobot-7", "七轴冗余协作机器人", "7-axis redundant cobot", "collaborative", 7, 8, 1.1, "柔性装配"],
  ["handling-6-heavy", "六轴重载搬运机器人", "Heavy-payload handling robot", "articulated", 6, 180, 3.2, "重载搬运"],
  ["welding-6", "六轴弧焊机器人", "6-axis arc welding robot", "articulated", 6, 12, 2, "弧焊"],
  ["spot-welding-6", "六轴点焊机器人", "6-axis spot welding robot", "articulated", 6, 80, 2.6, "点焊"],
  ["palletizer-4-heavy", "四轴高速码垛机器人", "High-speed palletizer", "palletizer", 4, 180, 3.1, "高速码垛"],
  ["scara-4-fast", "四轴高速装配 SCARA", "High-speed assembly SCARA", "scara", 4, 6, 0.55, "高速装配"],
] as const;

export const ROBOT_PREFABS: IndustrialPrefabDefinition[] = ROBOT_VARIANTS.map(
  ([id, name, englishName, family, axisCount, payloadKg, reachM, application]) =>
    robotDefinition(id, name, englishName, family, axisCount, payloadKg, reachM, application),
);

function robotDefinition(id: string, name: string, englishName: string, family: string, axisCount: number, payloadKg: number, reachM: number, application: string): IndustrialPrefabDefinition {
  return definition(
    `robot.${id}`,
    "robot-arm",
    name,
    englishName,
    [
      fixed("family", "结构类型", "Robot family", family),
      fixed("application", "典型工艺", "Primary application", application),
      fixed("axisCount", "轴数", "Axis count", axisCount),
      number("payloadKg", "额定负载", "Payload", payloadKg, "kg", 0.1, 1000, 0.1),
      number("reachM", "最大臂展", "Reach", reachM, "m", 0.1, 10, 0.01),
      number("jointSpeedPercent", "关节速度", "Joint speed", 60, "%", 1, 100, 1),
      number("accelerationPercent", "加速度", "Acceleration", 45, "%", 1, 100, 1),
      number("safetySpeedPercent", "安全速度", "Safety speed", 20, "%", 1, 100, 1),
      number("precisionMm", "重复定位精度", "Repeatability", 0.1, "mm", 0.01, 10, 0.01),
      select("toolType", "末端工具", "End effector", toolFor(application), ["gripper", "vacuum", "welder", "spot-gun", "camera", "custom"]),
      text("program", "运行程序", "Program", programFor(application)),
      bool("collisionCheck", "碰撞检查", "Collision check", true),
      bool("safetyZone", "安全区域", "Safety zone", true),
    ],
    ROBOT_ACTIONS,
    ["jointAngles", "jointTorque", "toolPosition", "toolLoad", "program", "cycleTime", "status", "faultCode"],
    { rigCapable: true, description: `${axisCount} 轴${application}工艺、工具中心点、关节限位与碰撞验证` },
  );
}

function toolFor(application: string): string {
  if (application.includes("焊")) return application === "点焊" ? "spot-gun" : "welder";
  if (application.includes("码垛")) return "vacuum";
  return "gripper";
}

function programFor(application: string): string {
  return application.includes("焊") ? "weld_main" : application.includes("码垛") ? "pallet_main" : "main";
}
