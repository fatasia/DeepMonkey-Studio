import type { ParametricCadDefinition, ParametricCadParameter } from "@bim-studio/contracts";

export interface ParametricCadTemplate { id: string; label: string; description: string; definition: ParametricCadDefinition; }

const parameter = (id: string, label: string, value: number, min: number, max: number, step = 1, semantic?: string): ParametricCadParameter => ({
  id, label, value, min, max, step, unit: "mm", ...(semantic ? { semantic } : {})
});

export const PARAMETRIC_CAD_TEMPLATES: readonly ParametricCadTemplate[] = [
  {
    id: "mounting-plate", label: "设备安装板", description: "传感器、网关与小型电控件的四孔安装板",
    definition: {
      schemaVersion: 1, name: "设备安装板", summary: "带四个安装孔的参数化矩形安装板", unit: "mm",
      parameters: [
        parameter("width", "宽度", 120, 50, 400, 5, "asset.mounting.width"),
        parameter("depth", "深度", 80, 40, 300, 5, "asset.mounting.depth"),
        parameter("thickness", "板厚", 8, 3, 30, 1, "asset.material.thickness"),
        parameter("holeRadius", "孔半径", 3.5, 1, 12, 0.5, "interface.mounting.holeRadius"),
        parameter("edgeOffset", "孔边距", 12, 6, 40),
        parameter("fillet", "圆角", 2, 0, 8, 0.5)
      ],
      features: [
        { id: "body", label: "安装板主体", primitive: "box", operation: "base", size: ["width", "depth", "thickness"], position: ["-width/2", "-depth/2", 0] },
        { id: "hole-1", label: "左下安装孔", primitive: "cylinder", operation: "cut", radius: "holeRadius", height: "thickness", position: ["-width/2+edgeOffset", "-depth/2+edgeOffset", 0] },
        { id: "hole-2", label: "右下安装孔", primitive: "cylinder", operation: "cut", radius: "holeRadius", height: "thickness", position: ["width/2-edgeOffset", "-depth/2+edgeOffset", 0] },
        { id: "hole-3", label: "左上安装孔", primitive: "cylinder", operation: "cut", radius: "holeRadius", height: "thickness", position: ["-width/2+edgeOffset", "depth/2-edgeOffset", 0] },
        { id: "hole-4", label: "右上安装孔", primitive: "cylinder", operation: "cut", radius: "holeRadius", height: "thickness", position: ["width/2-edgeOffset", "depth/2-edgeOffset", 0] }
      ],
      edgeTreatment: { kind: "fillet", radius: "fillet" },
      semanticBindings: [
        { parameterId: "width", source: "设备/工位元数据", meaning: "安装包络宽度", targetId: "asset.mounting.width" },
        { parameterId: "holeRadius", source: "机械接口语义", meaning: "安装孔半径", targetId: "interface.mounting.holeRadius" }
      ]
    }
  },
  {
    id: "sensor-bracket", label: "传感器 L 型支架", description: "光电、接近与视觉传感器的简化安装支架",
    definition: {
      schemaVersion: 1, name: "传感器 L 型支架", summary: "底板、立板与安装通孔组成的 L 型支架", unit: "mm",
      parameters: [parameter("baseW", "底板宽", 70, 30, 180, 5), parameter("baseD", "底板深", 50, 25, 140, 5), parameter("height", "立板高", 75, 30, 220, 5), parameter("thickness", "板厚", 6, 3, 16), parameter("holeRadius", "孔半径", 4, 1.5, 10, 0.5)],
      features: [
        { id: "base", label: "底板", primitive: "box", operation: "base", size: ["baseW", "baseD", "thickness"], position: ["-baseW/2", "-baseD/2", 0] },
        { id: "upright", label: "立板", primitive: "box", operation: "union", size: ["baseW", "thickness", "height"], position: ["-baseW/2", "baseD/2-thickness", 0] },
        { id: "sensor-hole", label: "传感器安装孔", primitive: "cylinder", operation: "cut", radius: "holeRadius", height: "thickness", position: [0, "baseD/2-thickness", "height*0.72"], rotation: [-90, 0, 0] }
      ],
      semanticBindings: [{ parameterId: "height", source: "工位布局/安装位", meaning: "传感器中心安装高度", targetId: "station.sensor.mountHeight" }]
    }
  },
  {
    id: "spacer", label: "定位套筒", description: "可调外径、内孔和长度的轴套/隔套",
    definition: {
      schemaVersion: 1, name: "定位套筒", summary: "通用机械定位套筒", unit: "mm",
      parameters: [parameter("outerRadius", "外半径", 15, 4, 60, 0.5), parameter("innerRadius", "内半径", 7, 1, 50, 0.5), parameter("length", "长度", 35, 5, 160), parameter("chamfer", "倒角", 1, 0, 5, 0.25)],
      features: [
        { id: "outer", label: "套筒外形", primitive: "cylinder", operation: "base", radius: "outerRadius", height: "length", position: [0, 0, 0] },
        { id: "bore", label: "中心孔", primitive: "cylinder", operation: "cut", radius: "innerRadius", height: "length", position: [0, 0, 0] }
      ],
      edgeTreatment: { kind: "chamfer", radius: "chamfer" }
    }
  }
] as const;

export function cloneParametricDefinition(definition: ParametricCadDefinition): ParametricCadDefinition {
  return structuredClone(definition);
}
