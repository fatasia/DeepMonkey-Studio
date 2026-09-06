import type {
  ModelFormatCapability,
  ModelFormatFamily,
  ModelFormatFidelityDimension,
  ModelFormatScope
} from "./modelFormatCapability.js";

const COMMON_VISUAL_FIDELITY = [
  "visual-geometry",
  "assembly-hierarchy",
  "instances-and-transforms",
  "materials-and-textures",
  "coordinate-system"
] as const satisfies readonly ModelFormatFidelityDimension[];

const PRECISE_CAD_FIDELITY = [
  "visual-geometry",
  "precise-geometry",
  "assembly-hierarchy",
  "instances-and-transforms",
  "object-properties",
  "pmi",
  "coordinate-system"
] as const satisfies readonly ModelFormatFidelityDimension[];

interface CatalogDefinition {
  id: string;
  label: string;
  extensions: readonly string[];
  family: ModelFormatFamily;
  scope: ModelFormatScope;
  dimensions?: readonly ModelFormatFidelityDimension[];
  reason: string;
}

function declaredCapability(definition: CatalogDefinition): ModelFormatCapability {
  const excluded = definition.scope === "excluded";
  return {
    id: definition.id,
    label: definition.label,
    extensions: definition.extensions,
    family: definition.family,
    direction: "import",
    scope: definition.scope,
    // 这是能力目标目录，不是运行时支持矩阵；没有证据时一律不声明已经可用。
    implementationStatus: excluded ? "excluded" : "planned",
    runtimeStatus: excluded ? "not-applicable" : "unavailable",
    validationStatus: excluded ? "not-applicable" : "unverified",
    fidelityTargets: (definition.dimensions ?? COMMON_VISUAL_FIDELITY).map((dimension) => ({
      dimension,
      minimum: dimension === "pmi" || dimension === "materials-and-textures" ? "partial" : "full",
      required: dimension !== "pmi"
    })),
    validatedFidelity: {},
    validationEvidence: [],
    decisionReason: definition.reason
  };
}

/**
 * 面向工业数字孪生的格式目标目录。高价值格式优先形成自研转换链路；
 * 长尾格式明确排除，避免用“上传成功”冒充“模型可用”。
 */
