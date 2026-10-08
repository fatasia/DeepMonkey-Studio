import { useRef, useState } from "react";
import type { DataPipelineDefinition } from "@bim-studio/contracts";

/** Graph gestures create one checkpoint each, rather than one per pointer frame. */
export function usePipelineHistory(draft: DataPipelineDefinition | undefined,
  setDraft: (next: DataPipelineDefinition) => void) {
  const past = useRef<DataPipelineDefinition[]>([]), future = useRef<DataPipelineDefinition[]>([]);
  const identity = useRef(draft?.id);
  const [, refresh] = useState(0);
  if (identity.current !== draft?.id) { identity.current = draft?.id; past.current = []; future.current = []; }
  function commit(next: DataPipelineDefinition) {
    if (!draft || next.id !== draft.id) { setDraft(next); return; }
    past.current = [...past.current.slice(-49), draft]; future.current = [];
    setDraft(next); refresh(version => version + 1);
  }
  function travel(backward: boolean) {
    if (!draft) return;
    const from = backward ? past : future, to = backward ? future : past;
    const next = from.current.pop();
    if (!next) return;
    to.current.push(draft); setDraft(next); refresh(version => version + 1);
  }
  return { commit, undo: () => travel(true), redo: () => travel(false),
    canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
}
