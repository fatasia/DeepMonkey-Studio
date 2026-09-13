import type { IndustrialPrefabDefinition, IndustrialPrefabParameterDefinition } from "@bim-studio/contracts";
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
  ["heat-exchanger.shell", "utility", "管壳式换热器", "Shell-and-tube heat exchanger", "heat-exchanger", 120, 0],
  ["tank.vertical", "utility", "立式储罐", "Vertical storage tank", "tank", 50, 0],
  ["softener.duplex", "utility", "双柱软水器", "Duplex water softener", "softener", 8, 1.5],
  ["dosing-station.skid", "utility", "成套加药装置", "Chemical dosing station", "dosing-station", 500, 2.2],
] as const;

/** 额定能力的单位随设备族变化:换热面积 m²、罐容 m³、产水 m³/h、药桶 L。 */
const CAPACITY_UNITS: Record<string, string> = {
  fan: "m³/h",
  valve: "%",
  "heat-exchanger": "m²",
  tank: "m³",
  softener: "m³/h",
  "dosing-station": "L",
};

/** 设备族专属参数、行业动作与数据口。 */
const UTILITY_EXTRAS: Record<string, { parameters?: IndustrialPrefabParameterDefinition[]; actions?: ReadonlyArray<readonly [string, string, string]>; ports?: string[] }> = {
  "heat-exchanger": {
    parameters: [
      number("designTempC", "设计温度", "Design temperature", 150, "°C", 0, 400, 1),
      select("flowArrangement", "流动方式", "Flow arrangement", "counter-current", ["counter-current", "co-current"]),
    ],
    ports: ["inletTempC", "outletTempC"],
  },
  tank: {
    parameters: [
      number("diameterM", "罐径", "Diameter", 3.5, "m", 1, 30, 0.1),
      select("medium", "储存介质", "Stored medium", "water", ["water", "oil", "chemical", "fuel"]),
    ],
    actions: [["drain", "排空", "Drain"], ["refill", "进液", "Refill"]],
    ports: ["level"],
  },
  softener: {
    parameters: [
      number("regenCycleHours", "再生周期", "Regeneration cycle", 24, "h", 4, 168, 1),
      select("resin", "树脂型号", "Resin type", "001×7", ["001×7", "C100E", "C249"]),
    ],
    actions: [["regenerate", "再生", "Regenerate"], ["backwash", "反洗", "Backwash"]],
    ports: ["hardness", "regenerationCount"],
  },
  "dosing-station": {
    parameters: [
      number("doseRateLh", "加药量", "Dosing rate", 20, "L/h", 0.1, 500, 0.1),
      select("chemical", "药剂类型", "Chemical", "pac", ["pac", "pam", "naocl", "ph-adjuster"]),
    ],
    actions: [["prime", "灌泵", "Prime"], ["flush", "管路冲洗", "Flush line"]],
    ports: ["doseRate", "tankLevel"],
  },
};

export const UTILITY_PREFABS: IndustrialPrefabDefinition[] = UTILITY_VARIANTS.map(
  ([id, kind, name, englishName, family, capacity, powerKw]) =>
    utilityDefinition(id, kind, name, englishName, family, capacity, powerKw),
);

function utilityDefinition(id: string, kind: "utility" | "electrical", name: string, englishName: string, family: string, capacity: number, powerKw: number): IndustrialPrefabDefinition {
  const capacityUnit = CAPACITY_UNITS[family] ?? "m³/h";
  const extras = UTILITY_EXTRAS[family];
  const parameters = [
    fixed("family", "设备族", "Equipment family", family),
    number("ratedCapacity", "额定能力", "Rated capacity", capacity, capacityUnit, 0, 100000, 0.1),
    number("ratedPowerKw", "额定功率", "Rated power", powerKw, "kW", 0, 1000, 0.1),
    number("setpoint", "设定值", "Setpoint", family === "valve" ? 50 : capacity * 0.7, family === "valve" ? "%" : capacityUnit, 0, 100000, 0.1),
    number("alarmHigh", "高报警阈值", "High alarm", 90, "%", 1, 100, 1),
    number("alarmLow", "低报警阈值", "Low alarm", 10, "%", 0, 99, 1),
    select("controlMode", "控制模式", "Control mode", "auto", ["manual", "auto", "remote"]),
    bool("interlockEnabled", "联锁使能", "Interlock enabled", true),
    ...(extras?.parameters ?? []),
  ];
  const actionsForFamily = family === "valve"
    ? [["open", "打开", "Open"], ["close", "关闭", "Close"], ["set-position", "设定开度", "Set position"]] as const
    : family === "meter"
      ? [["refresh", "刷新读数", "Refresh reading"], ["reset-energy", "清零电能", "Reset energy"]] as const
      : extras?.actions ?? [["start", "启动", "Start"], ["stop", "停止", "Stop"], ["set-setpoint", "设定目标", "Set setpoint"]] as const;
  return definition(
    `utility.${id}`,
    kind,
    name,
    englishName,
    parameters,
    [...STATE_ACTIONS, ...actions(actionsForFamily)],
    ["running", "setpoint", "actualValue", "pressure", "flow", "powerKw", "energyKwh", "status", "faultCode", ...(extras?.ports ?? [])],
    { description: `${name}的设定值、联锁、能耗、流量/压力与报警数据配置` },
  );
}
