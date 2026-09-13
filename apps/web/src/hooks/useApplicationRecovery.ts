import { useEffect, useRef, useState } from "react";
import type { ApplicationDocument, ScriptModule } from "@bim-studio/contracts";
import type { AppState } from "./useAppState";
import { applicationRecoveryDocument, applicationRecoveryFingerprint, applicationRecoveryKey, discardApplicationRecovery,
  readApplicationRecovery, restoredApplicationDocument, writeApplicationRecovery, type ApplicationRecoveryDraft } from "../studio/applicationRecovery";
import { downloadTextFile } from "../browserDownload";

/** 应用恢复只拥有本地副本；正式保存、导航和工作区内容仍由现有 ApplicationSession 管理。 */
export function useApplicationRecovery(state: AppState) {
  const [draft, setDraft] = useState<ApplicationRecoveryDraft>();
  const [busy, setBusy] = useState(false);
  const pendingScript = useRef<ScriptModule | undefined>(undefined);
  const applying = useRef(false);
  const queue = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queuedDocument = useRef<ApplicationDocument | undefined>(undefined);
  const writes = useRef(Promise.resolve());
  const latest = useRef(state);
  latest.current = state;
  const identity = state.activeApplication ? applicationRecoveryKey(state.activeApplication) : undefined;

  function flushSnapshot() {
    clearTimeout(queue.current);
    const snapshot = queuedDocument.current;
    queuedDocument.current = undefined;
    if (snapshot) writes.current = writes.current.then(() => writeApplicationRecovery(snapshot))
      .catch(() => latest.current.setMessage("本地恢复副本未能写入，请手动保存当前工作"));
  }

  function scheduleSnapshot() {
    clearTimeout(queue.current);
    const current = latest.current.applicationSessionRef.current.store.getState();
    if (!current.document || applying.current || (!current.dirty && !pendingScript.current)) return;
    queuedDocument.current = applicationRecoveryDocument(current.document, pendingScript.current);
    queue.current = setTimeout(flushSnapshot, 350);
  }

  useEffect(() => {
    pendingScript.current = undefined;
    setDraft(undefined);
    const session = state.applicationSessionRef.current;
    const server = session.getDocument();
    if (!server || !identity) return;
    let cancelled = false;
    writes.current = writes.current.then(async () => {
      const copy = await readApplicationRecovery(server);
      if (cancelled || !copy || session.getDocument()?.metadata.id !== server.metadata.id) return;
      if (session.store.getState().dirty || pendingScript.current) { scheduleSnapshot(); return; }
      if (applicationRecoveryFingerprint(copy.document) === applicationRecoveryFingerprint(server)) {
        await discardApplicationRecovery(server);
      } else {
        // 未经恢复决策前暂停自动保存，避免离线副本被当前服务器内容覆盖。
        latest.current.setAutoSaveEnabled(false);
        setDraft(copy);
      }
    }).catch(() => undefined);
    const unsubscribe = session.store.subscribe(() => {
      if (applying.current) return;
      const current = session.store.getState();
      if (current.document && applicationRecoveryKey(current.document) !== identity) { flushSnapshot(); return; }
      if (current.dirty || pendingScript.current) scheduleSnapshot();
      else if (current.document) {
        clearTimeout(queue.current);
        queuedDocument.current = undefined;
        const saved = current.document;
        writes.current = writes.current.then(async () => {
          const copy = await readApplicationRecovery(saved);
          if (copy && applicationRecoveryFingerprint(copy.document) === applicationRecoveryFingerprint(saved)) return discardApplicationRecovery(saved);
        }).catch(() => undefined);
      }
    });
    window.addEventListener("pagehide", flushSnapshot);
    return () => { cancelled = true; unsubscribe(); window.removeEventListener("pagehide", flushSnapshot); flushSnapshot(); };
  }, [identity]);

  function captureScriptDraft(value: ScriptModule | undefined) {
    pendingScript.current = value;
    scheduleSnapshot();
  }

  async function restore() {
    if (!draft || busy) return;
    const session = latest.current.applicationSessionRef.current;
    const server = session.getDocument();
    if (!server || applicationRecoveryKey(server) !== draft.key) return;
    setBusy(true); applying.current = true;
    latest.current.setAutoSaveEnabled(false);
    try {
      const recovered = restoredApplicationDocument(draft, server);
      session.openDocument(recovered);
      // 用服务器指纹建立保存基线，恢复内容继续保持 dirty，后续明确保存仍使用当前 revision。
      session.acknowledgeSave(server);
      pendingScript.current = undefined;
      setDraft(undefined);
      latest.current.setMessage("应用修改已恢复；请检查页面与脚本后手动保存");
    } catch (error) { latest.current.showError(error); }
    finally { applying.current = false; setBusy(false); }
  }

  async function discard() {
    if (!draft || busy) return;
    setBusy(true);
    try { await discardApplicationRecovery(draft.document); setDraft(undefined); }
    catch (error) { latest.current.showError(error); }
    finally { setBusy(false); }
  }

  return { draft, busy, restore, discard, captureScriptDraft,
    defer: () => { setDraft(undefined); },
    export: () => { if (draft) downloadTextFile(JSON.stringify(draft, null, 2), `${draft.document.metadata.name}-recovery.json`, "application/json"); },
  };
}
