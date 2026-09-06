import { useCallback, useEffect, useRef } from "react";

interface DialogEscapeAction { dismiss: () => void; busy: boolean }
const actions = new Map<HTMLElement, () => DialogEscapeAction>();

/** 显式注册键盘语义；恢复草稿的 Esc=稍后处理，不等同于点击遮罩。 */
export function useDialogEscape(dismiss: () => void, busy = false) {
  const latest = useRef({ dismiss, busy });
  latest.current = { dismiss, busy };
  const backdrop = useRef<HTMLElement | null>(null);
  return useCallback((element: HTMLElement | null) => {
    if (backdrop.current) actions.delete(backdrop.current);
    backdrop.current = element;
    if (element) actions.set(element, () => latest.current);
  }, []);
}

function topVisibleBackdrop(): HTMLElement | undefined {
  let top: HTMLElement | undefined;
  let topZ = -Infinity;
  for (const element of document.querySelectorAll<HTMLElement>(".dialog-backdrop")) {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (bounds.width <= 0 || bounds.height <= 0 || style.visibility === "hidden" || style.display === "none") continue;
    const zIndex = Number.parseFloat(style.zIndex) || 0;
    // 同层级按实际绘制顺序选最后一个，不能只按 hook 注册先后判定。
    if (zIndex >= topZ) { top = element; topZ = zIndex; }
  }
  return top;
}

/** 冒泡阶段让内层控件先处理 Esc；只消费顶层已注册对话框的按键。 */
export function useGlobalDialogEscape() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.repeat) return;
      const top = topVisibleBackdrop();
      const action = top && actions.get(top)?.();
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (!action.busy) action.dismiss();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
