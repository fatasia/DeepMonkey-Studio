import { useEffect, useState } from "react";
import type { DataDatasetRecord } from "@bim-studio/contracts";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import { sourceFromSettled, type AssistantContextSource } from "./assistantReliability";
import { buildAskDataSemanticContext } from "./dataSemanticContext";

interface AiProjectContextState {
  platformContext: Record<string, unknown>;
  contextSources: AssistantContextSource[];
  datasets: DataDatasetRecord[];
  platformLoaded: boolean;
  projectMissing: boolean;
}

/**
 * 汇总助手允许读取的项目快照。单个来源失败时保留其他来源，并把失败状态交给界面披露。
 */
export function useAiProjectContext(projectId: string | undefined, locale: AppLocale): AiProjectContextState {
  const [platformContext, setPlatformContext] = useState<Record<string, unknown>>({ status: "loading" });
  const [contextSources, setContextSources] = useState<AssistantContextSource[]>([]);
  const [datasets, setDatasets] = useState<DataDatasetRecord[]>([]);

  useEffect(() => {
    if (!projectId) {
      setPlatformContext({ status: "no-project" });
      setContextSources([]);
      setDatasets([]);
      return;
    }
    setPlatformContext({ status: "loading" });
    setContextSources([]);
    let cancelled = false;
    void Promise.allSettled([
      api.getOperations(projectId),
      api.listVisionModels(projectId),
      api.listVisionSources(projectId),
      api.listVisionTasks(projectId),
      api.listVisionEvents(projectId, 50),
      api.listDataConnections(projectId),
      api.listDatasets(projectId),
    ]).then(([operations, visionModels, visionSources, visionTasks, visionEvents, connections, datasetResult]) => {
      if (cancelled) return;
      const value = <T,>(result: PromiseSettledResult<T>, fallback: T): T =>
        result.status === "fulfilled" ? result.value : fallback;
      const operationValue = value(operations, undefined);
      const datasetValues = value(datasetResult, []);
      const sources = [
        sourceFromSettled("operations", tr(locale, "运营模型与评估", "Operations models and assessments"), operations, (item) =>
          item ? item.models.length + item.assessments.length + item.cases.length : 0,
        ),
        sourceFromSettled("vision-models", tr(locale, "视觉模型", "Vision models"), visionModels, (items) => items.length),
        sourceFromSettled("vision-sources", tr(locale, "视觉数据源", "Vision sources"), visionSources, (items) => items.length),
        sourceFromSettled("vision-tasks", tr(locale, "视觉任务", "Vision tasks"), visionTasks, (items) => items.length),
        sourceFromSettled("vision-events", tr(locale, "视觉事件", "Vision events"), visionEvents, (items) => items.length),
        sourceFromSettled("connections", tr(locale, "数据连接", "Data connections"), connections, (items) => items.length),
        sourceFromSettled("datasets", tr(locale, "数据集", "Datasets"), datasetResult, (items) => items.length),
      ];
      setDatasets(datasetValues);
      setContextSources(sources);
      setPlatformContext({
        loadedAt: new Date().toISOString(),
        contextTrust: "client-snapshot",
        sourceStatus: sources,
        operations: operationValue
          ? {
              models: operationValue.models.map((item) => ({
                id: item.id,
                name: item.name,
                version: item.version,
                algorithm: item.algorithm,
                engine: item.artifact.engine,
                status: item.status,
                benchmarkOnly: item.benchmarkOnly,
                productionEligible: item.productionEligible,
                trainRows: item.trainRows,
                validationRows: item.validationRows,
                metrics: item.metrics,
                updatedAt: item.updatedAt,
              })),
              deployments: operationValue.deployments.slice(0, 20),
              assessments: operationValue.assessments.slice(0, 20),
              cases: operationValue.cases.slice(0, 20),
              logisticsExperiments: operationValue.logisticsExperiments.slice(0, 10),
              energyInsights: operationValue.energyInsights.slice(0, 10),
            }
          : { unavailable: true },
        vision: {
          models: value(visionModels, []),
          sources: value(visionSources, []),
          tasks: value(visionTasks, []),
          events: value(visionEvents, []),
        },
        data: {
          connections: value(connections, []),
          datasets: datasetValues,
          askDataSemanticContext: buildAskDataSemanticContext(datasetValues),
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [locale, projectId]);

  return {
    platformContext,
    contextSources,
    datasets,
    platformLoaded: Boolean((platformContext as { loadedAt?: string }).loadedAt),
    projectMissing: (platformContext as { status?: string }).status === "no-project",
  };
}
