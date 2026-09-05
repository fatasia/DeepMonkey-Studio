import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { DashboardFieldProduct } from "./dashboardFieldBinding";

export function useDashboardFieldCatalog(projectId: string, enabled: boolean) {
  const [products, setProducts] = useState<DashboardFieldProduct[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const loaded = useRef(false);
  const inFlight = useRef(new Set<string>());
  const refresh = useCallback(async () => {
    const request = ++epoch.current;
    inFlight.current.clear();
    setStatus("loading");
    setError("");
    setProducts([]);
    try {
      const [datasets, pipelines] = await Promise.all([api.listDatasets(projectId), api.listDataPipelines(projectId)]);
      if (request !== epoch.current) return;
      setProducts([
        ...datasets.map((dataset): DashboardFieldProduct => ({
          key: `dataset:${dataset.id}`, name: dataset.name, status: "ready",
          fields: [...new Map([...dataset.fields, ...(dataset.computedFields ?? [])].map((field) => [field.key, field])).values()],
        })),
        ...pipelines.map((pipeline): DashboardFieldProduct => ({ key: `pipeline:${pipeline.id}`, name: pipeline.name, fields: [], status: "idle" })),
      ]);
      setStatus("ready");
    } catch (failure) {
      if (request !== epoch.current) return;
      setError(failure instanceof Error ? failure.message : "数据目录读取失败");
      setStatus("error");
    }
  }, [projectId]);

  useEffect(() => {
    loaded.current = false;
    return () => { epoch.current += 1; inFlight.current.clear(); };
  }, [projectId]);
  useEffect(() => {
    if (!enabled || loaded.current) return;
    loaded.current = true;
    void refresh();
  }, [enabled, refresh]);

  const loadPipeline = useCallback(async (productKey: string) => {
    if (!productKey.startsWith("pipeline:") || inFlight.current.has(productKey)) return;
    const request = epoch.current;
    inFlight.current.add(productKey);
    setProducts((current) => current.map((product) => product.key === productKey ? { ...product, status: "loading", error: undefined } : product));
    try {
      const preview = await api.previewDataPipeline(projectId, productKey.slice(9));
      if (request !== epoch.current) return;
      if (preview.status === "error") throw new Error(preview.error || "管道输出字段读取失败");
      setProducts((current) => current.map((product) => product.key === productKey ? { ...product, fields: preview.fields, status: "ready" } : product));
    } catch (failure) {
      if (request !== epoch.current) return;
      setProducts((current) => current.map((product) => product.key === productKey ? { ...product, status: "error", error: failure instanceof Error ? failure.message : "字段获取失败" } : product));
    } finally {
      if (request === epoch.current) inFlight.current.delete(productKey);
    }
  }, [projectId]);
  return { products, status, error, refresh, loadPipeline };
}
