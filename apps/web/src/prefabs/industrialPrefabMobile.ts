import type { IndustrialPrefabDefinition, IndustrialPrefabParameterDefinition } from "@bim-studio/contracts";
import { bool, definition, fixed, number, ROUTE_ACTIONS, select, text } from "./industrialPrefabShared";

/**
 * 移动族定义:人员 / AGV / 园区车辆。
 * 2026-09-12 波次 C 扩量:堆高 AGV、潜伏顶升 AGV、料箱机器人三型物流机器人,
 * 以及半挂牵引车、自卸车、洒水车、曲臂登高车、皮卡巡查车五型作业车辆。
 * 注:牵引车按半挂牵引车头(牵引质量口径)落地,与既有 vehicle.tow-tractor(厂内拖车)语义、几何均不同。
 */
const MOBILE_VARIANTS = [
  ["person.worker", "person", "作业人员", "Worker", "worker", 1.35, 0],
  ["person.guard", "person", "巡检人员", "Inspector", "inspector", 1.25, 0],
  ["person.visitor", "person", "访客", "Visitor", "visitor", 1.15, 0],
  ["person.maintenance", "person", "维修技师", "Maintenance technician", "maintenance", 1.2, 0],
  ["person.operator", "person", "产线操作员", "Line operator", "operator", 1.3, 0],
  ["agv.carrier", "agv", "背负式 AGV", "Carrier AGV", "carrier", 1.5, 1000],
  ["agv.tugger", "agv", "牵引式 AGV", "Tugger AGV", "tugger", 1.8, 1500],
  ["agv.forklift", "agv", "叉车式 AGV", "Forklift AGV", "forklift", 1.2, 1200],
  ["agv.unit-load", "agv", "单元载荷 AGV", "Unit-load AGV", "unit-load", 1.4, 600],
  ["agv.amr", "agv", "自主移动机器人", "Autonomous mobile robot", "amr", 2, 500],
  ["agv.amr-shelf", "agv", "潜伏顶升 AMR", "Shelf-lifting AMR", "shelf-amr", 1.5, 800],
  ["agv.stacker", "agv", "堆高 AGV", "Stacker AGV", "stacker", 1.6, 1200],
  ["agv.latent-jack", "agv", "潜伏顶升 AGV", "Latent-lift AGV", "latent-jack", 1.8, 800],
  ["agv.tote-robot", "agv", "料箱机器人", "Tote-handling robot", "tote-robot", 2.2, 300],
  ["vehicle.car", "vehicle", "园区车辆", "Campus vehicle", "car", 8, 400],
  ["vehicle.truck", "vehicle", "物流货车", "Logistics truck", "truck", 6, 8000],
  ["vehicle.forklift", "vehicle", "人工叉车", "Manned forklift", "forklift", 3, 1800],
  ["vehicle.tow-tractor", "vehicle", "牵引车", "Tow tractor", "tow-tractor", 4, 2500],
  ["vehicle.reach-truck", "vehicle", "前移式叉车", "Reach truck", "reach-truck", 2.5, 1400],
  ["vehicle.tractor-unit", "vehicle", "半挂牵引车", "Semi-trailer tractor", "tractor-unit", 9, 35000],
  ["vehicle.dump-truck", "vehicle", "自卸车", "Dump truck", "dump-truck", 8, 15000],
  ["vehicle.water-truck", "vehicle", "洒水车", "Water sprinkler truck", "water-truck", 8, 12000],
  ["vehicle.boom-lift", "vehicle", "曲臂式登高车", "Articulated boom lift", "boom-lift", 1.2, 230],
  ["vehicle.patrol-pickup", "vehicle", "皮卡巡查车", "Patrol pickup", "patrol-pickup", 11, 500],
  ["agv.uav", "agv", "巡检无人机", "Inspection UAV", "uav", 6, 0],
] as const;

