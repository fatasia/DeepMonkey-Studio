import type { IndustrialPrefabDefinition, IndustrialPrefabParameterDefinition } from "@bim-studio/contracts";
import { actions, bool, definition, fixed, number, select, text } from "./industrialPrefabShared";

/**
 * 摄像机族定义(自 industrialPrefabSensing.ts 拆出,统一维护)。
 * 2026-09-12 波次 C 扩量:枪型/半球/热成像三型网络摄像机 + AI 视频分析盒。
 * 参数与数据口按视频监控行业口径(红外距离、热灵敏度 NETD、接入通道、NPU 算力)。
 */
const CAMERA_VARIANTS = [
  ["camera.fixed", "固定式工业相机", "Fixed industrial camera", "fixed"],
  ["camera.ptz", "云台摄像机", "PTZ camera", "ptz"],
  ["camera.vision", "视觉检测相机", "Machine vision camera", "vision"],
  ["camera.bullet", "枪型网络摄像机", "Bullet network camera", "bullet"],
  ["camera.dome", "半球型网络摄像机", "Dome network camera", "dome"],
  ["camera.thermal", "热成像摄像机", "Thermal imaging camera", "thermal"],
  ["camera.ai-box", "AI 视频分析盒", "AI video analytics box", "ai-box"],
] as const;

/** 各机型专属参数与数据口。 */
const CAMERA_EXTRAS: Record<string, { parameters?: IndustrialPrefabParameterDefinition[]; ports?: string[] }> = {
  ptz: {
    parameters: [
      number("presetCount", "预置位数", "Presets", 8, "", 0, 255, 1),
      number("speedDegS", "云台转速", "Pan speed", 60, "°/s", 10, 200, 5),
      bool("autoTour", "自动巡航", "Auto tour", true),
    ],
    ports: ["panDeg", "tiltDeg"],
  },
  bullet: {
    parameters: [
      number("irDistanceM", "红外距离", "IR distance", 50, "m", 10, 300, 5),
      number("lensMm", "镜头焦距", "Focal length", 6, "mm", 2.8, 50, 0.1),
      number("wdrDb", "宽动态", "WDR", 120, "dB", 60, 140, 1),
    ],
    ports: ["irOn"],
  },
  dome: {
    parameters: [
      number("fovDeg", "水平视场角", "FOV", 180, "°", 90, 360, 1),
      bool("ceilingMount", "吸顶安装", "Ceiling mount", true),
      bool("audioPickup", "拾音", "Audio pickup", false),
    ],
    ports: ["audioLevel"],
  },
  // 热成像口径:探测器规格、NETD 热灵敏度、测温范围与伪彩。
  thermal: {
    parameters: [
      select("detector", "探测器", "Detector", "vox-640x512", ["vox-384x288", "vox-640x512", "cooled-mwir"]),
      number("netdMk", "热灵敏度", "NETD", 40, "mK", 20, 80, 1),
      select("tempSpan", "测温范围", "Temp span", "-20~150", ["-20~150", "0~550", "200~2000"]),
      select("palette", "伪彩", "Palette", "ironbow", ["white-hot", "ironbow", "rainbow"]),
    ],
    ports: ["temperatureMaxC", "temperatureMinC"],
  },
  // AI 分析盒口径:接入通道、NPU 算力、加载的分析模型与解码能力。
  "ai-box": {
    parameters: [
      number("channelCount", "接入通道", "Channels", 16, "", 1, 64, 1),
      number("npuTops", "AI 算力", "NPU compute", 16, "TOPS", 0, 100, 1),
      select("workload", "分析模型", "Analytics model", "mixed", ["helmet-detect", "vehicle-count", "perimeter", "mixed"]),
      select("decode", "解码能力", "Decode", "16ch-1080p", ["8ch-4k", "16ch-1080p", "32ch-1080p"]),
    ],
    ports: ["channelsOnline", "eventRate", "npuLoad"],
  },
};

export const CAMERA_PREFABS: IndustrialPrefabDefinition[] = CAMERA_VARIANTS.map(
  ([id, name, englishName, family]) => cameraDefinition(id, name, englishName, family),
);

function cameraDefinition(id: string, name: string, englishName: string, family: string): IndustrialPrefabDefinition {
  const extras = CAMERA_EXTRAS[family];
  const parameters: IndustrialPrefabParameterDefinition[] = [
    fixed("family", "设备类型", "Device family", family),
    number("rangeM", "检测距离", "Detection range", 12, "m", 0.05, 100, 0.05),
    number("sampleHz", "采样频率", "Sample rate", 30, "Hz", 1, 240, 1),
    number("threshold", "触发阈值", "Trigger threshold", 50, "%", 0, 100, 1),
    select("signalMode", "信号模式", "Signal mode", "network", ["digital", "analog", "network"]),
    bool("enabled", "启用", "Enabled", true),
    bool("alarmEnabled", "报警启用", "Alarm enabled", true),
    select("resolution", "分辨率", "Resolution", "1920x1080", ["1280x720", "1920x1080", "3840x2160"]),
    number("exposureMs", "曝光时间", "Exposure", 8, "ms", 0.1, 100, 0.1),
    text("recipe", "检测配方", "Inspection recipe", family === "vision" ? "surface-check" : ""),
    ...(extras?.parameters ?? []),
  ];
  const ports = ["online", "frameRate", "triggerCount", "passRate", "exposureMs", "status", "faultCode", ...(extras?.ports ?? [])];
  return definition(
    id,
    "camera",
    name,
    englishName,
    parameters,
    actions([["enable", "启用", "Enable"], ["disable", "停用", "Disable"], ["calibrate", "标定", "Calibrate"], ["reset", "复位", "Reset"]]),
    ports,
    { description: `${name}的分辨率、曝光、触发阈值、报警和在线状态配置` },
  );
}
