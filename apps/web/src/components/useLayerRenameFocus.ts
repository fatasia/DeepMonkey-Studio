import { useEffect, useRef } from "react";

/** 选择状态提交后再聚焦对应名称输入，避免 F2 改到上一个对象。 */
export function useLayerRenameFocus(scope: "scene" | "dashboard") {
  const pending = useRef<number | undefined>(undefined);
  useEffect(() => () => { if (pending.current !== undefined) cancelAnimationFrame(pending.current); }, []);
  return (id: string, prepare: () => void) => {
    if (pending.current !== undefined) cancelAnimationFrame(pending.current);
    prepare();
    const focus = (attempt: number) => {
      pending.current = requestAnimationFrame(() => {
        pending.current = undefined;
        const input = [...document.querySelectorAll<HTMLInputElement>(`input[data-layer-rename-scope="${scope}"]`)]
          .find(candidate => candidate.dataset.layerRenameId === id);
        if (input && !input.matches(":disabled") && !input.readOnly) { input.focus(); input.select(); }
        else if (!input && attempt < 2) focus(attempt + 1);
      });
    };
    focus(0);
  };
}
