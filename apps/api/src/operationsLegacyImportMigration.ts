import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { OperationsDocument } from "./operations.js";

/** 旧版跨产品同步记录退出活动项目；先完整归档，再由调用者原子保存新状态。 */
export async function archiveLegacyOperationsImports(dataDir: string, document: OperationsDocument): Promise<boolean> {
  const original = JSON.stringify(document, null, 2);
  let changed = false;
  for (const project of Object.values(document.projects)) {
    const removed = new Set(project.models.filter(model => String(model.source) === "iot-nb").map(model => model.id));
    if (!removed.size) continue;
    changed = true;
    // 传递清理模型、部署、评估、工单和验证记录之间的旧引用，不影响项目内独立数据。
    let previousSize = -1;
    while (previousSize !== removed.size) {
      previousSize = removed.size;
      for (const records of Object.values(project)) {
        if (!Array.isArray(records)) continue;
        for (const record of records) {
          const references = [record.modelId, record.deploymentId, ...(record.sourceRefs ?? [])];
          if (references.some(reference => removed.has(reference))) removed.add(record.id);
        }
      }
    }
    for (const key of Object.keys(project) as Array<keyof typeof project>) {
      const records = project[key];
      if (Array.isArray(records)) Object.assign(project, { [key]: records.filter(record => !removed.has(record.id)) });
    }
  }
  if (!changed) return false;
  const fingerprint = createHash("sha256").update(original).digest("hex").slice(0, 16);
  try {
    await writeFile(path.join(dataDir, `operations-legacy-imports-${fingerprint}.archive.json`), `${original}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return true;
}
