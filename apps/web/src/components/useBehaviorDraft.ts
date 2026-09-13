import { useEffect, useRef, useState } from "react";
import type { ScriptModule } from "@bim-studio/contracts";
import type { SceneScriptTarget } from "../studio/sceneScriptContext";
import { reconcileBehaviorDraft, sameBehaviorDraft } from "../behavior/behaviorDraftState";
import { targetMatches } from "./sceneBehaviorPanelModel";

/** 文件切换、草稿基线与异步操作身份；网络保存仍由应用控制器负责。 */
export function useBehaviorDraft(options: {
  scripts: readonly ScriptModule[];
  preferredTarget?: SceneScriptTarget;
  initialSelectedId?: string;
  onUpsert: (script: ScriptModule) => void;
  onInvalidName: () => void;
}) {
  const [selectedId, setSelectedId] = useState(() => options.scripts.find(script => targetMatches(script.target, options.preferredTarget))?.id
    ?? options.scripts.find(script => script.id === options.initialSelectedId)?.id ?? options.scripts[0]?.id);
  const [pendingScript, setPendingScript] = useState<ScriptModule>();
  const selected = options.scripts.find(script => script.id === selectedId)
    ?? (pendingScript?.id === selectedId ? pendingScript : undefined) ?? options.scripts[0];
  const [draft, setDraft] = useState(() => selected ? structuredClone(selected) : undefined);
  const baseline = useRef(selected);
  const epoch = useRef(0);
  const live = useRef(true);
  const dirty = !sameBehaviorDraft(selected, draft);
  const latest = useRef({ ...options, draft, dirty });
  latest.current = { ...options, draft, dirty };
  useEffect(() => { live.current = true; return () => { live.current = false; epoch.current++; }; }, []);
  useEffect(() => {
    const previous = baseline.current;
    baseline.current = selected;
    setDraft(current => reconcileBehaviorDraft(current, previous, selected));
    if (pendingScript && options.scripts.some(script => script.id === pendingScript.id)) setPendingScript(undefined);
  }, [JSON.stringify(selected), options.scripts, pendingScript]);

  function prepareLeave() {
    const current = latest.current;
    if (!current.dirty || !current.draft) return true;
    if (!current.draft.name.trim()) { current.onInvalidName(); return false; }
    current.onUpsert(current.draft);
    return true;
  }

  function activate(script: ScriptModule) {
    epoch.current++;
    baseline.current = script;
    setSelectedId(script.id);
    setDraft(structuredClone(script));
  }

  function selectScript(id: string) {
    if (id === latest.current.draft?.id) return true;
    const script = latest.current.scripts.find(item => item.id === id);
    if (!script || !prepareLeave()) return false;
    activate(script);
    return true;
  }

  function addScripts(scripts: readonly ScriptModule[], selectFirst = true) {
    if (!scripts.length || !live.current || !prepareLeave()) return false;
    scripts.forEach(latest.current.onUpsert);
    if (selectFirst) { setPendingScript(scripts[0]); activate(scripts[0]!); }
    return true;
  }

  useEffect(() => {
    // 对象选中只发起一次切换；无效名称阻止切换，修正后不会突然跳走。
    const preferred = latest.current.scripts.find(script => targetMatches(script.target, options.preferredTarget));
    if (preferred) selectScript(preferred.id);
  }, [options.preferredTarget?.kind, options.preferredTarget?.id]);

  function captureOperation() {
    const identity = epoch.current;
    const snapshot = latest.current.draft;
    return {
      isOpen: () => live.current,
      isCurrent: () => live.current && identity === epoch.current && sameBehaviorDraft(snapshot, latest.current.draft),
    };
  }

  return { selected, draft, setDraft, dirty, prepareLeave, selectScript, addScripts, captureOperation };
}
