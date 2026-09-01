import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { probeXtFileStructure } from "./industrialFormatProbe.js";
import {
  parseXtRevolvedSubset,
  UnsupportedXtTextSubsetError,
  XT_TEXT_SUBSET_MAX_BYTES,
  type XtRevolvedSubset,
} from "./xtTextSubsetParser.js";
import { probeXtStructure, XT_MAX_SAMPLE_BYTES, type XtHeaderMetadata, type XtStructureProbeResult } from "./xtStructureProbe.js";

export interface XtTextInspectionResult {
  status: "invalid" | "structure-read" | "geometry-supported";
  recognizedFormat: "parasolid-x_t";
  inspectionScope: "header-capability-and-verified-subset";
  geometryParsed: boolean;
  sourceBytes: number;
  schema?: string;
  modellerVersion?: string;
  header: XtHeaderMetadata;
  topology: {
    bodies: { status: "decoded" | "not-decoded"; count?: number; reason?: string };
    faces: { status: "decoded" | "not-decoded"; count?: number; reason?: string };
    shells: { status: "not-decoded"; reason: string };
    assembly: { status: "not-decoded"; reason: string };
  };
  metadata: {
    header: "decoded" | "not-decoded";
    entityNames: "not-decoded";
    colors: "not-decoded";
    properties: "header-only" | "not-decoded";
    reason: string;
  };
  geometry: {
    status: "decoded-revolved-subset" | "not-decoded";
    capabilityId?: "x-t-v24.1-coaxial-revolved-part";
    surfaceTypes?: readonly ["plane", "cylinder", "cone", "torus"];
    reason: string;
  };
  issues: readonly { code: string; message: string }[];
  limitations: readonly string[];
}

/**
 * 读取 X_T 头与已签署几何子集。其他版本仍返回可审计的结构结果，
 * 但不会猜测 body、shell、装配、名称、颜色或属性关系。
 */
export async function inspectXtTextFile(filePath: string): Promise<XtTextInspectionResult> {
  const sourceSize = (await stat(filePath)).size;
  const probe = await probeXtFileStructure(filePath, "x_t");
  const source = sourceSize > 0 && sourceSize <= XT_TEXT_SUBSET_MAX_BYTES
    ? await readFile(filePath)
    : undefined;
  return buildInspection(sourceSize, probe, source);
}

export function inspectXtTextBytes(source: Uint8Array): XtTextInspectionResult {
  const probe = probeXtStructure({
    fileSize: source.byteLength,
    sampleBytes: source.subarray(0, XT_MAX_SAMPLE_BYTES),
    expectedFormat: "x_t",
  });
  return buildInspection(source.byteLength, probe, source);
}

export async function writeXtTextInspectionArtifact(
  sourcePath: string,
  outputDir: string,
): Promise<XtTextInspectionResult> {
  const inspection = await inspectXtTextFile(sourcePath);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "inspection.json"), JSON.stringify(inspection, null, 2), "utf8");
  return inspection;
}

function buildInspection(
  sourceBytes: number,
  probe: XtStructureProbeResult,
  source?: Uint8Array,
): XtTextInspectionResult {
  const header = probe.header ?? {};
  const schema = probe.version?.raw;
  const invalidReason = invalidProbeReason(probe);
  if (invalidReason) return baseInspection("invalid", sourceBytes, probe, header, invalidReason);

  if (!source) {
    return baseInspection(
      "structure-read",
      sourceBytes,
      probe,
      header,
      `文件超过内部几何子集 ${XT_TEXT_SUBSET_MAX_BYTES} 字节上限；仅完成有限头部读取`,
    );
  }
  try {
    const subset = parseXtRevolvedSubset(source);
    return supportedInspection(sourceBytes, probe, subset);
  } catch (reason) {
    const message = reason instanceof UnsupportedXtTextSubsetError
      ? reason.message
      : "X_T 几何子集检查失败";
    return baseInspection("structure-read", sourceBytes, probe, header, message);
  }
}

function supportedInspection(
  sourceBytes: number,
  probe: XtStructureProbeResult,
  subset: XtRevolvedSubset,
): XtTextInspectionResult {
  return {
    status: "geometry-supported",
    recognizedFormat: "parasolid-x_t",
    inspectionScope: "header-capability-and-verified-subset",
    geometryParsed: true,
    sourceBytes,
    schema: subset.schema,
    ...(probe.version?.modellerVersion ? { modellerVersion: probe.version.modellerVersion } : {}),
    header: subset.header,
    topology: {
      bodies: { status: "decoded", count: subset.bodyCount },
      faces: { status: "decoded", count: subset.faceCount },
      shells: { status: "not-decoded", reason: "当前真实样本没有独立 shell 映射证据" },
      assembly: { status: "not-decoded", reason: "当前子集不解析装配实例与变换" },
    },
    metadata: {
      header: "decoded",
      entityNames: "not-decoded",
      colors: "not-decoded",
      properties: "header-only",
      reason: "仅文件头字段可追溯；实体名称、颜色和属性绑定没有公开 schema 与真实样本证据",
    },
    geometry: {
      status: "decoded-revolved-subset",
      capabilityId: "x-t-v24.1-coaxial-revolved-part",
      surfaceTypes: ["plane", "cylinder", "cone", "torus"],
      reason: "命中真实样本签署的单 body 共轴封闭旋转件拓扑",
    },
    issues: probe.issues,
    limitations: subset.limitations,
  };
}

function baseInspection(
  status: "invalid" | "structure-read",
  sourceBytes: number,
  probe: XtStructureProbeResult,
  header: XtHeaderMetadata,
  reason: string,
): XtTextInspectionResult {
  return {
    status,
    recognizedFormat: "parasolid-x_t",
    inspectionScope: "header-capability-and-verified-subset",
    geometryParsed: false,
    sourceBytes,
    ...(probe.version?.raw ? { schema: probe.version.raw } : {}),
    ...(probe.version?.modellerVersion ? { modellerVersion: probe.version.modellerVersion } : {}),
    header,
    topology: {
      bodies: { status: "not-decoded", reason: "未读取通用 body 拓扑；不能推断单体或多 body" },
      faces: { status: "not-decoded", reason: "未读取通用 face 拓扑" },
      shells: { status: "not-decoded", reason: "未读取 shell 关系；不能推断单 shell 或多 shell" },
      assembly: { status: "not-decoded", reason: "未读取装配实例、层级或变换" },
    },
    metadata: {
      header: probe.status === "header-recognized" ? "decoded" : "not-decoded",
      entityNames: "not-decoded",
      colors: "not-decoded",
      properties: probe.status === "header-recognized" ? "header-only" : "not-decoded",
      reason: "实体名称、颜色与属性绑定需要版本对应 schema；当前只返回文件头元数据",
    },
    geometry: { status: "not-decoded", reason },
    issues: probe.issues,
    limitations: [
      "未知 schema 或拓扑明确拒绝，不生成包围盒、占位体或替代几何",
      "多 body、多 shell、装配、NURBS、trim、PMI 与实体元数据绑定尚未实现",
      "结构识别不等于可浏览、可转换或生产兼容",
    ],
  };
}

function invalidProbeReason(probe: XtStructureProbeResult): string | undefined {
  if (probe.status !== "header-recognized") return probe.issues[0]?.message ?? "未识别 X_T 文本头";
  if (probe.recognizedFormat !== "parasolid-x_t" || probe.encoding !== "text") return "文件内容不是 Parasolid X_T 文本传输流";
  return probe.issues.length > 0 ? probe.issues.map((item) => item.message).join("；") : undefined;
}
