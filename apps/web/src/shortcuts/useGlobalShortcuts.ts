import { useEffect, useMemo, useRef } from "react";
import {
  DEFAULT_SHORTCUTS, eventBinding, isTextEntryTarget, readShortcutOverrides,
  type ShortcutAction, type ShortcutOverrides,
} from "./keymap.js";

/** 全局快捷键分发器:单一 keydown 监听按键位表分发;文本控件聚焦时跳过。 */
export function useGlobalShortcuts(handlers: Partial<Record<ShortcutAction, () => void>>): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const overrides = useMemo<ShortcutOverrides>(() => readShortcutOverrides(window.localStorage), []);
  const bindingToAction = useMemo(() => {
    const map = new Map<string, ShortcutAction>();
    for (const action of Object.keys(handlers) as ShortcutAction[]) {
      map.set(overrides[action] ?? fallbackBinding(action), action);
    }
    return map;
  }, [handlers, overrides]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTextEntryTarget(event.target)) return;
      const binding = eventBinding(event);
      const action = bindingToAction.get(binding);
      if (!action) return;
      const handler = handlersRef.current[action];
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [bindingToAction]);
}

function fallbackBinding(action: ShortcutAction): string {
  return DEFAULT_SHORTCUTS[action] ?? "";
}
