import { JtFormatError } from "./binaryReader.js";
import { parseJtContainer, readSegmentPayload } from "./container.js";
import { readJtMeshes } from "./geometry.js";
import { buildJtMeshInstances } from "./instances.js";
import { readLogicalElementSections } from "./logicalElements.js";
import { readJtPmi } from "./pmiSegment.js";
import { buildSceneGraph } from "./sceneGraph.js";
import {
  DEFAULT_JT_READ_LIMITS,
  type JtDocument,
  type JtLoss,
  type JtReadLimits,
} from "./types.js";

export * from "./binaryReader.js";
export * from "./errors.js";
export * from "./container.js";
export * from "./logicalElements.js";
export * from "./int32Codec.js";
export * from "./int32CodecV2.js";
export * from "./geometry.js";
export * from "./hash.js";
export * from "./instances.js";
export * from "./pmiSegment.js";
export * from "./sceneGraph.js";
export * from "./topologyDecoder.js";
export * from "./textureImage.js";
export * from "./types.js";

export async function readJt(
  input: Uint8Array | ArrayBuffer,
  limitOverrides: Partial<JtReadLimits> = {},
): Promise<JtDocument> {
  const limits: JtReadLimits = { ...DEFAULT_JT_READ_LIMITS, ...limitOverrides };
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const container = parseJtContainer(bytes, limits);
  const lsgSegment = container.segments.find((segment) => segment.id === container.header.lsgSegmentId);
  if (!lsgSegment) throw new JtFormatError("TOC 中找不到 LSG 数据段", "lsg-segment-missing");
  const lsgBytes = await readSegmentPayload(container, lsgSegment, limits);
  const sections = readLogicalElementSections(lsgBytes, container.header.byteOrder, limits);
  const sceneGraph = buildSceneGraph(lsgBytes, sections, container.header.byteOrder, limits, container.header.majorVersion);
  if (sceneGraph.nodes.some((node) => node.textureImages?.length)
      && (container.header.majorVersion !== 10 || container.header.minorVersion !== 3)) {
    throw new JtFormatError("JT 内联纹理当前仅以 10.3 样本验证，其他版本拒绝映射", "shape-version-unsupported");
  }
  const geometry = await readJtMeshes(container, limits);
  for (const mesh of geometry.meshes) {
    mesh.sceneNodeObjectIds = sceneGraph.nodes
      .filter((node) => node.lateLoadedSegments?.some((reference) => reference.id === mesh.segmentId))
      .map((node) => node.objectId);
  }
  const meshInstances = buildJtMeshInstances(sceneGraph, geometry.meshes);
  // PMI 数据段结构级清单:无 PMI 段或解析失败都不阻断主流程,失败以 warnings/losses 如实上报。
  const pmi = await readJtPmi(container, limits);
  const warnings: string[] = [];
  const losses: JtLoss[] = [];
  if (sceneGraph.unknownElementTypeIds.length > 0) {
    const detail = `存在 ${sceneGraph.unknownElementTypeIds.length} 种尚未解释的 LSG 元素，已按长度安全跳过`;
    warnings.push(detail);
    losses.push({ code: "lsg-element-uninterpreted", kind: "loss", scope: "document", detail });
  }
  warnings.push(...geometry.warnings);
  losses.push(...geometry.losses);
  warnings.push(...pmi.warnings);
  losses.push(...pmi.losses);
  // 文档级能力边界与源事实声明(code 稳定,供质量门禁机读;见 JT_LOSS_CODES 词表)。
  if (geometry.meshes.length > 0) {
    losses.push({
      code: "tessellation-only",
      kind: "known-limitation",
      scope: "document",
      detail: "JT 几何仅解码 TriStrip/TopoMesh 三角网格;B-Rep/精确曲面与隐藏线数据段不在解析范围(已知限制)",
    });
    if (geometry.meshes.every((mesh) => !mesh.uvs && !mesh.textureSets)) {
      losses.push({
        code: "uv-binding-absent",
        kind: "source-fact",
        scope: "document",
        detail: "全部已解码网格均无 UV/纹理集绑定(源文件事实,非解码缺陷)",
      });
    }
  } else if (geometry.candidateSegmentCount === 0) {
    losses.push({
      code: "mesh-segment-absent",
      kind: "source-fact",
      scope: "document",
      detail: "文件不含候选网格段(JT 9 类型 6 / JT 10 类型 7..16),无几何属源文件事实",
    });
  } else {
    losses.push({
      code: "no-mesh-decoded",
      kind: "loss",
      scope: "document",
      detail: "全部候选网格段均未解码出网格,文档仅剩结构/属性清单",
    });
  }
  if (pmi.segmentCount === 0) {
    losses.push({
      code: "pmi-segment-absent",
      kind: "source-fact",
      scope: "document",
      detail: "文件不含 PMI(type 3)数据段,pmi 节省略属源文件事实",
    });
  } else if (pmi.pmi) {
    losses.push({
      code: "pmi-structure-only",
      kind: "known-limitation",
      scope: "document",
      detail: "PMI 仅输出结构级清单,标注/尺寸/文本语义解析未实现(已知限制)",
    });
  }
  return {
    header: container.header,
    segments: container.segments,
    sceneGraph,
    meshes: geometry.meshes,
    meshInstances,
    ...(pmi.pmi ? { pmi: pmi.pmi } : {}),
    losses,
    warnings,
  };
}
