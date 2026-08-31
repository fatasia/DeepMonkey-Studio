import type { IndustrialPrefabDefinition } from "@bim-studio/contracts";
import { actions, bool, definition, fixed, number, select, text } from "./industrialPrefabShared";

const SENSING_VARIANTS = [
  ["sensor.photoelectric", "sensor", "光电传感器", "Photoelectric sensor", "photoelectric"],
  ["sensor.proximity", "sensor", "接近传感器", "Proximity sensor", "proximity"],
  ["sensor.rfid", "sensor", "RFID 读写器", "RFID reader", "rfid"],
  ["sensor.load-cell", "sensor", "称重传感器", "Load cell", "load-cell"],
  ["sensor.temperature", "sensor", "温湿度传感器", "Temperature sensor", "temperature"],
  ["sensor.safety-lidar", "sensor", "安全激光雷达", "Safety lidar", "safety-lidar"],
  ["camera.fixed", "camera", "固定式工业相机", "Fixed industrial camera", "fixed"],
  ["camera.ptz", "camera", "云台摄像机", "PTZ camera", "ptz"],
  ["camera.vision", "camera", "视觉检测相机", "Machine vision camera", "vision"],
] as const;

export const SENSING_PREFABS: IndustrialPrefabDefinition[] = SENSING_VARIANTS.map(
  ([id, kind, name, englishName, family]) => sensingDefinition(id, kind, name, englishName, family),
);

function sensingDefinition(id: string, kind: "sensor" | "camera", name: string, englishName: string, family: string): IndustrialPrefabDefinition {
  const isCamera = kind === "camera";
  const parameters = [
    fixed("family", "设备类型", "Device family", family),
    number("rangeM", "检测距离", "Detection range", isCamera ? 12 : family === "safety-lidar" ? 8 : 2, "m", 0.05, 100, 0.05),
    number("sampleHz", "采样频率", "Sample rate", isCamera ? 30 : 20, "Hz", 1, 240, 1),
    number("threshold", "触发阈值", "Trigger threshold", 50, "%", 0, 100, 1),
    select("signalMode", "信号模式", "Signal mode", "digital", ["digital", "analog", "network"]),
    bool("enabled", "启用", "Enabled", true),
    bool("alarmEnabled", "报警启用", "Alarm enabled", true),
  ];
  if (isCamera) {
    parameters.push(
      select("resolution", "分辨率", "Resolution", "1920x1080", ["1280x720", "1920x1080", "3840x2160"]),
      number("exposureMs", "曝光时间", "Exposure", 8, "ms", 0.1, 100, 0.1),
      text("recipe", "检测配方", "Inspection recipe", family === "vision" ? "surface-check" : ""),
    );
  }
  const ports = isCamera
    ? ["online", "frameRate", "triggerCount", "passRate", "exposureMs", "status", "faultCode"]
    : ["online", "value", "triggered", "alarm", "sampleHz", "status", "faultCode"];
  return definition(
    id,
    kind,
    name,
    englishName,
    parameters,
    actions([["enable", "启用", "Enable"], ["disable", "停用", "Disable"], ["calibrate", "标定", "Calibrate"], ["reset", "复位", "Reset"]]),
    ports,
    { description: `${name}的量程、采样、阈值、报警和在线状态配置` },
  );
}
