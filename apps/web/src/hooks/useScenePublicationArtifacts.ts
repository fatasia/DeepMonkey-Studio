import { useCallback, useEffect, useRef, useState } from "react";
import type { PublishedSceneRecord } from "@bim-studio/contracts";
import { api } from "../api";
import { exportSceneClientPackage, type PreparedSceneClientPackage } from "../delivery/sceneClientPackage";
import { exportSceneStandaloneExecutable } from "../delivery/sceneStandaloneExecutable";
import { createSceneArtifactRecord, type SceneArtifactOptions, type SceneArtifactRecord } from "../controllers/scenePublicationArtifactRecord";
import { createSceneArtifactRunner, type SceneArtifactRunResult } from "../controllers/scenePublicationArtifactRunner";
import { restoreSceneArtifactRecords, saveSceneArtifactRecord } from "../controllers/scenePublicationArtifactStore";
import { withSceneArtifactLock } from "../controllers/scenePublicationArtifactLock";

interface ArtifactSession {
  ownerId: string;
  active: boolean;
  records: Map<string, SceneArtifactRecord>;
  restores: Map<string, Promise<SceneArtifactRecord[]>>;
  pending: Map<string, { operation: Promise<SceneArtifactRunResult>; cancelled: boolean; projectId: string; sceneId: string }>;
  runner: ReturnType<typeof createSceneArtifactRunner>;
  loading: number;
  error: string | undefined;
}
interface ArtifactState { ownerId: string | undefined; records: SceneArtifactRecord[]; loading: boolean; error: string | undefined }

