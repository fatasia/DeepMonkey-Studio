import { open } from "node:fs/promises";
import {
  JT_MAX_HEADER_SAMPLE_BYTES,
  JT_MAX_TOC_SAMPLE_BYTES,
  probeJtStructure,
  type JtStructureProbeResult,
} from "./jtStructureProbe.js";
import { XT_MAX_SAMPLE_BYTES, probeXtStructure, type XtExpectedFormat, type XtStructureProbeResult } from "./xtStructureProbe.js";

export type IndustrialStructureProbeResult = JtStructureProbeResult | XtStructureProbeResult;
export type IndustrialStructureProbeFormat = "jt" | XtExpectedFormat;

/**
 * 对磁盘中的 JT 文件执行有限范围读取，避免为结构识别把大型工业模型整体载入内存。
 * 返回值始终保持 structure-only，不能据此宣称已解析几何、装配或 PMI。
 */
export async function probeJtFileStructure(filePath: string): Promise<JtStructureProbeResult> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const headerBytes = await readRange(handle, 0, Math.min(size, JT_MAX_HEADER_SAMPLE_BYTES));
    const header = probeJtStructure({ fileSize: size, headerBytes });
    const tocOffset = header.toc?.offset;
    if (header.status !== "header-recognized" || tocOffset === undefined) return header;

    const tocBytes = await readRange(handle, tocOffset, Math.min(JT_MAX_TOC_SAMPLE_BYTES, size - tocOffset));
    return probeJtStructure({
      fileSize: size,
      headerBytes,
      tocSample: { offset: tocOffset, bytes: tocBytes },
    });
  } finally {
    await handle.close();
  }
}

/** 统一的本地工业格式结构探测入口；所有分支都只返回有限样本证据。 */
export async function probeIndustrialFileStructure(filePath: string, format: IndustrialStructureProbeFormat): Promise<IndustrialStructureProbeResult> {
  if (format === "jt") return probeJtFileStructure(filePath);
  return probeXtFileStructure(filePath, format);
}

export async function probeXtFileStructure(filePath: string, expectedFormat: XtExpectedFormat): Promise<XtStructureProbeResult> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    return probeXtStructure({
      fileSize: size,
      expectedFormat,
      sampleBytes: await readRange(handle, 0, Math.min(size, XT_MAX_SAMPLE_BYTES)),
    });
  } finally {
    await handle.close();
  }
}

async function readRange(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0) {
    throw new Error("工业格式探测读取范围无效");
  }
  const bytes = new Uint8Array(length);
  const { bytesRead } = await handle.read(bytes, 0, length, position);
  return bytesRead === length ? bytes : bytes.subarray(0, bytesRead);
}
