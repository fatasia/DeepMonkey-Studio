export type JtByteOrder = "little-endian" | "big-endian";

import type { JtErrorCode } from "./errors.js";
export type { JtErrorCode } from "./errors.js";

export interface JtReadLimits {
  maxFileBytes: number;
  maxSegmentCount: number;
  maxSegmentBytes: number;
  maxDecompressedBytes: number;
  maxLogicalElements: number;
  maxPropertiesPerElement: number;
}

export interface JtFileHeader {
  versionText: string;
  majorVersion: number;
  minorVersion: number;
  byteOrder: JtByteOrder;
  tocOffset: number;
  lsgSegmentId: string;
}

export interface JtSegmentEntry {
  id: string;
  offset: number;
  length: number;
  attributes: number;
  type: number;
}

export interface JtLogicalElement {
  objectId: number;
  objectTypeId: string;
  baseType: number;
  payload: Uint8Array;
  streamOffset: number;
}

export type JtPropertyValue = string | number | boolean;

export interface JtLateLoadedSegment {
  id: string;
  type: number;
  payloadObjectId?: number;
}

export interface JtSceneNode {
  objectId: number;
  kind: string;
  label: string;
  childObjectIds: number[];
  attributeObjectIds: number[];
  properties: Record<string, JtPropertyValue>;
  transform?: number[];
  lateLoadedSegments?: JtLateLoadedSegment[];
  /** 直接挂在本节点上的内联纹理图像；子节点通过实例路径继承。 */
  textureImages?: JtTextureImage[];
}

/** JT 内联 U8 像素保留源字节；GLB 写出端负责 PNG 封装，不把原始像素误当 PNG。 */
export interface JtTextureImage {
  objectId: number;
  textureChannel: number;
  textureSetIndex: number;
  width: number;
  height: number;
  channels: 3 | 4;
  pixels: Uint8Array;
  wrapS: number;
  wrapT: number;
  filter: number;
}

export interface JtSceneGraph {
  nodes: JtSceneNode[];
  rootObjectIds: number[];
  propertyAtomCount: number;
  unknownElementTypeIds: string[];
}

export interface JtMeshTextureSet {
  /** 源网格顶点绑定掩码中的纹理集编号:每 4 位一个集合,bit8..11 对应集合 0、bit12..15 对应集合 1,依此类推(64 位掩码实际可达 14 个集合;声明 profile 仅验证到 2 个)。 */
  textureSetIndex: number;
  /** 该集合的顶点 UV(平铺 [u0,v0,u1,v1,...]),长度 = 顶点数 × 2,值域 [0,1]。 */
  uvs: Float32Array;
}

export interface JtMesh {
  id: string;
  segmentId: string;
  lod: number;
  vertexRecordObjectId: number;
  positions: number[];
  indices: number[];
  polygonGroups: number[];
  sceneNodeObjectIds: number[];
  vertexCount: number;
  triangleCount: number;
  /**
   * 解码出的顶点 UV(平铺 [u0,v0,u1,v1,...]),长度 = 顶点数 × 2。
   * 可选字段:缺席 ⇔ 源网格没有 UV binding,与 positions 长度不做隐式绑定——
   * 存在时也只承诺"长度与 vertexCount × 2 一致",不承诺与索引共享布局。
   * 多纹理集网格上此字段等价于纹理集 0(缺席时为第一个可用集合),完整清单见 textureSets。
   */
  uvs?: Float32Array;
  /**
   * 全部解码成功的纹理集(按集合编号升序)。
   * 缺席 ⇔ 源网格没有纹理集绑定或仅有编号 0 的单集(此时 uvs 已覆盖)。
   * 单个非零编号集合必须保留在此清单，否则导出时会被误标成集合 0。
   */
  textureSets?: JtMeshTextureSet[];
  /**
   * 解码出的顶点色(平铺 [r,g,b,a,...],线性 0..1),长度 = 顶点数 × 4。
   * 可选字段语义同 uvs:缺席 ⇔ 源网格没有颜色 binding。
   */
  colors?: Float32Array;
  /** 源网格中存在、但当前解码器尚未支持的顶点属性绑定(按位命名,如实上报,禁止虚构)。 */
  unsupportedAttributeBindings: string[];
}

export interface JtMeshInstance {
  id: string;
  meshId: string;
  sceneNodeObjectId: number;
  pathObjectIds: number[];
  worldTransform: number[];
}

/** PMI 数据段(type 3)的结构级解析结果。当前只承诺清单,不做标注图形/文本的语义解析。 */
export interface JtPmiEntityGroup {
  type: string;
  count: number;
}

