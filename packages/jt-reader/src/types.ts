export type JtByteOrder = "little-endian" | "big-endian";

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
}

export interface JtSceneGraph {
  nodes: JtSceneNode[];
  rootObjectIds: number[];
  propertyAtomCount: number;
  unknownElementTypeIds: string[];
}

export interface JtMeshTextureSet {
  /** 源网格顶点绑定掩码中的纹理集编号(JT bit8 对应纹理集 0,bit9 对应 1,依此类推,上限 31)。 */
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
   * 缺席 ⇔ 源网格没有纹理集绑定或只解码出单集(单集时 uvs 已覆盖,不重复存储)。
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
