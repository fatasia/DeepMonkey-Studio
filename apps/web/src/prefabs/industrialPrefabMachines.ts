import type { IndustrialPrefabDefinition, IndustrialPrefabParameterDefinition } from "@bim-studio/contracts";
import { actions, bool, definition, fixed, number, select, STATE_ACTIONS, text } from "./industrialPrefabShared";

const MACHINE_VARIANTS = [
  ["cnc-mill", "数控加工中心", "CNC machining center", "milling", 12000, 800],
  ["cnc-lathe", "数控车床", "CNC lathe", "turning", 6000, 500],
  ["laser-welder", "激光焊接工作站", "Laser welding cell", "laser-welding", 0, 80],
  ["press-brake", "数控折弯机", "CNC press brake", "bending", 0, 160],
  ["injection-molder", "注塑机", "Injection molding machine", "injection", 0, 220],
  ["vision-inspection", "机器视觉检测机", "Machine vision inspection", "inspection", 0, 20],
  ["gantry-mill", "龙门加工中心", "Gantry machining center", "gantry", 7500, 75],
  ["surface-grinder", "磨床", "Grinding machine", "grinding", 2880, 30],
  ["press", "冲压机", "Press machine", "pressing", 0, 55],
  ["heat-treat-furnace", "热处理炉", "Heat treatment furnace", "heat-treat", 0, 120],
] as const;

/** 机床专属参数与数据口:通用工艺参数之外的行业语义补充。 */
const MACHINE_EXTRAS: Record<string, { parameters?: IndustrialPrefabParameterDefinition[]; ports?: string[] }> = {
  "gantry-mill": {
    parameters: [
      number("tableLengthM", "工作台长度", "Table length", 4, "m", 1, 16, 0.1),
      number("tableWidthM", "工作台宽度", "Table width", 1.6, "m", 0.5, 6, 0.1),
      number("tableLoadKg", "最大承重", "Table load", 8000, "kg", 100, 50000, 10),
      number("rapidFeedMpm", "快速移动", "Rapid traverse", 24, "m/min", 1, 120, 1),
    ],
    ports: ["axisPosition", "tableLoadKg"],
  },
  "surface-grinder": {
    parameters: [
      number("wheelDiameterMm", "砂轮直径", "Wheel diameter", 355, "mm", 100, 900, 1),
      number("tableSpeedMpm", "台面往复速度", "Table speed", 20, "m/min", 1, 60, 1),
      number("coolantFlowLmin", "冷却流量", "Coolant flow", 40, "L/min", 0, 200, 1),
    ],
    ports: ["wheelWear", "coolantOn"],
  },
  press: {
    parameters: [
      number("tonnage", "公称压力", "Nominal tonnage", 315, "t", 10, 5000, 5),
      number("strokesPerMin", "行程次数", "Strokes per minute", 20, "spm", 1, 120, 1),
      number("strokeMm", "滑块行程", "Stroke", 250, "mm", 5, 1000, 1),
      number("dieHeightMm", "装模高度", "Die height", 380, "mm", 50, 1200, 1),
    ],
    ports: ["strokeCount", "tonnage"],
  },
  "heat-treat-furnace": {
    parameters: [
      number("furnaceTempC", "炉温设定", "Furnace temperature", 920, "°C", 20, 1800, 1),
      number("soakMinutes", "保温时间", "Soak time", 90, "min", 1, 1440, 1),
      number("zoneCount", "控温区数", "Heating zones", 3, "", 1, 12, 1),
      select("atmosphere", "炉内气氛", "Atmosphere", "air", ["air", "nitrogen", "endothermic", "vacuum"]),
    ],
    ports: ["furnaceTempC", "soakRemainingMin"],
  },
};

export const MACHINE_PREFABS: IndustrialPrefabDefinition[] = [
  ...MACHINE_VARIANTS.map(([id, name, englishName, process, spindleRpm, powerKw]) =>
    machineDefinition(id, name, englishName, process, spindleRpm, powerKw),
  ),
  accessGate(),
  interlockDoor(),
  displayWall(),
  modularFence(),
];