export interface JtPmiSegmentSummary {
  segmentId: string;
  /** 段内 PMI Manager Meta Data 元素(objectTypeId ce357249-...)数量。 */
  managerCount: number;
  /** Manager 元素头中的元素版本字节与 PMI 结构版本号(真实样本验证字段)。 */
  elementVersion: number;
  structureVersion: number;
  entityGroups: JtPmiEntityGroup[];
  /** 字符串表内容(结构级清单;字符串 ID 即数组下标)。 */
  strings: string[];
  /** 模型视图名称(按 nameStringId 解引用;缺名时以 id 占位)。 */
  modelViewNames: string[];
}

export interface JtPmiInfo {
  segmentCount: number;
  /** 全部 PMI 段的结构化实体总数(各 entityGroups.count 之和)。 */
  entityCount: number;
  /** 结构级实体清单(association/modelView/generic-properties 等按类型计数)。 */
  types: JtPmiEntityGroup[];
  segments: JtPmiSegmentSummary[];
  /** 恒为 true:当前解析器只输出结构清单,标注/尺寸/文本的语义解析未实现。 */
  structureOnly: true;
  notes: string[];
}

export interface JtDocument {
  header: JtFileHeader;
  segments: JtSegmentEntry[];
  sceneGraph: JtSceneGraph;
  meshes: JtMesh[];
  meshInstances: JtMeshInstance[];
  /** 文件包含 PMI 数据段(type 3)时的结构级清单;无 PMI 段则缺省,不做占位。 */
  pmi?: JtPmiInfo;
  /**
   * 结构化损失/诊断记录(JT_LOSS_CODES 词表),按确定性顺序排列。
   * 可选字段:缺席 ⇔ 无损失/边界/源事实声明(如纯结构文件)或由旧版本 reader 产出。
   * warnings 仍是人读汇总文本,与 losses 的 detail 同源但不承载机读语义。
   */
  losses?: JtLoss[];
  warnings: string[];
}

export const DEFAULT_JT_READ_LIMITS: Readonly<JtReadLimits> = {
  maxFileBytes: 512 * 1024 * 1024,
  maxSegmentCount: 100_000,
  maxSegmentBytes: 256 * 1024 * 1024,
  maxDecompressedBytes: 512 * 1024 * 1024,
  maxLogicalElements: 2_000_000,
  maxPropertiesPerElement: 10_000,
};

/**
 * 结构化损失/诊断的稳定码词表(与 JtErrorCode 分词表:错误码描述"解析为何失败",
 * 损失码描述"产物相对源/声明范围缺了什么")。`code` 是机器可读契约,一经发布冻结;
 * `detail` 仅人读。清单的权威文档在 docs/format-support.md 的 JT 节。
 */
export const JT_LOSS_CODES = [
  /** JT 几何仅解码 TriStrip/TopoMesh 三角网格;B-Rep/精确曲面数据段不在解析范围(能力边界,始终声明)。 */
  "tessellation-only",
  /** 全部候选网格段都未解码出任何网格,文档仅剩结构/属性清单。 */
  "no-mesh-decoded",
  /** 文件不含任何候选网格段(JT 9 类型 6 / JT 10 类型 7..16),无几何属源文件事实。 */
  "mesh-segment-absent",
  /** 全部已解码网格均无 UV/纹理集绑定(源文件事实,非解码缺陷)。 */
  "uv-binding-absent",
  /** 单个候选网格段解码失败;`errorCode` 携带底层 JtErrorCode。 */
  "mesh-segment-decode-failed",
  /** 存在未解释、按长度安全跳过的 LSG 元素类型。 */
  "lsg-element-uninterpreted",
  /** 文件不含 PMI(type 3)数据段,pmi 节省略属源文件事实。 */
  "pmi-segment-absent",
  /** PMI 仅输出结构级清单,标注/尺寸/文本语义解析未实现(能力边界)。 */
  "pmi-structure-only",
  /** 单个 PMI 数据段结构解析失败;`errorCode` 携带底层 JtErrorCode。 */
  "pmi-segment-parse-failed",
  /** PMI 数据段内不含可识别的 PMI Manager 元素,按结构未知上报。 */
  "pmi-segment-structure-unknown",
] as const;

export type JtLossCode = (typeof JT_LOSS_CODES)[number];

/** 损失三态:loss=解码丢弃/近似了源中存在的信息;known-limitation=解析器能力边界;source-fact=已验证的源文件事实(供 profile 门禁消费)。 */
export type JtLossKind = "loss" | "known-limitation" | "source-fact";

export interface JtLoss {
  /** 稳定损失码(JT_LOSS_CODES),机读消费只允许依赖它。 */
  code: JtLossCode;
  kind: JtLossKind;
  /** 作用域:document / segment:<id> / pmi:<segmentId>。 */
  scope: string;
  /** 人读细节,与 warnings 同源文本;机读消费禁止解析其措辞。 */
  detail: string;
  /** 触发该损失的底层格式错误码;非 JtFormatError 触发时缺席。 */
  errorCode?: JtErrorCode;
}
