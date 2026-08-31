import { useEffect, useState } from "react";
import type { PprBopVersion } from "@bim-studio/contracts";
import { api } from "../api";
import { createPprPlanDraft, type PprPlanReferenceContext } from "./pprPlanTemplate";

export function usePprPlanController(projectId: string, references: PprPlanReferenceContext) {
  const [versions, setVersions] = useState<PprBopVersion[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState("");
  const planId = `pd-lite-${projectId}`;
  const planVersions = versions.filter((version) => version.planId === planId);

  useEffect(() => {
    void loadPprPlanVersions(projectId, setVersions, setError);
  }, [projectId]);

  async function saveVersion() {
    setBusy(true);
    setError("");
    try {
      const saved = await api.createPprBopVersion(
        projectId,
        createPprPlanDraft(projectId, references, planVersions.at(-1)?.id),
      );
      const analysis = await api.analyzePprBopVersion(projectId, saved.id);
      setVersions((current) => [...current, saved]);
      setSummary(`已保存 ${saved.version}：关键路径 ${analysis.criticalPath.durationMinutes} 分钟，${analysis.issues.length} 项检查。`);
    } catch (saveError) {
      setError(messageOf(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function compareLatest() {
    const after = planVersions.at(-1);
    const before = planVersions.at(-2);
    if (!before || !after) return;
    setBusy(true);
    setError("");
    try {
      const comparison = await api.comparePprBopVersions(projectId, before.id, after.id);
      setSummary(`${before.version} → ${after.version}：${comparison.changes.length} 项变更，${comparison.regressions.length} 项退化。`);
    } catch (compareError) {
      setError(messageOf(compareError));
    } finally {
      setBusy(false);
    }
  }

  return { versions: planVersions, busy, error, summary, saveVersion, compareLatest };
}

async function loadPprPlanVersions(projectId: string, setVersions: (versions: PprBopVersion[]) => void, setError: (error: string) => void): Promise<void> {
  try {
    setVersions(await api.listPprBopVersions(projectId));
  } catch (error) {
    setError(messageOf(error));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "工艺计划请求失败";
}
