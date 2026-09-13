import type { IndustrialPrefabDefinition, IndustrialPrefabParameterDefinition } from "@bim-studio/contracts";
import { actions, bool, definition, fixed, number, select } from "./industrialPrefabShared";

/**
 * 感知族定义(仅点式传感器;摄像机族拆分至 industrialPrefabCamera.ts)。
 * 2026-09-12 波次 C 扩量:感烟/感温/声光报警/振动监测四型探测器 + RTU/边缘网关两类采集网联设备。
 * 探测器与 RTU/网关的参数、动作、数据口语义差异较大,分别走 detectorDefinition 与 gatewayDefinition。
 */
const SENSOR_VARIANTS = [
  ["sensor.photoelectric", "光电传感器", "Photoelectric sensor", "photoelectric"],
  ["sensor.proximity", "接近传感器", "Proximity sensor", "proximity"],
  ["sensor.rfid", "RFID 读写器", "RFID reader", "rfid"],
  ["sensor.load-cell", "称重传感器", "Load cell", "load-cell"],
  ["sensor.temperature", "温湿度传感器", "Temperature sensor", "temperature"],
  ["sensor.safety-lidar", "安全激光雷达", "Safety lidar", "safety-lidar"],
  ["sensor.level", "液位计", "Level transmitter", "level"],
  ["sensor.flow", "流量计", "Flow meter", "flow"],
  ["sensor.pressure-transmitter", "压力变送器", "Pressure transmitter", "pressure-transmitter"],
  ["sensor.temperature-transmitter", "温度变送器", "Temperature transmitter", "temperature-transmitter"],
  ["sensor.smoke-detector", "感烟探测器", "Smoke detector", "smoke-detector"],
  ["sensor.heat-detector", "感温探测器", "Heat detector", "heat-detector"],
  ["sensor.sounder-strobe", "声光报警器", "Sounder strobe", "sounder-strobe"],
  ["sensor.vibration", "振动监测传感器", "Vibration monitor", "vibration"],
] as const;

const GATEWAY_VARIANTS = [
  ["sensor.rtu", "远程终端单元", "Remote terminal unit", "rtu"],
  ["sensor.edge-gateway", "边缘计算网关", "Edge computing gateway", "edge-gateway"],
] as const;

/** 检测距离(量程)按设备族取行业典型默认值;接触式振动传感器按贴装取最小值。 */
const FAMILY_RANGE_M: Record<string, number> = {
  level: 10,
  "pressure-transmitter": 0.5,
  "temperature-transmitter": 0.5,
  "smoke-detector": 12,
  "heat-detector": 6,
  "sounder-strobe": 25,
  vibration: 0.05,
};

/** 点式传感器族专属参数与数据口。 */
const SENSING_EXTRAS: Record<string, { parameters?: IndustrialPrefabParameterDefinition[]; ports?: string[] }> = {
  level: {
    parameters: [
      number("spanM", "量程", "Span", 5, "m", 0.1, 60, 0.1),
      select("medium", "介质", "Medium", "water", ["water", "oil", "acid", "slurry"]),
    ],
    ports: ["level"],
  },
  flow: {
    parameters: [
      select("principle", "测量原理", "Principle", "electromagnetic", ["electromagnetic", "ultrasonic", "vortex", "turbine", "coriolis"]),
      number("diameterDn", "口径", "Nominal diameter", 50, "DN", 10, 600, 5),
    ],
    ports: ["flowRate", "totalFlow"],
  },
  "pressure-transmitter": {
    parameters: [
      number("spanKpa", "量程", "Span", 100, "kPa", 1, 60000, 1),
      select("output", "输出信号", "Output", "4-20mA", ["4-20mA", "0-10V", "HART", "fieldbus"]),
    ],
    ports: ["pressureKpa"],
  },
  "temperature-transmitter": {
    parameters: [
      number("spanC", "量程", "Span", 200, "°C", -50, 1800, 1),
      select("probe", "探头类型", "Probe", "pt100", ["pt100", "pt1000", "thermocouple-k", "thermocouple-s"]),
    ],
    ports: ["temperatureC"],
  },
  // 火灾自动报警口径(GB 4715/GB 4716):遮光率阈值、灵敏度等级、定温/差温动作参数。
  "smoke-detector": {
    parameters: [
      number("alarmThresholdObsM", "报警阈值", "Alarm threshold", 10, "%obs/m", 2, 30, 1),
      select("sensitivity", "灵敏度等级", "Sensitivity", "class-2", ["class-1", "class-2", "class-3"]),
    ],
    ports: ["smokeDensity"],
  },
  "heat-detector": {
    parameters: [
      number("fixedTempC", "定温动作温度", "Fixed temperature", 57, "°C", 40, 140, 1),
      number("rateRiseCPerMin", "差温速率", "Rate-of-rise", 8, "°C/min", 1, 30, 1),
    ],
    ports: ["temperatureC", "rateOfRiseCpm"],
  },
  "sounder-strobe": {
    parameters: [
      number("soundPressureDb", "声压级", "Sound pressure", 105, "dB", 70, 120, 1),
      select("tone", "报警音调", "Tone", "evac", ["evac", "alarm-bell", "siren", "whoop"]),
      select("flashPattern", "闪光模式", "Flash pattern", "strobe-flash", ["strobe-1hz", "strobe-flash", "steady"]),
    ],
    ports: ["soundLevelDb", "active"],
  },
  // 机器状态监测口径(ISO 20816):速度量程、测振轴向、评价标准区带。
  vibration: {
    parameters: [
      number("velocityRangeMms", "速度量程", "Velocity range", 50, "mm/s", 10, 200, 5),
      select("axis", "测量轴向", "Axis", "triaxial", ["x", "y", "z", "triaxial"]),
      select("standard", "评价标准", "Standard", "iso-20816", ["iso-10816", "iso-20816", "gb-t-6075"]),
    ],
    ports: ["velocityMms", "accelerationG", "bearingTempC"],
  },
};

