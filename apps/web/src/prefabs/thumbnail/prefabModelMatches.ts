import type { IndustrialPrefabKind } from "@bim-studio/contracts";

/**
 * 预制体 → 真实模型匹配表(source-a 内部库 + source-b CC0/CC-BY 社区库)。
 *
 * 语义:缩略图渲染器对命中条目的预制体优先加载真实 GLB 出图,
 * 未命中的预制体继续走既有程序化构建器(见 prefabThumbnailModels)。
 *
 * 匹配纪律(诚实原则):
 * - 每一条都经过真实渲染缩略图肉眼审查,形态与预制体语义一致才收录;
 * - 形态或语义对不上的宁缺毋滥(如"计量泵"没有真实泵模型就保持缺失),
 *   未命中的预制体由程序化小样兜底,永不白块;
 * - assetId 两种来源:
 *   · `industrial-{id}` = source-a 资产库条目(内部素材,license "内部使用");
 *   · `community-{uid}` = source-b 资产库条目(Sketchfab CC0-1.0/CC-BY-4.0,
 *     catalog/audit 带完整 author/license/originUrl/attribution 署名)。
 *   两者模型 GLB 都由 `/api/asset-library/items/{assetId}/preview` 提供,
 *   与资源页模型预览同一来源(dev 下 /api 代理到 4100)。
 * - 匹配表只引用 data/external-assets,不移动、不改写任何文件;
 *   prefabModelMatches.test.ts 会在 CI 里逐条核对 id/name 与 catalog/audit 一致。
 */

export interface PrefabModelMatch {
  /** 资产库条目 id:source-a 为 "industrial-576",source-b 为 "community-{32位uid}"。 */
  assetId: string;
  /** 模型名(source-a 与 catalog.json name 一致;source-b 与 audit.json displayName 一致)。 */
  name: string;
  /** 预制体 kind,仅供阅读;渲染行为由预制体定义决定,不影响取值。 */
  kind?: IndustrialPrefabKind;
}

