export interface BuiltinJtRequest { sourcePath: string; outputDir: string; sourceName: string }
export interface BuiltinJtResult {
  inspection: {
    header: { majorVersion: number; minorVersion: number };
    toc: { entryCount: number };
    assembly: { nodeCount: number };
    /** 源文件是否含已解析成功的 PMI 数据段(结构级);无 PMI 段或解析失败为 false。 */
    pmiPresent?: boolean;
  };
  result?: {
    meshCount: number;
    instanceCount: number;
    triangleCount: number;
    decodedAttributes?: { uvs: boolean; colors: boolean; textureSetCount?: number };
  };
}
export function isBuiltinJtResult(value: unknown): value is BuiltinJtResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as BuiltinJtResult;
  const counts = [candidate.inspection?.header?.majorVersion, candidate.inspection?.header?.minorVersion,
    candidate.inspection?.toc?.entryCount, candidate.inspection?.assembly?.nodeCount];
  if (candidate.inspection?.pmiPresent !== undefined && typeof candidate.inspection.pmiPresent !== "boolean") return false;
  if (candidate.result !== undefined) {
    counts.push(candidate.result?.meshCount, candidate.result?.instanceCount, candidate.result?.triangleCount);
    if (candidate.result?.decodedAttributes !== undefined) {
      const decoded = candidate.result.decodedAttributes;
      if (typeof decoded.uvs !== "boolean" || typeof decoded.colors !== "boolean") return false;
      if (decoded.textureSetCount !== undefined && (!Number.isSafeInteger(decoded.textureSetCount) || decoded.textureSetCount < 0)) return false;
    }
  }
  return counts.every(value => Number.isSafeInteger(value) && value >= 0);
}