/** 2026-09-12 扩量车型的专属参数(按行业真实口径:鞍座、货厢、罐容、平台高度、货叉行程等)。 */
const MOBILE_EXTRAS: Record<string, IndustrialPrefabParameterDefinition[]> = {
  "tractor-unit": [
    number("gcwKg", "列车总质量", "Gross combination weight", 40000, "kg", 20000, 60000, 500),
    select("fifthWheel", "鞍座规格", "Fifth wheel", "50mm", ["50mm", "90mm"]),
    bool("airSuspension", "空气悬架", "Air suspension", true),
  ],
  "dump-truck": [
    number("bedVolumeM3", "货厢容积", "Bin volume", 18, "m³", 5, 45, 0.5),
    number("liftAngleMaxDeg", "最大举升角", "Max tip angle", 45, "°", 30, 60, 1),
    select("hoist", "举升形式", "Hoist", "front-cylinder", ["front-cylinder", "mid-cylinder", "scissor"]),
  ],
  "water-truck": [
    number("tankVolumeL", "罐体容积", "Tank volume", 12000, "L", 2000, 25000, 100),
    number("sprayWidthM", "洒水宽度", "Spray width", 14, "m", 4, 25, 0.5),
    select("nozzle", "喷洒模式", "Nozzle mode", "rear-spray", ["rear-spray", "front-spray", "water-cannon", "mist"]),
  ],
  "boom-lift": [
    number("platformHeightM", "平台高度", "Platform height", 16, "m", 6, 45, 0.5),
    number("basketLoadKg", "平台载荷", "Basket load", 230, "kg", 80, 450, 5),
    select("rotation", "转台回转", "Slew", "continuous-360", ["continuous-360", "non-continuous"]),
  ],
  "patrol-pickup": [
    bool("lightBar", "警灯", "Light bar", true),
    bool("ptzPod", "车载云台", "Onboard PTZ", true),
    number("cruiseRangeKm", "巡查续航", "Patrol range", 120, "km", 50, 400, 5),
  ],
  stacker: [
    number("liftHeightM", "提升高度", "Lift height", 3, "m", 1, 12, 0.1),
    select("mast", "门架形式", "Mast", "duplex", ["duplex", "triplex"]),
    bool("straddleLegs", "跨腿支撑", "Straddle legs", true),
  ],
  "latent-jack": [
    number("liftStrokeMm", "顶升行程", "Lift stroke", 60, "mm", 30, 150, 5),
    number("plateDiameterMm", "顶升盘直径", "Lift plate", 600, "mm", 400, 900, 10),
    select("payload", "承载形态", "Payload", "pallet", ["pallet", "shelf", "none"]),
  ],
  "tote-robot": [
    number("toteSlots", "载箱层数", "Tote slots", 2, "", 1, 4, 1),
    select("toteSize", "料箱规格", "Tote size", "600x400", ["600x400", "600x500", "custom"]),
    bool("autoUnload", "自动卸箱", "Auto unload", true),
  ],
};

/** 扩量车型的专属数据口(与作业语义一一对应)。 */
const MOBILE_PORTS: Record<string, string[]> = {
  "tractor-unit": ["airPressureKpa"],
  "dump-truck": ["bedAngleDeg"],
  "water-truck": ["tankLevelPercent", "sprayFlowLpm"],
  "boom-lift": ["platformHeightM", "basketLoadKg"],
  "patrol-pickup": ["ptzOnline", "lightBarOn"],
  stacker: ["forkHeightM"],
  "latent-jack": ["liftStrokeMm"],
  "tote-robot": ["toteCount"],
};

export const MOBILE_PREFABS: IndustrialPrefabDefinition[] = MOBILE_VARIANTS.map(
  ([id, kind, name, englishName, subtype, speedMps, loadKg]) =>
    routeDefinition(id, kind, name, englishName, subtype, speedMps, loadKg),
);

function routeDefinition(id: string, kind: "person" | "agv" | "vehicle", name: string, englishName: string, subtype: string, speedMps: number, loadKg: number): IndustrialPrefabDefinition {
  const parameters = [
    fixed("subtype", "类型", "Subtype", subtype),
    number("speedMps", "巡航速度", "Cruise speed", speedMps, "m/s", 0.1, 20, 0.05),
    number("accelerationMps2", "加速度", "Acceleration", kind === "person" ? 0.8 : 0.6, "m/s²", 0.1, 5, 0.05),
    number("stopDistanceM", "安全停车距离", "Stopping distance", kind === "person" ? 0.4 : 0.8, "m", 0.1, 10, 0.1),
    number("avoidanceRadiusM", "避让半径", "Avoidance radius", kind === "person" ? 0.5 : 1, "m", 0.1, 10, 0.1),
    select("routeMode", "路线模式", "Route mode", "loop", ["once", "loop", "ping-pong"]),
    bool("orientToPath", "跟随路线转向", "Orient to path", true),
    bool("obstacleAvoidance", "障碍避让", "Obstacle avoidance", true),
  ];
  if (kind === "person") {
    parameters.push(select("animation", "动作", "Animation", subtype === "maintenance" ? "inspect" : "walk", ["idle", "walk", "run", "inspect"]));
  } else {
    parameters.push(
      // 上限按半挂牵引车列车口径放宽到 45 t,容纳重载车辆默认值
      number("ratedLoadKg", "额定载荷", "Rated load", loadKg, "kg", 0, 45000, 10),
      number("batterySoc", "初始电量", "Initial battery", 100, "%", 0, 100, 1),
      number("lowBatteryThreshold", "低电量阈值", "Low battery threshold", 20, "%", 1, 80, 1),
      text("chargeStationId", "充电站", "Charge station", ""),
    );
    if (subtype === "uav") parameters.push(number("cruiseAltitudeM", "巡航高度", "Cruise altitude", 8, "m", 0.5, 120, 0.5));
    parameters.push(...(MOBILE_EXTRAS[subtype] ?? []));
  }
  const ports = kind === "person"
    ? ["position", "speed", "animation", "status", "routeProgress"]
    : ["position", "speed", "batterySoc", "loadKg", "stationId", "routeProgress", "status", "faultCode",
      ...(subtype === "uav" ? ["altitude"] : []), ...(MOBILE_PORTS[subtype] ?? [])];
  return definition(id, kind, name, englishName, parameters, ROUTE_ACTIONS, ports, { routeCapable: true, description: `${name}的路线、避让、载荷与状态数据配置` });
}
