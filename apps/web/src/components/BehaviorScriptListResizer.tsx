import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { BEHAVIOR_SCRIPT_LIST_COLLAPSED_STORAGE_KEY, BEHAVIOR_SCRIPT_LIST_WIDTH_STORAGE_KEY } from "../appDefaults";
import { translate as tr, type AppLocale } from "../i18n";

const MIN_WIDTH = 132;
const MAX_WIDTH = 320;

export function readBehaviorScriptListWidth(): number {
  try {
    return clamp(Number(window.localStorage.getItem(BEHAVIOR_SCRIPT_LIST_WIDTH_STORAGE_KEY)) || 190);
  } catch {
    return 190;
  }
}

export function readBehaviorScriptListCollapsed(): boolean {
  try {
    return window.localStorage.getItem(BEHAVIOR_SCRIPT_LIST_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function persistBehaviorScriptListCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(BEHAVIOR_SCRIPT_LIST_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Storage may be disabled in hardened webviews; collapsing still works for this session.
  }
}

export function BehaviorScriptListResizer(props: { locale: AppLocale; width: number; onWidthChange: (width: number) => void }) {
  const resizeFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    commit(props.width + (event.key === "ArrowRight" ? 16 : -16), props.onWidthChange);
  };
  return <button
    className="behavior-script-list-resizer"
    type="button"
    role="separator"
    aria-orientation="vertical"
    aria-label={tr(props.locale, "调整脚本列表宽度", "Resize script list")}
    title={tr(props.locale, "拖动调整脚本列表宽度", "Drag to resize script list")}
    onPointerDown={(event) => startResize(event, props.width, props.onWidthChange)}
    onKeyDown={resizeFromKeyboard}
  />;
}

function startResize(event: ReactPointerEvent<HTMLButtonElement>, initial: number, update: (width: number) => void) {
  event.preventDefault();
  const startX = event.clientX;
  const move = (next: PointerEvent) => update(clamp(initial + next.clientX - startX));
  const stop = (next: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    commit(initial + next.clientX - startX, update);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop, { once: true });
}

function commit(width: number, update: (width: number) => void) {
  const next = clamp(width);
  update(next);
  try {
    window.localStorage.setItem(BEHAVIOR_SCRIPT_LIST_WIDTH_STORAGE_KEY, String(next));
  } catch {
    // Keep the current session usable when preference storage is unavailable.
  }
}

function clamp(width: number) {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(width)));
}
