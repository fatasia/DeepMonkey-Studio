export interface BuiltinJtRequest { sourcePath: string; outputDir: string; sourceName: string }
export interface BuiltinJtResult {
  inspection: { header: { majorVersion: number; minorVersion: number }; toc: { entryCount: number }; assembly: { nodeCount: number } };
  result?: { meshCount: number; instanceCount: number; triangleCount: number; decodedAttributes?: { uvs: boolean; colors: boolean } };
}
export function isBuiltinJtResult(value: unknown): value is BuiltinJtResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as BuiltinJtResult;
  const counts = [candidate.inspection?.header?.majorVersion, candidate.inspection?.header?.minorVersion,
    candidate.inspection?.toc?.entryCount, candidate.inspection?.assembly?.nodeCount];
  if (candidate.result !== undefined) {
    counts.push(candidate.result?.meshCount, candidate.result?.instanceCount, candidate.result?.triangleCount);
    if (candidate.result?.decodedAttributes !== undefined) {
      const decoded = candidate.result.decodedAttributes;
      if (typeof decoded.uvs !== "boolean" || typeof decoded.colors !== "boolean") return false;
    }
  }
  return counts.every(value => Number.isSafeInteger(value) && value >= 0);
}