/** App 持有任务；浏览器场景锁覆盖恢复、导出和最终状态持久化。 */
export function useScenePublicationArtifacts(ownerId: string | undefined) {
  const owner = useRef({ ownerId, mounted: false });
  if (owner.current.ownerId !== ownerId) owner.current = { ownerId, mounted: false };
  const identity = owner.current;
  const session = useRef<ArtifactSession | undefined>(undefined);
  const retired = useRef(new Map<string, Promise<void>>());
  const [state, setState] = useState<ArtifactState>({ ownerId, records: [], loading: false, error: undefined });
  const current = (value: ArtifactSession) => identity.mounted && owner.current === identity && value.active
    && session.current === value && identity.ownerId === value.ownerId;
  const publish = (value: ArtifactSession) => {
    if (current(value)) setState({ ownerId: value.ownerId, loading: value.loading > 0, error: value.error,
      records: [...value.records.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)) });
  };
  const dispose = (value: ArtifactSession | undefined) => {
    if (!value?.active) return;
    value.active = false;
    for (const [key, task] of value.pending) { task.cancelled = true; value.runner.cancel(key); }
    // 同用户回切必须等旧任务的取消记录落盘，避免覆盖新尝试或被误恢复为中断。
    retired.current.set(value.ownerId, Promise.allSettled([
      retired.current.get(value.ownerId),
      ...value.restores.values(), ...[...value.pending.values()].map(task => task.operation),
    ]).then(() => undefined));
  };
  function ensureSession(): ArtifactSession {
    if (!ownerId || owner.current !== identity || !identity.mounted) throw new Error("请先登录后再管理客户端打包任务。");
    if (session.current?.active && session.current.ownerId === ownerId) return session.current;
    dispose(session.current);
    const value: ArtifactSession = { ownerId, active: true, records: new Map(), restores: new Map(), pending: new Map(), loading: 0, error: undefined,
      runner: createSceneArtifactRunner({ loadHistory: (projectId, sceneId) => api.listScenePublications(projectId, sceneId),
        exportPackage: exportSceneClientPackage, exportExecutable: exportSceneStandaloneExecutable, saveRecord: record => saveSceneArtifactRecord(ownerId, record),
        onChange: record => { if (current(value)) { value.records.set(record.key, record); publish(value); } },
      }) };
    session.current = value; publish(value); return value;
  }
  useEffect(() => {
    identity.mounted = true;
    if (!ownerId) {
      dispose(session.current); session.current = undefined;
      setState({ ownerId, records: [], loading: false, error: undefined });
      return () => { identity.mounted = false; };
    }
    const value = ensureSession();
    return () => { identity.mounted = false; dispose(value); };
  }, [identity]);

  function loadSession(value: ArtifactSession, projectId: string, sceneId: string): Promise<SceneArtifactRecord[]> {
    const key = JSON.stringify([projectId, sceneId]);
    const existing = value.restores.get(key); if (existing) return existing;
    value.loading++; value.error = undefined; publish(value);
    const operation = (retired.current.get(value.ownerId) ?? Promise.resolve()).then(() => {
      if (!current(value)) throw new DOMException("客户端打包已取消。", "AbortError");
      return withSceneArtifactLock(value.ownerId, projectId, sceneId, () => restoreSceneArtifactRecords(value.ownerId, projectId, sceneId));
    }).then(records => {
      if (current(value)) { for (const record of records) value.records.set(record.key, record); }
      return records;
    }).catch(reason => {
      if (current(value)) value.error = reason instanceof Error ? reason.message : String(reason);
      throw reason;
    }).finally(() => {
      if (value.restores.get(key) === operation) value.restores.delete(key);
      value.loading--; publish(value);
    });
    value.restores.set(key, operation); return operation;
  }
  const load = useCallback((projectId: string, sceneId: string): Promise<SceneArtifactRecord[]> => {
    try {
      const value = ensureSession();
      // 重新打开本页正在打包的场景时读取内存状态，不重入自己持有的锁。
      if ([...value.pending.values()].some(task => task.projectId === projectId && task.sceneId === sceneId)) {
        return Promise.resolve([...value.records.values()].filter(record => record.projectId === projectId && record.sceneId === sceneId));
      }
      return loadSession(value, projectId, sceneId);
    } catch (reason) { return Promise.reject(reason); }
  }, [identity]);
  const run = useCallback((record: SceneArtifactRecord, prepared?: PreparedSceneClientPackage): Promise<SceneArtifactRunResult> => {
    let value: ArtifactSession;
    try { value = ensureSession(); } catch (reason) { return Promise.reject(reason); }
    const existing = value.pending.get(record.key); if (existing) return existing.operation;
    const frozen = structuredClone(record);
    const task = { cancelled: false, projectId: frozen.projectId, sceneId: frozen.sceneId, operation: undefined as unknown as Promise<SceneArtifactRunResult> };
    value.error = undefined;
    const previousReads = Promise.all([retired.current.get(value.ownerId), value.restores.get(JSON.stringify([frozen.projectId, frozen.sceneId]))]);
    task.operation = previousReads.then(() => withSceneArtifactLock(value.ownerId, frozen.projectId, frozen.sceneId, async () => {
      if (!current(value)) throw new DOMException("客户端打包已取消。", "AbortError");
      // 获取执行权后重新读盘，不能用另一标签页开始新尝试前的缓存覆盖其状态。
      const records = await restoreSceneArtifactRecords(value.ownerId, frozen.projectId, frozen.sceneId);
      if (!current(value)) throw new DOMException("客户端打包已取消。", "AbortError");
      for (const record of records) value.records.set(record.key, record);
      const running = value.runner.run(records.find(record => record.key === frozen.key) ?? frozen, prepared);
      if (task.cancelled) value.runner.cancel(frozen.key);
      return running;
    })).catch(reason => {
      if (current(value)) { value.error = reason instanceof Error ? reason.message : String(reason); publish(value); }
      throw reason;
    }).finally(() => { if (value.pending.get(frozen.key) === task) value.pending.delete(frozen.key); });
    value.pending.set(frozen.key, task); return task.operation;
  }, [identity]);
  const retry = useCallback((record: SceneArtifactRecord): Promise<SceneArtifactRunResult> => run(record), [run]);
  const begin = useCallback((publication: PublishedSceneRecord, options: SceneArtifactOptions, prepared?: PreparedSceneClientPackage): Promise<SceneArtifactRunResult> => {
    try { return run(createSceneArtifactRecord(publication, options), prepared); } catch (reason) { return Promise.reject(reason); }
  }, [run]);
  const cancel = useCallback((key: string): void => {
    const value = session.current;
    if (!value || !current(value)) return;
    const task = value.pending.get(key); if (task) task.cancelled = true;
    value.runner.cancel(key);
  }, [identity]);
  return { begin, retry, cancel, load, records: state.ownerId === ownerId ? state.records : [],
    loading: state.ownerId === ownerId && state.loading, error: state.ownerId === ownerId ? state.error : undefined };
}