export const MODEL_FORMAT_CAPABILITY_CATALOG: readonly ModelFormatCapability[] = [
  declaredCapability({
    id: "urdf", label: "URDF / 机器人 ZIP", extensions: ["urdf", "zip"], family: "scene-description", scope: "core",
    dimensions: [...COMMON_VISUAL_FIDELITY, "object-properties"], reason: "机器人描述与本地资源包入口；保留关节原始结构，不代表物理仿真或任意机器人兼容，ZIP 仅限机器人包"
  }),
  declaredCapability({
    id: "gltf", label: "glTF / GLB", extensions: ["gltf", "glb"], family: "runtime-scene", scope: "core",
    dimensions: [...COMMON_VISUAL_FIDELITY, "animation"], reason: "Web 运行时交付与跨端发布的主格式"
  }),
  declaredCapability({
    id: "obj", label: "OBJ", extensions: ["obj"], family: "polygon-mesh", scope: "core",
    dimensions: ["visual-geometry", "materials-and-textures", "coordinate-system"], reason: "通用网格交换与历史资产兼容"
  }),
  declaredCapability({
    id: "stl", label: "STL", extensions: ["stl"], family: "polygon-mesh", scope: "core",
    dimensions: ["visual-geometry", "coordinate-system"], reason: "设备零件与增材制造网格常用入口"
  }),
  declaredCapability({
    id: "fbx", label: "FBX", extensions: ["fbx"], family: "runtime-scene", scope: "core",
    dimensions: [...COMMON_VISUAL_FIDELITY, "animation"], reason: "动画、人车与工业预制体的重要交换格式"
  }),
  declaredCapability({
    id: "step", label: "STEP", extensions: ["step", "stp"], family: "precise-cad", scope: "core",
    dimensions: PRECISE_CAD_FIDELITY, reason: "公开标准下的精确机械 CAD 主入口"
  }),
  declaredCapability({
    id: "iges", label: "IGES", extensions: ["iges", "igs"], family: "precise-cad", scope: "core",
    dimensions: ["visual-geometry", "precise-geometry", "object-properties", "coordinate-system"], reason: "存量曲面与精确几何资产兼容"
  }),
  declaredCapability({
    id: "ifc", label: "IFC", extensions: ["ifc", "ifczip"], family: "bim", scope: "core",
    dimensions: [...COMMON_VISUAL_FIDELITY, "object-properties"], reason: "BIM 工程资产与语义底座的开放主格式"
  }),
  declaredCapability({
    id: "jt", label: "JT", extensions: ["jt"], family: "product-structure", scope: "core",
    dimensions: PRECISE_CAD_FIDELITY, reason: "大型工业装配、LOD、属性与 PMI 的高价值入口"
  }),
  declaredCapability({
    id: "usd", label: "OpenUSD", extensions: ["usd", "usda", "usdc", "usdz"], family: "scene-description", scope: "core",
    dimensions: [...COMMON_VISUAL_FIDELITY, "object-properties", "animation"], reason: "分层场景、引用、变体与跨工具资产交换"
  }),
  declaredCapability({
    id: "dxf", label: "DXF", extensions: ["dxf"], family: "drawing", scope: "core",
    dimensions: ["drawing-sheets", "object-properties", "coordinate-system"], reason: "车间布局、图纸和二维资产的开放入口"
  }),
  declaredCapability({
    id: "dwg", label: "DWG", extensions: ["dwg"], family: "drawing", scope: "core",
    dimensions: ["drawing-sheets", "object-properties", "coordinate-system"], reason: "工业图纸存量覆盖率高，需保持显式验证"
  }),
  declaredCapability({
    id: "3mf", label: "3MF", extensions: ["3mf"], family: "polygon-mesh", scope: "optional",
    dimensions: ["visual-geometry", "materials-and-textures", "object-properties", "coordinate-system"], reason: "结构化制造网格的轻量补充"
  }),
  declaredCapability({
    id: "3dm", label: "3DM", extensions: ["3dm"], family: "precise-cad", scope: "optional",
    dimensions: ["visual-geometry", "precise-geometry", "materials-and-textures", "object-properties", "coordinate-system"], reason: "曲面建模资产存在明确但非核心需求"
  }),
  declaredCapability({
    id: "dae", label: "COLLADA", extensions: ["dae"], family: "runtime-scene", scope: "optional",
    dimensions: [...COMMON_VISUAL_FIDELITY, "animation"], reason: "旧场景与动画资产的兼容入口"
  }),
  declaredCapability({
    id: "3ds", label: "3DS", extensions: ["3ds"], family: "polygon-mesh", scope: "optional",
    dimensions: COMMON_VISUAL_FIDELITY, reason: "存量轻量网格资产的兼容入口"
  }),
  declaredCapability({
    id: "kmz", label: "KMZ", extensions: ["kmz", "kml"], family: "scene-description", scope: "optional",
    dimensions: ["visual-geometry", "object-properties", "coordinate-system"], reason: "园区地理资产的可选交换格式"
  }),
  declaredCapability({
    id: "plmxml", label: "PLM XML", extensions: ["plmxml"], family: "product-structure", scope: "optional",
    dimensions: ["assembly-hierarchy", "instances-and-transforms", "object-properties", "coordinate-system"], reason: "装配结构与外部几何引用的轻量补充"
  }),
  declaredCapability({
    id: "qif", label: "QIF", extensions: ["qif"], family: "quality", scope: "optional",
    dimensions: ["precise-geometry", "object-properties", "pmi", "coordinate-system"], reason: "质量检测和 MBD 数据具备工业价值"
  }),
  declaredCapability({
    id: "parasolid", label: "X_T / X_B", extensions: ["x_t", "x_b", "xmt_txt", "xmt_bin"], family: "precise-cad", scope: "optional",
    dimensions: PRECISE_CAD_FIDELITY, reason: "精确几何价值高，但自研实现成本和版本风险需单独治理"
  }),
  declaredCapability({
    id: "rvt", label: "RVT", extensions: ["rvt"], family: "bim", scope: "optional",
    dimensions: [...COMMON_VISUAL_FIDELITY, "object-properties"], reason: "作为工程资产导入候选，不扩展为 BIM 编辑器"
  }),
  declaredCapability({
    id: "prc", label: "PRC", extensions: ["prc"], family: "document-container", scope: "optional",
    dimensions: PRECISE_CAD_FIDELITY, reason: "三维文档中的结构化几何具有有限交换价值"
  }),
  declaredCapability({
    id: "u3d", label: "U3D", extensions: ["u3d"], family: "document-container", scope: "optional",
    dimensions: COMMON_VISUAL_FIDELITY, reason: "三维文档存量兼容，不进入主工作流"
  }),
  declaredCapability({
    id: "native-sld", label: "SLDPRT / SLDASM", extensions: ["sldprt", "sldasm"], family: "native-authoring", scope: "excluded",
    reason: "缺少稳定开放规范，自研投入与当前高价值工作流不匹配"
  }),
  declaredCapability({
    id: "native-cat", label: "CATPART / CATPRODUCT", extensions: ["catpart", "catproduct"], family: "native-authoring", scope: "excluded",
    reason: "版本复杂且缺少稳定开放规范，优先接受中立交换格式"
  }),
  declaredCapability({
    id: "native-prt", label: "PRT / ASM", extensions: ["prt", "asm"], family: "native-authoring", scope: "excluded",
    reason: "扩展名歧义且原生语义封闭，不进入自研首批范围"
  }),
  declaredCapability({
    id: "native-ipt", label: "IPT / IAM", extensions: ["ipt", "iam"], family: "native-authoring", scope: "excluded",
    reason: "原生格式收益不足以覆盖持续版本适配成本"
  }),
  declaredCapability({
    id: "native-par", label: "PAR / PSM", extensions: ["par", "psm"], family: "native-authoring", scope: "excluded",
    reason: "低频原生格式，使用 STEP 或 JT 交换链路替代"
  }),
  declaredCapability({
    id: "navis-container", label: "NWD / NWC / NWF", extensions: ["nwd", "nwc", "nwf"], family: "bim", scope: "excluded",
    reason: "聚合容器依赖外部生态，优先接收 IFC 与运行时资产"
  }),
  declaredCapability({
    id: "dgn", label: "DGN", extensions: ["dgn"], family: "drawing", scope: "excluded",
    reason: "当前场景覆盖率低，暂以 DXF、DWG 和 IFC 替代"
  }),
  declaredCapability({
    id: "dwf", label: "DWF / DWFx", extensions: ["dwf", "dwfx"], family: "document-container", scope: "excluded",
    reason: "发布容器的编辑与仿真价值有限"
  }),
  declaredCapability({
    id: "hsf", label: "HSF", extensions: ["hsf"], family: "runtime-scene", scope: "excluded",
    reason: "生态封闭且与现有运行时格式能力重叠"
  }),
  declaredCapability({
    id: "xvl", label: "XVL", extensions: ["xvl"], family: "product-structure", scope: "excluded",
    reason: "封闭生态与许可成本不符合轻量自研路线"
  }),
  declaredCapability({
    id: "three-d-pdf", label: "3D PDF", extensions: ["pdf"], family: "document-container", scope: "excluded",
    reason: "文档容器不是工业场景编辑和仿真的首选资产入口"
  })
];

export function findModelFormatCapability(extension: string): ModelFormatCapability | undefined {
  const normalized = extension.trim().toLowerCase().replace(/^\./, "");
  return MODEL_FORMAT_CAPABILITY_CATALOG.find((capability) => capability.extensions.includes(normalized));
}
