import { useEffect, useMemo, useRef, useState } from "react";
import type { PprBopVersion, PprBopVersionDraft } from "@bim-studio/contracts";
import type { PprAnalysis } from "@bim-studio/ppr-lite-engine";
import { api } from "../api";
import {
  analyzePprPlanDraft,
  clonePprVersionAsDraft,
  collectPprPlanVariantIds,
  createEmptyPprPlanDraft,
  hasPersistablePprContent,
  type PprPlanReferenceContext,
} from "./pprPlanDraftModel";
import {
  bindPprVersionComparison,
  currentPprVersionComparison,
  type PprBoundVersionComparison,
} from "./pprPlanComparison";

export type PprPlanBusyAction = "loading" | "saving" | "analyzing" | "comparing";

export function usePprPlanController(projectId: string, references: PprPlanReferenceContext) {
  const [versions, setVersions] = useState<PprBopVersion[]>([]);
  const [draft, setDraftState] = useState<PprBopVersionDraft>(() => createEmptyPprPlanDraft(projectId, references));
  const [dirty, setDirty] = useState(false);
  const [busyAction, setBusyAction] = useState<PprPlanBusyAction | undefined>("loading");
  const [error, setError] = useState("");
  const [summary, setSummary] = useState("");
  const [analysis, setAnalysis] = useState<PprAnalysis>();
  const [analysisVersionId, setAnalysisVersionId] = useState<string>();
  const [analysisLabel, setAnalysisLabel] = useState("草稿实时分析");
  const [comparison, setComparison] = useState<PprBoundVersionComparison>();
  const [requestedVariantId, setRequestedVariantId] = useState("");
  const [beforeVersionId, setBeforeVersionIdState] = useState("");
  const [afterVersionId, setAfterVersionIdState] = useState("");
  const referencesRef = useRef(references);
  referencesRef.current = references;
  const planId = `pd-lite-${projectId}`;

  useEffect(() => {
    let active = true;
    setBusyAction("loading");
    setError("");
    void api.listPprBopVersions(projectId).then((records) => {
      if (!active) return;
      const planVersions = records
        .filter((version) => version.planId === planId)
        .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
      const latest = planVersions.at(-1);
      setVersions(planVersions);
      setDraftState(latest ? clonePprVersionAsDraft(latest) : createEmptyPprPlanDraft(projectId, referencesRef.current));
      setDirty(false);
      setAnalysis(undefined);
      setAnalysisVersionId(undefined);
      setAnalysisLabel("草稿实时分析");
      setComparison(undefined);
      setRequestedVariantId("");
      setBeforeVersionIdState(planVersions.at(-2)?.id ?? "");
      setAfterVersionIdState(latest?.id ?? "");
    }).catch((loadError) => {
      if (active) setError(messageOf(loadError));
    }).finally(() => {
      if (active) setBusyAction(undefined);
    });
    return () => { active = false; };
  }, [planId, projectId]);

  const availableVariantIds = useMemo(() => collectPprPlanVariantIds(draft), [draft]);
  const activeVariantId = availableVariantIds.includes(requestedVariantId) ? requestedVariantId : "";
  const draftAnalysis = useMemo(
    () => analyzePprPlanDraft(draft, activeVariantId || undefined),
    [activeVariantId, draft],
  );
  const fullDraftAnalysis = useMemo(() => analyzePprPlanDraft(draft), [draft]);
  const validationErrorCount = fullDraftAnalysis.issues.filter((issue) => issue.severity === "error").length;
  const analysisValidationErrorCount = analysis
    ? analysis.issues.filter((issue) => issue.severity === "error").length
    : validationErrorCount;
  const canSave = hasPersistablePprContent(draft)
    && validationErrorCount === 0
    && (dirty || versions.length === 0)
    && !busyAction;

  function setDraft(next: PprBopVersionDraft) {
    setDraftState(next);
    setDirty(true);
    setAnalysis(undefined);
    setAnalysisVersionId(undefined);
    setAnalysisLabel("草稿实时分析");
    setError("");
  }

  function cloneVersion(versionId: string) {
    const version = versions.find((item) => item.id === versionId);
    if (!version || !confirmDraftReplacement(dirty)) return;
    setDraftState(clonePprVersionAsDraft(version));
    setDirty(false);
    setAnalysis(undefined);
    setAnalysisVersionId(undefined);
    setAnalysisLabel("草稿实时分析");
    setError("");
    setSummary(`已从 ${version.version} 创建隔离草稿；保存后会追加新版本。`);
  }

  async function saveVersion() {
    if (!hasPersistablePprContent(draft)) {
      setError("至少需要一个产品/BOM 节点和一道工序，才能形成可追溯版本。");
      return;
    }
    if (validationErrorCount > 0) {
      setError(`草稿仍有 ${validationErrorCount} 项校验错误，请先修正后再保存。`);
      return;
    }
    setBusyAction("saving");
    setError("");
    let saved: PprBopVersion;
    try {
      saved = await api.createPprBopVersion(projectId, draft);
    } catch (saveError) {
      setError(messageOf(saveError));
      setBusyAction(undefined);
      return;
    }

    const previousLatest = versions.at(-1);
    setVersions((current) => [...current, saved]);
    setDraftState(clonePprVersionAsDraft(saved));
    setDirty(false);
    setAnalysis(undefined);
    setAnalysisVersionId(undefined);
    setBeforeVersionIdState(previousLatest?.id ?? "");
    setAfterVersionIdState(saved.id);
    setComparison(undefined);
    try {
      const serverAnalysis = await api.analyzePprBopVersion(projectId, saved.id, activeVariantId || undefined);
      setAnalysis(serverAnalysis);
      setAnalysisVersionId(saved.id);
      setAnalysisLabel(`${saved.version} · 服务端分析`);
      if (previousLatest) {
        try {
          const automaticComparison = await api.comparePprBopVersions(projectId, previousLatest.id, saved.id, activeVariantId || undefined);
          setComparison(bindPprVersionComparison(previousLatest.id, saved.id, automaticComparison, activeVariantId));
          setSummary(`已追加 ${saved.version}：关键路径 ${serverAnalysis.criticalPath.durationMinutes} 分钟，较上版 ${automaticComparison.changes.length} 项变更、${automaticComparison.regressions.length} 项退化。`);
        } catch (compareError) {
          setSummary(`已追加 ${saved.version}：关键路径 ${serverAnalysis.criticalPath.durationMinutes} 分钟；自动影响比较暂未返回。`);
          setError(messageOf(compareError));
        }
      } else {
        setSummary(`已追加 ${saved.version}：关键路径 ${serverAnalysis.criticalPath.durationMinutes} 分钟，${serverAnalysis.issues.length} 项检查。`);
      }
    } catch (analysisError) {
      setSummary(`已追加 ${saved.version}，但服务端分析暂未返回。`);
      setError(messageOf(analysisError));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function analyzeVersion(versionId: string) {
    const version = versions.find((item) => item.id === versionId);
    if (!version) return;
    setBusyAction("analyzing");
    setError("");
    try {
      setAnalysis(await api.analyzePprBopVersion(projectId, version.id, activeVariantId || undefined));
      setAnalysisVersionId(version.id);
      setAnalysisLabel(`${version.version} · 服务端分析`);
      setSummary(`已重新分析 ${version.version}，未修改历史快照。`);
    } catch (analysisError) {
      setError(messageOf(analysisError));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function compareVersions() {
    if (!beforeVersionId || !afterVersionId || beforeVersionId === afterVersionId) {
      setError("请选择同一计划中的两个不同版本进行比较。");
      return;
    }
    setBusyAction("comparing");
    setError("");
    const requestedBeforeVersionId = beforeVersionId;
    const requestedAfterVersionId = afterVersionId;
    try {
      const result = await api.comparePprBopVersions(projectId, requestedBeforeVersionId, requestedAfterVersionId, activeVariantId || undefined);
      setComparison(bindPprVersionComparison(requestedBeforeVersionId, requestedAfterVersionId, result, activeVariantId));
      setSummary(`版本比较完成：${result.changes.length} 项变更，${result.regressions.length} 项退化。`);
    } catch (compareError) {
      setError(messageOf(compareError));
    } finally {
      setBusyAction(undefined);
    }
  }

  function setBeforeVersionId(versionId: string) {
    setBeforeVersionIdState(versionId);
    setComparison(undefined);
    setError("");
  }

  function setAfterVersionId(versionId: string) {
    setAfterVersionIdState(versionId);
    setComparison(undefined);
    setError("");
  }

  function setActiveVariantId(variantId: string) {
    setRequestedVariantId(variantId);
    setAnalysis(undefined);
    setAnalysisVersionId(undefined);
    setAnalysisLabel("草稿实时分析");
    setComparison(undefined);
    setError("");
    setSummary(variantId ? `已切换到 ${variantId} 变体分析；自由条件仍保留为待解析证据。` : "已切换到全部变体分析。");
  }

  const visibleComparison = currentPprVersionComparison(comparison, beforeVersionId, afterVersionId, activeVariantId);

  return {
    versions,
    draft,
    draftAnalysis,
    analysis: analysis ?? draftAnalysis,
    analysisPlan: analysisVersionId ? versions.find((version) => version.id === analysisVersionId) ?? draft : draft,
    analysisLabel: analysis ? analysisLabel : "草稿实时分析",
    comparison: visibleComparison,
    availableVariantIds,
    activeVariantId,
    beforeVersionId,
    afterVersionId,
    dirty,
    busyAction,
    error,
    summary,
    validationErrorCount,
    analysisValidationErrorCount,
    canSave,
    setDraft,
    setBeforeVersionId,
    setAfterVersionId,
    setActiveVariantId,
    cloneVersion,
    saveVersion,
    analyzeVersion,
    compareVersions,
  };
}

function confirmDraftReplacement(dirty: boolean): boolean {
  return !dirty || typeof window === "undefined" || window.confirm("当前草稿有未保存更改，仍要用所选版本替换吗？");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "工艺计划请求失败";
}
