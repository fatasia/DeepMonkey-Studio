import { useCallback, useEffect, useRef, useState } from "react";
import type { DataDatasetRecord, OntologyPackage } from "@bim-studio/contracts";
import { api } from "../api";
import type { OntologyValidationResponse } from "../apiClients/ontologyApi";
import { newOntologyDraft, ontologySaveErrors } from "./ontologyWorkspaceLogic";

/**
 * 语义与本体工作区状态：包列表 + 当前草稿 + 资产选择 + 校验/发布/版本动作。
 * 加载只取包摘要与数据集（首屏轻量）；选中包后按需拉取版本列表。
 */
export function useOntologyWorkspace(projectId: string, owner: string) {
  const [packages, setPackages] = useState<OntologyPackage[]>([]);
  const [datasets, setDatasets] = useState<DataDatasetRecord[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedPackageId, setSelectedPackageId] = useState<string>();
  const [draft, setDraft] = useState<OntologyPackage>();
  const [validation, setValidation] = useState<OntologyValidationResponse>();
  const [versions, setVersions] = useState<{ versions: Array<{ snapshotId: string; version: number; fingerprint: string; publishedAt: string; publishedBy: string }>; history: Array<{ at: string; by: string; action: string; detail?: string }> }>();
  const alive = useRef(true);
  const epoch = useRef(0);

  const run = useCallback(async <T>(action: () => Promise<T>, successMessage?: string): Promise<T | undefined> => {
    setBusy(true);
    setErrors([]);
    try {
      const result = await action();
      if (successMessage) setNotice(successMessage);
      return result;
    } catch (error) {
      setErrors(ontologySaveErrors(error));
      setNotice("");
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  const load = useCallback(async () => {
    const request = ++epoch.current;
    setStatus("loading");
    setErrors([]);
    try {
      const [nextPackages, nextDatasets] = await Promise.all([
        api.listOntologyPackages(projectId),
        api.listDatasets(projectId),
      ]);
      if (!alive.current || request !== epoch.current) return;
      setPackages(nextPackages);
      setDatasets(nextDatasets);
      setStatus("ready");
      setSelectedPackageId((current) => {
        const kept = nextPackages.find((item) => item.id === current) ?? nextPackages[0];
        return kept?.id;
      });
    } catch (error) {
      if (alive.current && request === epoch.current) {
        setErrors(ontologySaveErrors(error));
        setStatus("error");
      }
    }
  }, [projectId]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
  }, [load]);

  const currentPackage = packages.find((item) => item.id === selectedPackageId);

  const selectPackage = useCallback((packageId: string) => {
    setSelectedPackageId(packageId);
    setDraft(undefined);
    setValidation(undefined);
    setVersions(undefined);
    setNotice("");
    setErrors([]);
  }, []);

  /** 打开编辑：以服务端最新值为草稿底稿。 */
  const editCurrent = useCallback(async () => {
    if (!selectedPackageId) return;
    const latest = await run(() => api.getOntologyPackage(projectId, selectedPackageId));
    if (latest) setDraft(structuredClone(latest));
  }, [projectId, run, selectedPackageId]);

  const loadVersions = useCallback(async () => {
    if (!selectedPackageId) return;
    const list = await run(() => api.listOntologyVersions(projectId, selectedPackageId));
    if (list) setVersions(list);
  }, [projectId, run, selectedPackageId]);

  const createPackage = useCallback(async (name: string, domain: string) => {
    const created = await run(async () => {
      const candidate = draft && !draft.id ? structuredClone(draft) : newOntologyDraft(owner);
      candidate.name = name;
      candidate.domain = domain || candidate.domain;
      return api.createOntologyPackage(projectId, candidate);
    }, "已创建本体包草稿");
    if (created) {
      setPackages((items) => [...items, created]);
      setSelectedPackageId(created.id);
      setDraft(undefined);
    }
    return created;
  }, [draft, owner, projectId, run]);

  const saveDraft = useCallback(async () => {
    if (!draft) return;
    const saved = await run(() => api.updateOntologyPackage(projectId, draft), "草稿已保存");
    if (saved) {
      setPackages((items) => items.map((item) => (item.id === saved.id ? saved : item)));
      setDraft(undefined);
      setValidation(undefined);
    }
  }, [draft, projectId, run]);

  const validateDraft = useCallback(async () => {
    if (!draft) return;
    const report = await run(() => api.validateOntologyPackage(projectId, draft));
    if (report) setValidation(report);
  }, [draft, projectId, run]);

  const submitReview = useCallback(async () => {
    if (!selectedPackageId) return;
    const next = await run(() => api.submitOntologyReview(projectId, selectedPackageId), "已提交评审");
    if (next) setPackages((items) => items.map((item) => (item.id === next.id ? next : item)));
  }, [projectId, run, selectedPackageId]);

  const rejectReview = useCallback(async () => {
    if (!selectedPackageId) return;
    const next = await run(() => api.rejectOntologyReview(projectId, selectedPackageId), "已驳回回草稿");
    if (next) setPackages((items) => items.map((item) => (item.id === next.id ? next : item)));
  }, [projectId, run, selectedPackageId]);

  const publish = useCallback(async () => {
    if (!selectedPackageId) return;
    const next = await run(() => api.publishOntologyPackage(projectId, selectedPackageId));
    if (next) {
      setPackages((items) => items.map((item) => (item.id === next.id ? next : item)));
      setNotice(`已发布 v${next.version}（九条门禁通过,快照已生成）`);
      setValidation(undefined);
    }
  }, [projectId, run, selectedPackageId]);

  const retire = useCallback(async () => {
    if (!selectedPackageId) return;
    const next = await run(() => api.retireOntologyPackage(projectId, selectedPackageId), "已退役");
    if (next) setPackages((items) => items.map((item) => (item.id === next.id ? next : item)));
  }, [projectId, run, selectedPackageId]);

  const rollback = useCallback(async (snapshotId: string) => {
    if (!selectedPackageId) return;
    const next = await run(() => api.rollbackOntologyPackage(projectId, selectedPackageId, snapshotId));
    if (next) {
      setPackages((items) => items.map((item) => (item.id === next.id ? next : item)));
      setNotice(`已回滚到 v${next.version}`);
    }
  }, [projectId, run, selectedPackageId]);

  const cloneDraft = useCallback(async () => {
    if (!selectedPackageId) return;
    const next = await run(() => api.cloneOntologyDraft(projectId, selectedPackageId), "已基于发布版本开新草稿");
    if (next) {
      setPackages((items) => items.map((item) => (item.id === next.id ? next : item)));
      setDraft(next);
    }
  }, [projectId, run, selectedPackageId]);

  const deletePackage = useCallback(async (packageId: string) => {
    const removed = await run(() => api.deleteOntologyPackage(projectId, packageId));
    if (removed !== undefined) {
      setPackages((items) => items.filter((item) => item.id !== packageId));
      setSelectedPackageId((current) => (current === packageId ? undefined : current));
      setDraft(undefined);
    }
  }, [projectId, run]);

  return {
    packages, datasets, status, errors, notice, busy,
    selectedPackageId, currentPackage, draft, validation, versions,
    selectPackage, editCurrent, loadVersions, createPackage,
    setDraft, setValidation, saveDraft, validateDraft, submitReview, rejectReview,
    publish, retire, rollback, cloneDraft, deletePackage,
    reload: load,
  };
}