/** 匹配表:键为 IndustrialPrefabDefinition.id。 */
export const PREFAB_MODEL_MATCHES: Readonly<Record<string, PrefabModelMatch>> = {
  // ── 机器人族(7):机械臂 5 型各归各,码垛形态用立柱悬臂 ──────────────────
  "robot.articulated-6": { assetId: "industrial-576", name: "机械臂" },
  "robot.cobot-6": { assetId: "industrial-1151", name: "工厂设备-机械臂.001" },
  "robot.handling-6-heavy": { assetId: "industrial-1136", name: "工厂机械臂" },
  "robot.welding-6": { assetId: "industrial-577", name: "机械臂_001" },
  "robot.spot-welding-6": { assetId: "industrial-579", name: "机械臂_003" },
  "robot.palletizer-6": { assetId: "industrial-578", name: "机械臂_002" },
  "robot.palletizer-4": { assetId: "industrial-1199", name: "机械臂.001" },

  // ── 输送族(7):直线/宽幅/爬坡/90°/180°/合流/链式 ──────────────────────
  "conveyor.straight": { assetId: "industrial-998", name: "电动传送带-直" },
  "conveyor.belt-wide": { assetId: "industrial-1344", name: "传送带" },
  "conveyor.belt-incline": { assetId: "industrial-1349", name: "传送带_001" },
  "conveyor.curve-90": { assetId: "industrial-253", name: "90度传送带" },
  "conveyor.curve-180": { assetId: "industrial-252", name: "180度传送带" },
  "conveyor.merge": { assetId: "industrial-1767", name: "T形传送带" },
  "conveyor.chain-pallet": { assetId: "industrial-1784", name: "工厂传送带短运送带" },

  // ── 移动族(9):AGV 三型(潜伏/AMR/顶架)+ 叉车三型 + 轿车/货车/无人机 ─────
  "agv.forklift": { assetId: "industrial-1771", name: "叉车" },
  "agv.latent-jack": { assetId: "industrial-1338", name: "AGV" },
  "agv.amr": { assetId: "industrial-1339", name: "AGV小车" },
  "agv.amr-shelf": { assetId: "industrial-1766", name: "AGV拖车叉车" },
  "vehicle.forklift": { assetId: "industrial-744", name: "叉车_002" },
  "vehicle.reach-truck": { assetId: "industrial-745", name: "叉车_003" },
  "vehicle.car": { assetId: "industrial-1456", name: "轿车.001" },
  "vehicle.truck": { assetId: "industrial-761", name: "货车_002" },
  "agv.uav": { assetId: "industrial-995", name: "无人机" },

  // ── 机床与站体族(10):三类机床 + 注塑/AOI/磨床 + 道闸/互锁门/大屏/围栏 ───
  "machine.cnc-mill": { assetId: "industrial-1759", name: "设备机床" },
  "machine.cnc-lathe": { assetId: "industrial-1693", name: "工厂设备车床切割机床" },
  "machine.gantry-mill": { assetId: "industrial-1694", name: "工厂设备车床机床" },
  "machine.injection-molder": { assetId: "industrial-1675", name: "工业设备-机器-注塑机" },
  "machine.vision-inspection": { assetId: "industrial-535", name: "AOI检测" },
  "machine.surface-grinder": { assetId: "industrial-1155", name: "抛光机" },
  "access.gate": { assetId: "industrial-275", name: "停车场闸机_001" },
  "access.interlock-door": { assetId: "industrial-550", name: "双开门" },
  "display.wall": { assetId: "industrial-1384", name: "显示屏" },
  "fence.modular": { assetId: "industrial-1790", name: "工厂防护门安全围栏" },

  // ── 公用与电气族(11):泵/阀×2/风机×2/空压机/机柜×2/配电/储罐/过滤罐 ───────
  "utility.pump.centrifugal": { assetId: "industrial-1669", name: "加压泵设备" },
  "utility.valve.gate": { assetId: "industrial-1818", name: "阀门" },
  "utility.valve.control": { assetId: "industrial-1819", name: "阀门蝶阀" },
  "utility.fan.axial": { assetId: "industrial-1331", name: "通风机" },
  "utility.fan.exhaust": { assetId: "industrial-1332", name: "通风机_001" },
  "utility.compressor.air": { assetId: "industrial-1755", name: "空气压缩机" },
  "utility.cabinet.mcc": { assetId: "industrial-996", name: "机柜_005" },
  "utility.cabinet.plc": { assetId: "industrial-1255", name: "设备_机柜" },
  "utility.drive.vfd": { assetId: "industrial-1812", name: "配电箱设备" },
  "utility.tank.vertical": { assetId: "industrial-1779", name: "工业设备-储蓄罐-蓄水罐" },
  "utility.softener.duplex": { assetId: "industrial-1751", name: "活性炭过滤器" },

  // ── 仓储族(9):托盘/流利/堆垛机/立体库/贯通/密集架/冷柜/周转笼/料仓 ───────
  "storage.pallet-rack": { assetId: "industrial-273", name: "货架" },
  "storage.carton-flow": { assetId: "industrial-1791", name: "料架货架" },
  "storage.asrs-shuttle": { assetId: "industrial-256", name: "堆垛机" },
  "storage.asrs-rack": { assetId: "industrial-1371", name: "工厂货架" },
  "storage.drive-in-rack": { assetId: "industrial-1816", name: "长货物架" },
  "storage.mobile-shelving": { assetId: "industrial-1351", name: "储物柜" },
  "storage.cold-room": { assetId: "industrial-1401", name: "物品柜" },
  "storage.roll-cage": { assetId: "industrial-1452", name: "货物篮" },
  "storage.silo": { assetId: "industrial-1748", name: "水塔水箱反应罐" },

  // ── 社区库·感知族(6):烟感/声光/温湿度/RFID/称重/流量 ──────────────────
  // 说明:Delta/SCARA/龙门机器人与接近/液位/压力变送器等未找到达标 CC0
  // (体积超 15MB、面数超 10 万或形态不符),宁缺毋滥,走程序化兜底。
  "sensor.smoke-detector": { assetId: "community-2b2fa3b8357741c6a40758958222713b", name: "感烟探测器" },
  "sensor.sounder-strobe": { assetId: "community-28952d42af184dcca94b4e4ef0ae804b", name: "声光报警器" },
  "sensor.temperature": { assetId: "community-5f1665fbb88244388682cbffe14992f3", name: "温湿度传感器" },
  "sensor.rfid": { assetId: "community-16501915e98143e49930a755a87272b3", name: "RFID 读写器模块" },
  "sensor.load-cell": { assetId: "community-4c702e143d844bfc87baf2194d69666e", name: "称重传感器" },
  "sensor.flow": { assetId: "community-c65a592272e845899f307ead02d8c75e", name: "流量计" },

  // ── 社区库·摄像机族(4):枪机/固定工业相机/半球/云台 ─────────────────────
  "camera.bullet": { assetId: "community-281b2b84260447e49ab4a6b34bf78697", name: "枪型网络摄像机" },
  "camera.fixed": { assetId: "community-e69d5eb37ffb4f188e4d3c84a5d79cdc", name: "固定式工业相机" },
  "camera.dome": { assetId: "community-ab8d2a64d3894deba9af23203ba0368d", name: "半球型网络摄像机" },
  "camera.ptz": { assetId: "community-83d0156e07624d8c8f61ab46277768bb", name: "云台摄像机" },

  // ── 社区库·车辆族(5):半挂牵引/自卸/曲臂登高/皮卡巡查/牵引车 ────────────
  "vehicle.tractor-unit": { assetId: "community-3297f0944c624cdf98a80af047cd44b3", name: "半挂牵引车" },
  "vehicle.dump-truck": { assetId: "community-781c616da8f44982a59cb3fc3fa67f98", name: "自卸车" },
  "vehicle.boom-lift": { assetId: "community-aa7ce85ae7194eb2921005ac74a58a78", name: "曲臂式登高车" },
  "vehicle.patrol-pickup": { assetId: "community-047615f53e2d45b9a1a2a4dd203d459c", name: "皮卡巡查车" },
  "vehicle.tow-tractor": { assetId: "community-e15e6f76f18e4b02b7009df0fb018fc8", name: "牵引车" },

  // ── 社区库·人员族(5):作业/操作/巡检/维修/访客 ─────────────────────────
  "person.worker": { assetId: "community-9075b0deb11b40bca7f5ce8a8e7b63cb", name: "作业人员" },
  "person.operator": { assetId: "community-56f14e6f182146609139b0517bc3d66c", name: "产线操作员" },
  "person.guard": { assetId: "community-11988638b3104689ab1f4275598f6ff2", name: "巡检人员" },
  "person.maintenance": { assetId: "community-620e27e5126f40d080c5d4bffab9eedb", name: "维修技师" },
  "person.visitor": { assetId: "community-64c97dedb5134dfeafcadd91dc317215", name: "访客" },
};

/** 取某预制体的真实模型匹配;未收录(或显式缺失)返回 undefined,由调用方兜底。 */
export function prefabModelMatchFor(definitionId: string): PrefabModelMatch | undefined {
  return PREFAB_MODEL_MATCHES[definitionId];
}

/** source-a 模型 GLB 的统一取数地址:与资源页模型预览同一来源(assetLibraryApi)。 */
export function prefabModelPreviewUrl(assetId: string): string {
  return `/api/asset-library/items/${encodeURIComponent(assetId)}/preview`;
}

/** 匹配统计(供交付报告与测试断言):命中条数。 */
export function prefabModelMatchCount(): number {
  return Object.keys(PREFAB_MODEL_MATCHES).length;
}
