import { useEffect, useMemo, useRef } from "react";
import { api } from "../api.js";
import type { EditorPresenceUpdate } from "../apiClients/mcpApi.js";
import { buildEditorSceneDraftSnapshot } from "../studio/editorSceneDraftSnapshot.js";
import { buildEditorDiagnosticsSnapshotReport } from "../studio/editorDiagnosticsSnapshotReport.js";
import { readStudioFrameReadbacks } from "../viewer/studioFrameCaptureDiagnostics.js";
import { isPbrFrameReadbackSnapshot } from "@bim-studio/deep-engine";
import { getStudioSceneRuntime } from "../studio/studioSceneRuntimeRegistry.js";
import { runEditorSceneTransaction } from "../studio/editorSceneWriteDriver.js";
import type { AppState } from "./useAppState.js";

const HEARTBEAT_MS = 15_000;
/** 写事务轮询：仅场景编辑面开启；无在途事务时服务端 204，开销可忽略。 */
const DRIVER_POLL_MS = 1_000;
/** 快照字节拉取预算（原始字节）：覆盖 4K rgba8 与 1080p rgba16f，超出显式 unavailable。 */
const SNAPSHOT_FETCH_BYTE_BUDGET = 64 * 1024 * 1024;

/**
 * Publishes only a bounded editor summary; draft content leaves the browser only as the
 * optional bounded scene draft mirror (same payload shape validated server-side), and write
 * transactions are pulled by this session and executed through the scene command ports.
 */
export function useEditorPresence(state: AppState): void {
  const session = state.applicationSessionRef.current;
  const storeState = session.store.getState();
  const document = storeState.document;
  const descriptor = activeDescriptor(state, document);
  const latest = useRef<EditorPresenceUpdate | undefined>(undefined);
  const lease = useRef<{ identity: string; sessionId: string; leaseId: string } | undefined>(undefined);
  /** 写事务 CAS 基准：与 React applicationRevision 同步递增（store emit 与事务 apply/rollback 各 +1）。 */
  const revisionRef = useRef(state.applicationRevision);
  const activeSceneRef = useRef<string | undefined>(descriptor?.surface === "scene" ? descriptor.targetId : undefined);

  const draftMirror = useMemo(() => {
    if (!document || !storeState.dirty || descriptor?.surface !== "scene" || !descriptor.targetId) return undefined;
    return buildEditorSceneDraftSnapshot(document, descriptor.targetId, state.applicationRevision);
  }, [document, storeState.dirty, descriptor?.surface, descriptor?.targetId, state.applicationRevision]);

  const diagnosticsSnapshot = useMemo(() => {
    if (!document || !storeState.dirty || descriptor?.surface !== "scene" || !descriptor.targetId) return undefined;
    return buildEditorDiagnosticsSnapshotReport(descriptor.targetId, state.applicationRevision);
  }, [document, storeState.dirty, descriptor?.surface, descriptor?.targetId, state.applicationRevision]);

  latest.current = descriptor ? {
    leaseId: lease.current?.identity === descriptor.identity ? lease.current.leaseId : "pending",
    projectId: descriptor.projectId, applicationId: descriptor.applicationId,
    applicationName: document!.metadata.name, surface: descriptor.surface,
    ...(descriptor.targetId ? { targetId: descriptor.targetId } : {}),
    ...(descriptor.targetName ? { targetName: descriptor.targetName } : {}),
    persistedRevision: document!.metadata.revision, draftRevision: state.applicationRevision,
    dirty: storeState.dirty, selectionCount: storeState.selection.length,
    ...(draftMirror ? { draftMirror } : {}),
    ...(diagnosticsSnapshot ? { diagnosticsSnapshot } : {}),
  } : undefined;

  useEffect(() => {
    if (!descriptor) return;
    const current = { identity: descriptor.identity, sessionId: window.crypto.randomUUID(), leaseId: window.crypto.randomUUID() };
    lease.current = current;
    // 与根级 store 订阅逐事件同步；已打开文档的历史 emit 在此对齐一次基准。
    revisionRef.current = state.applicationRevision;
    const unsubscribeRevision = session.store.subscribe(() => { revisionRef.current += 1; });
    activeSceneRef.current = descriptor.surface === "scene" ? descriptor.targetId : undefined;

    let pollInFlight = false;
    const pollOnce = async () => {
      if (pollInFlight || lease.current !== current || !activeSceneRef.current) return;
      pollInFlight = true;
      try {
        const next = await api.nextEditorDriverRequest(current.sessionId, current.leaseId);
        if (!next || lease.current !== current || !activeSceneRef.current) return;
        const sceneId = activeSceneRef.current;
        const result = await runEditorSceneTransaction({
          sceneId,
          viewer: () => getStudioSceneRuntime(sceneId),
          readRevision: () => revisionRef.current,
          bumpRevision: () => {
            revisionRef.current += 1;
            state.setApplicationRevision(value => value + 1);
          },
        }, next);
        if (lease.current !== current) return;
        await api.postEditorDriverResult(current.sessionId, current.leaseId, next.requestId, result);
      } catch {
        // 拉取或回传失败：下个周期重试；已取走的事务由服务端 TTL 兜底作废。
      } finally {
        pollInFlight = false;
      }
    };

    const publish = () => {
      const value = latest.current;
      if (!value || lease.current !== current) return;
      void api.updateEditorPresence(current.sessionId, { ...value, leaseId: current.leaseId }).catch(() => undefined);
    };
    const release = (keepalive = false) => void api.releaseEditorPresence(current.sessionId, current.leaseId, keepalive).catch(() => undefined);
    publish();
    const timer = window.setInterval(publish, HEARTBEAT_MS);
    const driverTimer = descriptor.surface === "scene" ? window.setInterval(() => void pollOnce(), DRIVER_POLL_MS) : undefined;
    let snapshotInFlight = false;
    const snapshotOnce = async () => {
      if (snapshotInFlight || lease.current !== current || !activeSceneRef.current) return;
      snapshotInFlight = true;
      try {
        const request = await api.nextEditorSnapshotRequest(current.sessionId, current.leaseId);
        if (!request || lease.current !== current) return;
        // 在有界 readback 存储里找匹配（可选 frameId 精确匹配；否则取该资源最新一条）。
        const latest = readStudioFrameReadbacks().at(-1);
        const snapshot = latest?.results
          .filter(result => result.resourceId === request.resourceId
            && (request.frameId === undefined || result.frameId === request.frameId))
          .map(result => (isPbrFrameReadbackSnapshot(result) ? result : undefined))
          .find(value => value !== undefined);
        let payload: unknown;
        if (!snapshot) {
          payload = { status: "unavailable", resourceId: request.resourceId,
            message: "没有匹配的快照（帧已滚出有界历史或该帧此资源不可用）" };
        } else if (snapshot.bytes.byteLength > SNAPSHOT_FETCH_BYTE_BUDGET) {
          payload = { status: "unavailable", resourceId: request.resourceId,
            message: `快照 ${snapshot.bytes.byteLength} 字节超出拉取预算 ${SNAPSHOT_FETCH_BYTE_BUDGET}` };
        } else {
          const chunk = 0x8000;
          let binary = "";
          for (let offset = 0; offset < snapshot.bytes.byteLength; offset += chunk) {
            binary += String.fromCharCode(...snapshot.bytes.subarray(offset, Math.min(offset + chunk, snapshot.bytes.byteLength)));
          }
          payload = { status: "ok", resourceId: snapshot.resourceId, frameId: snapshot.frameId,
            format: snapshot.format, width: snapshot.width, height: snapshot.height,
            byteLength: snapshot.bytes.byteLength, dataBase64: btoa(binary) };
        }
        if (lease.current !== current) return;
        await api.postEditorSnapshotResult(current.sessionId, request.requestId, payload);
      } catch {
        // 回传失败：下个周期由服务端 TTL 兜底。
      } finally { snapshotInFlight = false; }
    };
    const snapshotTimer = descriptor.surface === "scene" ? window.setInterval(() => void snapshotOnce(), DRIVER_POLL_MS) : undefined;
    const pagehide = () => release(true);
    window.addEventListener("pagehide", pagehide);
    return () => {
      if (lease.current === current) lease.current = undefined;
      unsubscribeRevision();
      window.clearInterval(timer);
      if (driverTimer !== undefined) window.clearInterval(driverTimer);
      if (snapshotTimer !== undefined) window.clearInterval(snapshotTimer);
      window.removeEventListener("pagehide", pagehide);
      release();
    };
  }, [descriptor?.identity]);

  useEffect(() => {
    const current = lease.current;
    const value = latest.current;
    if (!current || !value || current.identity !== descriptor?.identity) return;
    void api.updateEditorPresence(current.sessionId, { ...value, leaseId: current.leaseId }).catch(() => undefined);
  }, [descriptor?.identity, state.applicationRevision, storeState.dirty, storeState.selection.length,
    document?.metadata.revision, descriptor?.targetName]);
}