/** 声光报警器的行业动作是消音/自检,而非标定。 */
function sensorActions(family: string): IndustrialPrefabDefinition["actions"] {
  if (family === "sounder-strobe") {
    return actions([["enable", "启用", "Enable"], ["disable", "停用", "Disable"], ["mute", "消音", "Mute"], ["self-test", "自检", "Self test"], ["reset", "复位", "Reset"]]);
  }
  return actions([["enable", "启用", "Enable"], ["disable", "停用", "Disable"], ["calibrate", "标定", "Calibrate"], ["reset", "复位", "Reset"]]);
}

export const SENSING_PREFABS: IndustrialPrefabDefinition[] = [
  ...SENSOR_VARIANTS.map(([id, name, englishName, family]) => detectorDefinition(id, name, englishName, family)),
  ...GATEWAY_VARIANTS.map(([id, name, englishName, family]) => gatewayDefinition(id, name, englishName, family)),
];

function detectorDefinition(id: string, name: string, englishName: string, family: string): IndustrialPrefabDefinition {
  const extras = SENSING_EXTRAS[family];
  const parameters = [
    fixed("family", "设备类型", "Device family", family),
    number("rangeM", "检测距离", "Detection range", FAMILY_RANGE_M[family] ?? (family === "safety-lidar" ? 8 : 2), "m", 0.05, 100, 0.05),
    number("sampleHz", "采样频率", "Sample rate", 20, "Hz", 1, 240, 1),
    number("threshold", "触发阈值", "Trigger threshold", 50, "%", 0, 100, 1),
    select("signalMode", "信号模式", "Signal mode", "digital", ["digital", "analog", "network"]),
    bool("enabled", "启用", "Enabled", true),
    bool("alarmEnabled", "报警启用", "Alarm enabled", true),
    ...(extras?.parameters ?? []),
  ];
  const ports = ["online", "value", "triggered", "alarm", "sampleHz", "status", "faultCode", ...(extras?.ports ?? [])];
  return definition(
    id,
    "sensor",
    name,
    englishName,
    parameters,
    sensorActions(family),
    ports,
    { description: `${name}的量程、采样、阈值、报警和在线状态配置` },
  );
}

/** RTU/边缘网关:采集与网联设备,参数与数据口按数据采集行业口径(DI/DO 通道、扫描周期、南向/北向协议)。 */
function gatewayDefinition(id: string, name: string, englishName: string, family: string): IndustrialPrefabDefinition {
  const isRtu = family === "rtu";
  const parameters: IndustrialPrefabParameterDefinition[] = [
    fixed("family", "设备类型", "Device family", family),
    ...(isRtu
      ? [
          number("diCount", "DI 通道数", "DI channels", 16, "", 0, 128, 1),
          number("doCount", "DO 通道数", "DO channels", 8, "", 0, 64, 1),
          number("aiCount", "AI 通道数", "AI channels", 8, "", 0, 64, 1),
          number("aoCount", "AO 通道数", "AO channels", 2, "", 0, 16, 1),
          number("scanIntervalMs", "扫描周期", "Scan interval", 500, "ms", 10, 60000, 10),
          select("protocol", "通信协议", "Protocol", "modbus-rtu", ["modbus-rtu", "modbus-tcp", "dnp3", "iec-104"]),
          select("redundancy", "冗余方式", "Redundancy", "none", ["none", "dual-power", "cold-standby"]),
          bool("watchdog", "看门狗", "Watchdog", true),
        ]
      : [
          select("southbound", "南向协议", "Southbound", "opc-ua", ["opc-ua", "modbus-tcp", "s7", "ethernet-ip", "mqtt"]),
          select("uplink", "北向上行", "Uplink", "mqtt", ["mqtt", "http", "grpc"]),
          number("coreCount", "CPU 核数", "CPU cores", 4, "", 1, 16, 1),
          number("npuTops", "AI 算力", "NPU compute", 10, "TOPS", 0, 100, 1),
          number("edgeApps", "边缘应用数", "Edge apps", 3, "", 0, 20, 1),
          number("bufferHours", "断网缓存", "Store & forward", 24, "h", 1, 168, 1),
          bool("tlsEnabled", "TLS 加密", "TLS", true),
        ]),
    bool("enabled", "启用", "Enabled", true),
  ];
  const gatewayActions = isRtu
    ? actions([["enable", "启用", "Enable"], ["disable", "停用", "Disable"], ["force-output", "强制输出", "Force output"], ["sync-time", "站内对时", "Sync time"], ["reset", "复位", "Reset"]])
    : actions([["enable", "启用", "Enable"], ["disable", "停用", "Disable"], ["deploy-app", "下发应用", "Deploy app"], ["restart-container", "重启容器", "Restart container"], ["clear-buffer", "清空缓存", "Clear buffer"], ["reset", "复位", "Reset"]]);
  const ports = isRtu
    ? ["online", "diStates", "doStates", "aiValues", "aoValues", "commLatencyMs", "uptime", "status", "faultCode"]
    : ["online", "ingressRate", "egressRate", "edgeTasksActive", "bufferDepth", "cpuLoad", "commLatencyMs", "status", "faultCode"];
  return definition(
    id,
    "sensor",
    name,
    englishName,
    parameters,
    gatewayActions,
    ports,
    { description: isRtu ? `${name}的点表通道、扫描周期、协议冗余与遥测遥控配置` : `${name}的南向北向协议、算力、边缘应用与断网续传配置` },
  );
}