function machineDefinition(id: string, name: string, englishName: string, process: string, spindleRpm: number, powerKw: number): IndustrialPrefabDefinition {
  const extras = MACHINE_EXTRAS[id];
  return definition(
    `machine.${id}`,
    "machine",
    name,
    englishName,
    [
      fixed("process", "工艺类型", "Process type", process),
      number("cycleSeconds", "加工节拍", "Cycle time", 45, "s", 1, 7200, 1),
      number("ratedPowerKw", "额定功率", "Rated power", powerKw, "kW", 0.1, 2000, 0.1),
      number("spindleRpm", "主轴转速", "Spindle speed", spindleRpm, "rpm", 0, 30000, 10),
      number("toolLifeMinutes", "刀具寿命", "Tool life", 240, "min", 1, 10000, 1),
      select("recipe", "工艺配方", "Recipe", "standard", ["standard", "prototype", "high-quality", "high-throughput"]),
      bool("autoLoad", "自动上下料", "Automatic loading", true),
      bool("qualityGate", "质量门禁", "Quality gate", true),
      text("workOrder", "工单号", "Work order", ""),
      ...(extras?.parameters ?? []),
    ],
    [...STATE_ACTIONS, ...actions([["change-tool", "换刀", "Change tool"], ["run-cleaning", "执行清洁", "Run cleaning"], ["clear-fault", "清除故障", "Clear fault"]])],
    ["cycleTime", "partCount", "spindleRpm", "powerKw", "toolLife", "qualityPass", "status", "faultCode", ...(extras?.ports ?? [])],
    { description: `${name}的工艺配方、节拍、能耗、质量与维护数据配置` },
  );
}

function accessGate(): IndustrialPrefabDefinition {
  return definition("access.gate", "access-control", "园区道闸", "Campus barrier gate", accessParameters(), actions([["open", "开启", "Open"], ["close", "关闭", "Close"], ["lock", "锁定", "Lock"], ["reset", "复位", "Reset"]]), ["open", "authorized", "vehicleId", "faultCode"]);
}

function interlockDoor(): IndustrialPrefabDefinition {
  return definition("access.interlock-door", "access-control", "安全互锁门", "Safety interlock door", [
    number("widthM", "门宽", "Door width", 1.2, "m", 0.6, 6, 0.1),
    number("unlockDelaySeconds", "解锁延时", "Unlock delay", 1, "s", 0, 60, 0.1),
    select("lockMode", "锁定模式", "Lock mode", "safety", ["safety", "badge", "remote"]),
    bool("safetyInterlock", "安全互锁", "Safety interlock", true),
    bool("evacuationRelease", "紧急逃生释放", "Emergency release", true),
  ], actions([["open", "开启", "Open"], ["close", "关闭", "Close"], ["authorize", "授权", "Authorize"], ["reset", "复位", "Reset"]]), ["doorOpen", "locked", "authorized", "safetyCircuit", "faultCode"]);
}

function displayWall(): IndustrialPrefabDefinition {
  return definition("display.wall", "display", "电视与拼接大屏", "Display and video wall", [
    number("widthM", "屏幕宽度", "Width", 3.2, "m", 0.2, 30, 0.1),
    number("heightM", "屏幕高度", "Height", 1.8, "m", 0.2, 20, 0.1),
    number("columns", "显示列数", "Columns", 2, "", 1, 10, 1),
    number("rows", "显示行数", "Rows", 2, "", 1, 6, 1),
    select("sourceKind", "内容来源", "Source", "dashboard-page", ["dashboard-page", "image", "video", "hls", "webrtc", "url"]),
    text("source", "资源或地址", "Resource or URL", ""),
    number("brightness", "亮度", "Brightness", 1, "", 0, 2, 0.05),
    bool("autoplay", "自动播放", "Autoplay", true),
  ], actions([["play", "播放", "Play"], ["pause", "暂停", "Pause"], ["mute", "静音", "Mute"], ["refresh", "刷新信号", "Refresh source"]]), ["source", "playing", "online", "brightness", "faultCode"]);
}

function modularFence(): IndustrialPrefabDefinition {
  return definition("fence.modular", "fence", "参数化围栏", "Parametric fence", [
    number("heightM", "高度", "Height", 1.8, "m", 0.5, 8, 0.1),
    number("postSpacingM", "立柱间距", "Post spacing", 2, "m", 0.2, 10, 0.1),
    number("gateWidthM", "门宽", "Gate width", 1.2, "m", 0, 12, 0.1),
    select("panel", "围栏类型", "Panel", "mesh", ["mesh", "solid", "glass", "electronic"]),
    bool("intrusionDetection", "入侵检测", "Intrusion detection", false),
  ], actions([["open-gate", "打开门", "Open gate"], ["close-gate", "关闭门", "Close gate"]]), ["gateOpen", "intrusion", "faultCode"]);
}

function accessParameters() {
  return [
    number("widthM", "通道宽度", "Passage width", 3.5, "m", 0.8, 12, 0.1),
    number("openSeconds", "开启动作", "Opening duration", 2.5, "s", 0.2, 30, 0.1),
    number("autoCloseSeconds", "自动关闭延时", "Auto-close delay", 5, "s", 0, 120, 0.5),
    number("sensorRangeM", "检测距离", "Sensor range", 4, "m", 0.5, 30, 0.1),
    bool("authorizationRequired", "需要授权", "Authorization required", true),
    bool("antiCrush", "防砸保护", "Anti-crush", true),
  ];
}
