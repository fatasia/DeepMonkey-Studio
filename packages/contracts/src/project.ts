import type { DataConnectionRecord, DataDatasetRecord, DataEndpointDefinition, DataPipelineDefinition } from "./data.js";
import type { AiDataBinding, AiDataBindingRunRecord } from "./aiDataBinding.js";
import type { ModelTransform } from "./geometry.js";
import type { UnityResourceRecord } from "./operations.js";
import type { ParametricModelGeneration } from "./parametricModeling.js";
import type { VisionEventRecord, VisionModelRecord, VisionSourceRecord, VisionTaskRecord } from "./vision.js";
import type { SemanticModelRecord } from "./semantic.js";
import type { AssetAttribution } from "./assetLibrary.js";
import type { RobotAssetDefinition } from "./robotAsset.js";

/** 项目、模型资产、转换清单与 Revit 运行时合同。 */
export const supportedExtensions = [
  "rvt",
  "ifc",
  "step",
  "stp",
  "iges",
  "igs",
  "dwg",
  "dxf",
  "gltf",
  "glb",
  "fbx",
  // 高价值开放交换格式由浏览器按需加载，避免所有输入都强制经过服务端转换。
  "obj",
  "stl",
  "3mf",
  "dae",
  "3ds",
  "x_t",
  "x_b",
  "jt",
  // OpenUSD 原生层格式；原始文件保留，由 Three.js 官方加载器按需读取。
  "usd",
  "usda",
  "usdc",
  "usdz",
  "urdf",
  // ZIP 仅用于完整机器人描述与依赖包，不作为通用压缩模型入口。
  "zip",
] as const;

export type ModelFormat = (typeof supportedExtensions)[number];
export type ConversionStatus = "queued" | "processing" | "ready" | "waiting_converter" | "failed";
export type ViewerKind = "ifc" | "fragments" | "gltf" | "fbx" | "dxf" | "obj" | "stl" | "3mf" | "dae" | "3ds" | "usd" | "urdf";
export type RvtConversionMode = "ifc" | "native-glb";

export interface RevitInstallationRecord {
  version: string;
  path: string;
  source: "environment" | "registry" | "standard";
  addinInstalled: boolean;
  workerReady: boolean;
}

export interface RevitRuntimeInfo {
  installations: RevitInstallationRecord[];
  defaultVersion: string;
}

export interface ModelManifest {
  schemaVersion: 1;
  modelId: string;
  sourceName: string;
  sourceFormat: ModelFormat;
  viewerKind?: ViewerKind;
  geometryUrl?: string;
  hierarchyUrl?: string;
  propertiesUrl?: string;
  /** 原生格式检查证据；可以在尚无几何时单独存在。 */
  inspectionUrl?: string;
  pmiUrl?: string;
  lods?: ModelLodResource[];
  robot?: RobotAssetDefinition;
  createdAt: string;
}

export interface ModelLodResource {
  url: string;
  ratio: number;
  level: "medium" | "low";
}

export interface ModelRecord {
  id: string;
  projectId: string;
  name: string;
  format: ModelFormat;
  rvtConversionMode?: RvtConversionMode;
  rvtSourceVersion?: string;
  rvtRevitVersion?: string;
  robotEntryPath?: string;
  size: number;
  status: ConversionStatus;
  progress: number;
  message: string;
  sourceUrl: string;
  manifestUrl?: string;
  manifest?: ModelManifest;
  generation?: ParametricModelGeneration;
  /** 优化生成独立素材，不沿用目录去重身份；保存源版本与必要署名的快照。 */
  optimization?: {
    sourceModelId: string;
    sourceModelName: string;
    sourceUpdatedAt: string;
    libraryOrigin?: ModelRecord["libraryOrigin"];
  };
  /** 目录导入来源用于去重、版本治理与交付署名。 */
  libraryOrigin?: {
    itemId: string;
    contentHash: string;
    catalogVersion: 1;
    version?: string;
    license?: string;
    attribution?: AssetAttribution;
  };
  createdAt: string;
  updatedAt: string;
}

export type ProjectAssetKind = "image" | "video" | "environment" | "pbr-material";

export type ProjectAssetMapKind = "environment" | "base-color" | "normal" | "ao" | "roughness" | "metalness";

export interface ProjectAssetMapRecord {
  kind: ProjectAssetMapKind;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  contentHash: string;
}

export interface ProjectAssetRecord {
  id: string;
  projectId: string;
  kind: ProjectAssetKind;
  name: string;
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  thumbnailUrl?: string;
  maps?: ProjectAssetMapRecord[];
  libraryOrigin?: {
    itemId: string;
    contentHash: string;
    catalogVersion: 1;
    version: string;
    license: string;
    publicationStatus: "published" | "review-required" | "deprecated";
    attribution?: AssetAttribution;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  description: string;
  models: ModelRecord[];
  assets?: ProjectAssetRecord[];
  unityResources?: UnityResourceRecord[];
  dataConnections?: DataConnectionRecord[];
  datasets?: DataDatasetRecord[];
  dataPipelines?: DataPipelineDefinition[];
  dataEndpoints?: DataEndpointDefinition[];
  semanticModels?: SemanticModelRecord[];
  aiDataBindings?: AiDataBinding[];
  aiDataBindingRuns?: AiDataBindingRunRecord[];
  visionSources?: VisionSourceRecord[];
  visionModels?: VisionModelRecord[];
  visionTasks?: VisionTaskRecord[];
  visionEvents?: VisionEventRecord[];
  createdAt: string;
  updatedAt: string;
}
