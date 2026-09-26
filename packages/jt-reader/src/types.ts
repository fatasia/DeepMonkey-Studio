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
   */
  uvs?: Float32Array;
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

export interface JtDocument {
  header: JtFileHeader;
  segments: JtSegmentEntry[];
  sceneGraph: JtSceneGraph;
  meshes: JtMesh[];
  meshInstances: JtMeshInstance[];
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
