import type { IndustrialPrefabDefinition } from "@bim-studio/contracts";
import { actions, bool, definition, fixed, number, select, STATE_ACTIONS } from "./industrialPrefabShared";

const UTILITY_VARIANTS = [
  ["pump.centrifugal", "utility", "离心泵", "Centrifugal pump", "pump", 60, 15],
  ["pump.dosing", "utility", "计量泵", "Dosing pump", "pump", 8, 2.2],
  ["valve.gate", "utility", "闸阀", "Gate valve", "valve", 40, 0],
  ["valve.control", "utility", "调节阀", "Control valve", "valve", 25, 0],
  ["fan.axial", "utility", "轴流风机", "Axial fan", "fan", 18000, 7.5],
  ["fan.exhaust", "utility", "排风机", "Exhaust fan", "fan", 12000, 11],
  ["compressor.air", "utility", "空压机", "Air compressor", "compressor", 35, 45],
  ["cabinet.mcc", "electrical", "电机控制柜", "Motor control cabinet", "cabinet", 0, 20],
  ["cabinet.plc", "electrical", "PLC 控制柜", "PLC control cabinet", "cabinet", 0, 2],
  ["drive.vfd", "electrical", "变频驱动柜", "Variable frequency drive", "drive", 0, 15],
  ["meter.power", "electrical", "智能电表", "Power meter", "meter", 0, 0],
] as const;

export const UTILITY_PREFABS: IndustrialPrefabDefinition[] = UTILITY_VARIANTS.map(
  ([id, kind, name, englishName, family, capacity, powerKw]) =>
    utilityDefinition(id, kind, name, englishName, family, capacity, powerKw),
);

function utilityDefinition(id: string, kind: "utility" | "electrical", name: string, englishName: string, family: string, capacity: number, powerKw: number): IndustrialPrefabDefinition {
  const parameters = [
    fixed("family", "设备族", "Equipment family", family),
    number("ratedCapacity", "额定能力", "Rated capacity", capacity, family === "fan" ? "m³/h" : family === "valve" ? "%" : "m³/h", 0, 100000, 0.1),
    number("ratedPowerKw", "额定功率", "Rated power", powerKw, "kW", 0, 1000, 0.1),
    number("setpoint", "设定值", "Setpoint", family === "valve" ? 50 : capacity * 0.7, family === "valve" ? "%" : "m³/h", 0, 100000, 0.1),
    number("alarmHigh", "高报警阈值", "High alarm", 90, "%", 1, 100, 1),
    number("alarmLow", "低报警阈值", "Low alarm", 10, "%", 0, 99, 1),
    select("controlMode", "控制模式", "Control mode", "auto", ["manual", "auto", "remote"]),
    bool("interlockEnabled", "联锁使能", "Interlock enabled", true),
  ];
  const actionsForFamily = family === "valve"
    ? [["open", "打开", "Open"], ["close", "关闭", "Close"], ["set-position", "设定开度", "Set position"]] as const
    : family === "meter"
      ? [["refresh", "刷新读数", "Refresh reading"], ["reset-energy", "清零电能", "Reset energy"]] as const
      : [["start", "启动", "Start"], ["stop", "停止", "Stop"], ["set-setpoint", "设定目标", "Set setpoint"]] as const;
  return definition(
    `utility.${id}`,
    kind,
    name,
    englishName,
    parameters,
    [...STATE_ACTIONS, ...actions(actionsForFamily)],
    ["running", "setpoint", "actualValue", "pressure", "flow", "powerKw", "energyKwh", "status", "faultCode"],
    { description: `${name}的设定值、联锁、能耗、流量/压力与报警数据配置` },
  );
}
