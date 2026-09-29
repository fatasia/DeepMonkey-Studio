import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OntologyGraphQuery, OntologyGraphResult, OntologyPackage } from "@bim-studio/contracts";
import { api } from "../api";
import { ontologySaveErrors } from "./ontologyWorkspaceLogic";

/**
 * H-C4-P1 图谱视图状态：包列表加载 → 图查询（1—3 跳 BFS）→ 结果/错误/观测。
 * 纪律：
 * - 深度/方向/关系类型变化即重查（服务端裁剪，禁止大图一次性加载）；
 * - 请求带 epoch 令牌：旧响应不落状态（连点深度按钮不串图）；
 * - 检查器明细直接消费包全量（listOntologyPackages 返回完整包，不额外请求）。
 */
export function useOntologyGraph(projectId: string) {
  const [packages, setPackages] = useState<OntologyPackage[]>([]);
  const [packagesStatus, setPackagesStatus] = useState<"loading" | "ready" | "error">("loading");
  const [packagesErrors, setPackagesErrors] = useState<string[]>([]);
  const [selectedPackageId, setSelectedPackageId] = useState<string>();

  const [depth, setDepth] = useState<1 | 2 | 3>(1);
  const [direction, setDirection] = useState<"out" | "in" | "both">("both");
  const [relationTypes, setRelationTypes] = useState<ReadonlySet<string>>(new Set());
  const [includeActions, setIncludeActions] = useState(true);
  const [includeEvents, setIncludeEvents] = useState(true);
  const [includeDatasets, setIncludeDatasets] = useState(true);

  const [graph, setGraph] = useState<OntologyGraphResult>();
  const [graphStatus, setGraphStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [graphErrors, setGraphErrors] = useState<string[]>([]);
  /** 当前图根：selectRoot 后锁定，切深度/方向/关系筛选保持稳定；切包重置。 */
  const [currentRoot, setCurrentRoot] = useState<OntologyGraphQuery["root"]>();
  const alive = useRef(true);
  const epoch = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const loadPackages = useCallback(async () => {
    setPackagesStatus("loading");
    setPackagesErrors([]);
    try {
      const list = await api.listOntologyPackages(projectId);
      if (!alive.current) return;
      setPackages(list);
      setPackagesStatus("ready");
      setSelectedPackageId((current) => {
        if (current && list.some((item) => item.id === current)) return current;
        // 默认选已发布包（图谱优先展示已发布事实），否则回落第一个
        return (list.find((item) => item.status === "published") ?? list[0])?.id;
      });
    } catch (error) {
      if (!alive.current) return;
      setPackagesErrors(ontologySaveErrors(error));
      setPackagesStatus("error");
    }
  }, [projectId]);

  useEffect(() => { void loadPackages(); }, [loadPackages]);

  const selectedPackage = packages.find((item) => item.id === selectedPackageId);

  const relationKeys = useMemo(
    () => [...new Set(selectedPackage?.relations.map((relation) => relation.key) ?? [])].sort((a, b) => a.localeCompare(b)),
    [selectedPackage],
  );

  const runQuery = useCallback(async (overrides?: Partial<Pick<OntologyGraphQuery, "depth" | "direction">>) => {
    if (!selectedPackageId) return;
    const request = ++epoch.current;
    setGraphStatus("loading");
    setGraphErrors([]);
    try {
      // root 优先级：锁定根 → 包内首个对象 → 首个行动 → 首个事件；全空 = 空态不请求
      const pkg = packages.find((item) => item.id === selectedPackageId);
      const rootObject = pkg?.objects[0]?.key;
      const rootAction = pkg?.actions[0]?.key;
      const rootEvent = pkg?.events[0]?.key;
      if (!pkg || (!rootObject && !rootAction && !rootEvent)) {
        setGraph(undefined);
        setGraphStatus("ready");
        return;
      }
      const fallbackRoot = rootObject
        ? ({ type: "object", id: rootObject } as const)
        : rootAction
          ? ({ type: "action", id: rootAction } as const)
          : ({ type: "event", id: rootEvent! } as const);
      const root = currentRoot ?? fallbackRoot;
      const nextDepth = overrides?.depth ?? depth;
      const nextDirection = overrides?.direction ?? direction;
      const result = await api.queryOntologyGraph(projectId, selectedPackageId, {
        root,
        depth: nextDepth,
        direction: nextDirection,
        ...(relationTypes.size ? { relationTypes: [...relationTypes] } : {}),
        includeActions,
        includeEvents,
        includeDatasets,
        limit: 2000,
      });
      if (!alive.current || request !== epoch.current) return;
      setGraph(result);
      setGraphStatus("ready");
    } catch (error) {
      if (!alive.current || request !== epoch.current) return;
      setGraphErrors(ontologySaveErrors(error));
      setGraphStatus("error");
    }
  }, [currentRoot, depth, direction, includeActions, includeDatasets, includeEvents, packages, projectId, relationTypes, selectedPackageId]);

  // 包/参数变化自动重查（root 回落当前包第一个对象）
  useEffect(() => {
    if (packagesStatus !== "ready") return;
    void runQuery();
  }, [packagesStatus, runQuery]);

  const selectRoot = useCallback((type: "object" | "dataset" | "action" | "event", id: string) => {
    if (!selectedPackageId) return;
    const request = ++epoch.current;
    const root = { type, id } as const;
    setCurrentRoot(root);
    setGraphStatus("loading");
    void (async () => {
      try {
        const result = await api.queryOntologyGraph(projectId, selectedPackageId, {
          root,
          depth,
          direction,
          ...(relationTypes.size ? { relationTypes: [...relationTypes] } : {}),
          includeActions,
          includeEvents,
          includeDatasets,
          limit: 2000,
        });
        if (!alive.current || request !== epoch.current) return;
        setGraph(result);
        setGraphStatus("ready");
      } catch (error) {
        if (!alive.current || request !== epoch.current) return;
        setGraphErrors(ontologySaveErrors(error));
        setGraphStatus("error");
      }
    })();
  }, [depth, direction, includeActions, includeDatasets, includeEvents, projectId, relationTypes, selectedPackageId]);

  /** 切包：清图与锁定根，避免旧包图残留误导（跨包不串图）。 */
  const selectPackage = useCallback((packageId: string | undefined) => {
    setSelectedPackageId(packageId);
    setCurrentRoot(undefined);
    setGraph(undefined);
    setGraphStatus("idle");
    setGraphErrors([]);
  }, []);

  const toggleRelationType = useCallback((key: string) => {
    setRelationTypes((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return {
    packages, packagesStatus, packagesErrors, reloadPackages: loadPackages,
    selectedPackageId, selectedPackage, selectPackage,
    depth, setDepth, direction, setDirection,
    relationTypes, toggleRelationType, relationKeys,
    includeActions, setIncludeActions, includeEvents, setIncludeEvents, includeDatasets, setIncludeDatasets,
    graph, graphStatus, graphErrors, retry: runQuery, selectRoot,
  };
}
