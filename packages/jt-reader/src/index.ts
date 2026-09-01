import { JtFormatError } from "./binaryReader.js";
import { parseJtContainer, readSegmentPayload } from "./container.js";
import { readJtMeshes } from "./geometry.js";
import { buildJtMeshInstances } from "./instances.js";
import { readLogicalElementSections } from "./logicalElements.js";
import { buildSceneGraph } from "./sceneGraph.js";
import {
  DEFAULT_JT_READ_LIMITS,
  type JtDocument,
  type JtReadLimits,
} from "./types.js";

export * from "./binaryReader.js";
export * from "./container.js";
export * from "./logicalElements.js";
export * from "./int32Codec.js";
export * from "./int32CodecV2.js";
export * from "./geometry.js";
export * from "./hash.js";
export * from "./instances.js";
export * from "./sceneGraph.js";
export * from "./topologyDecoder.js";
export * from "./types.js";

export async function readJt(
  input: Uint8Array | ArrayBuffer,
  limitOverrides: Partial<JtReadLimits> = {},
): Promise<JtDocument> {
  const limits: JtReadLimits = { ...DEFAULT_JT_READ_LIMITS, ...limitOverrides };
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const container = parseJtContainer(bytes, limits);
  const lsgSegment = container.segments.find((segment) => segment.id === container.header.lsgSegmentId);
  if (!lsgSegment) throw new JtFormatError("TOC 中找不到 LSG 数据段");
  const lsgBytes = await readSegmentPayload(container, lsgSegment, limits);
  const sections = readLogicalElementSections(lsgBytes, container.header.byteOrder, limits);
  const sceneGraph = buildSceneGraph(lsgBytes, sections, container.header.byteOrder, limits, container.header.majorVersion);
  const geometry = await readJtMeshes(container, limits);
  for (const mesh of geometry.meshes) {
    mesh.sceneNodeObjectIds = sceneGraph.nodes
      .filter((node) => node.lateLoadedSegments?.some((reference) => reference.id === mesh.segmentId))
      .map((node) => node.objectId);
  }
  const meshInstances = buildJtMeshInstances(sceneGraph, geometry.meshes);
  const warnings: string[] = [];
  if (sceneGraph.unknownElementTypeIds.length > 0) {
    warnings.push(`存在 ${sceneGraph.unknownElementTypeIds.length} 种尚未解释的 LSG 元素，已按长度安全跳过`);
  }
  warnings.push(...geometry.warnings);
  return { header: container.header, segments: container.segments, sceneGraph, meshes: geometry.meshes, meshInstances, warnings };
}
