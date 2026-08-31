import {
  Activity,
  BatteryCharging,
  Bot,
  Box,
  Cable,
  Cctv,
  CircleDot,
  Cog,
  Cpu,
  Factory,
  Fan,
  Gauge,
  Network,
  Server,
  Truck,
  Warehouse,
  Zap,
  type LucideIcon,
} from "lucide-react";

export interface TopologyNodePreset {
  kind: string;
  labelZh: string;
  labelEn: string;
  icon: LucideIcon;
  scada: boolean;
}

export interface TopologyNodePresetGroup {
  id: "base" | "process" | "electrical" | "logistics" | "infrastructure";
  labelZh: string;
  labelEn: string;
  presets: readonly TopologyNodePreset[];
}

/**
 * 只收录数字孪生项目高频对象；更专业的行业符号通过插件素材包扩展，避免主包演变成图库仓库。
 */
export const TOPOLOGY_NODE_PRESET_GROUPS: readonly TopologyNodePresetGroup[] = [
  {
    id: "base",
    labelZh: "通用对象",
    labelEn: "General",
    presets: [
      preset("device", "通用设备", "Device", Box),
      preset("controller", "控制器", "Controller", Cpu),
      preset("sensor", "传感器", "Sensor", Gauge),
      preset("gateway", "边缘网关", "Gateway", Cable),
    ],
  },
  {
    id: "process",
    labelZh: "工艺设备",
    labelEn: "Process",
    presets: [
      preset("pump", "工业泵", "Pump", Gauge, true),
      preset("valve", "控制阀", "Valve", CircleDot, true),
      preset("tank", "储罐", "Tank", Box, true),
      preset("motor", "电机", "Motor", Cog, true),
      preset("fan", "风机", "Fan", Fan, true),
      preset("compressor", "压缩机", "Compressor", Activity, true),
      preset("heat-exchanger", "换热器", "Heat exchanger", Network, true),
      preset("boiler", "锅炉", "Boiler", Factory, true),
    ],
  },
  {
    id: "electrical",
    labelZh: "电气与能源",
    labelEn: "Electrical",
    presets: [
      preset("plc", "PLC", "PLC", Cable, true),
      preset("meter", "工业仪表", "Meter", Gauge, true),
      preset("switchgear", "开关柜", "Switchgear", Zap, true),
      preset("transformer", "变压器", "Transformer", Activity, true),
      preset("inverter", "变频器", "Inverter", Cpu, true),
      preset("battery", "储能电池", "Battery", BatteryCharging, true),
    ],
  },
  {
    id: "logistics",
    labelZh: "产线与物流",
    labelEn: "Line & logistics",
    presets: [
      preset("conveyor", "输送线", "Conveyor", Network, true),
      preset("robot", "工业机器人", "Robot", Bot, true),
      preset("agv", "AGV", "AGV", Truck, true),
      preset("workstation", "工位", "Workstation", Factory, true),
      preset("warehouse", "仓储区", "Warehouse", Warehouse, true),
    ],
  },
  {
    id: "infrastructure",
    labelZh: "基础设施",
    labelEn: "Infrastructure",
    presets: [
      preset("camera", "工业相机", "Camera", Cctv, true),
      preset("server", "边缘服务器", "Edge server", Server, true),
      preset("network", "工业网络", "Network", Network, true),
    ],
  },
] as const;

export const TOPOLOGY_NODE_PRESETS = TOPOLOGY_NODE_PRESET_GROUPS.flatMap((group) => group.presets);

function preset(
  kind: string,
  labelZh: string,
  labelEn: string,
  icon: LucideIcon,
  scada = false,
): TopologyNodePreset {
  return { kind, labelZh, labelEn, icon, scada };
}