function activeDescriptor(state: AppState, document: ReturnType<AppState["applicationSessionRef"]["current"]["getDocument"]>) {
  const { route, currentUser } = state;
  if (!currentUser || !document || !route.projectId || !route.applicationId
    || document.metadata.id !== route.applicationId || document.metadata.projectId !== route.projectId) return undefined;
  if (route.view === "studio" && route.sceneId) {
    const scene = document.scenes.find(item => item.id === route.sceneId);
    return { identity: `${currentUser.id}:scene:${route.projectId}:${route.applicationId}:${route.sceneId}`,
      projectId: route.projectId, applicationId: route.applicationId, surface: "scene" as const,
      targetId: route.sceneId, targetName: scene?.name };
  }
  if (route.view === "dashboard" && route.pageId) {
    const page = document.pages.find(item => item.id === route.pageId);
    return { identity: `${currentUser.id}:dashboard:${route.projectId}:${route.applicationId}:${route.pageId}`,
      projectId: route.projectId, applicationId: route.applicationId, surface: "dashboard" as const,
      targetId: route.pageId, targetName: page?.name };
  }
  if (route.view === "topology" && route.topologyId) {
    const topology = document.topologies.find(item => item.id === route.topologyId);
    return { identity: `${currentUser.id}:topology:${route.projectId}:${route.applicationId}:${route.topologyId}`,
      projectId: route.projectId, applicationId: route.applicationId, surface: "topology" as const,
      targetId: route.topologyId, targetName: topology?.name };
  }
  return undefined;
}
