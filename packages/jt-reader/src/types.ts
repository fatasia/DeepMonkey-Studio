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
