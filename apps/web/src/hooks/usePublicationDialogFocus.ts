import { useLayoutEffect, useRef } from "react";
import { resolveFocusTrapIndex } from "../components/scriptVersionManagerModel";

const layers = ".dialog-backdrop, [data-escape-dialog]";
const controls = "button,input,select,textarea,a[href],summary,[tabindex]";

/** 仅发布弹窗使用；保留全局 Escape 的既有所有权。 */
export function usePublicationDialogFocus(busy: boolean) {
  const root = useRef<HTMLElement>(null);
  const session = useRef<ReturnType<typeof containPublicationDialogFocus>>(undefined);
  useLayoutEffect(() => {
    if (!root.current) return;
    session.current = containPublicationDialogFocus(root.current);
    return () => { session.current?.dispose(); session.current = undefined; };
  }, []);
  useLayoutEffect(() => { session.current?.reconcile(); }, [busy]);
  return root;
}

export function containPublicationDialogFocus(root: HTMLElement) {
  const doc = root.ownerDocument, backdrop = root.closest<HTMLElement>(layers);
  const previous = doc.activeElement instanceof HTMLElement ? doc.activeElement : undefined;
  let disposed = false;
  const isTop = () => Boolean(backdrop && topLayer(doc) === backdrop);
  const available = () => Array.from(root.querySelectorAll<HTMLElement>(controls))
    .filter(element => element.tabIndex >= 0 && usable(element));
  const focusInitial = () => {
    const candidates = available();
    (candidates.find(element => element.getAttribute("aria-pressed") === "true") ?? candidates[0] ?? root).focus({ preventScroll: true });
  };
  const reconcile = () => {
    if (disposed || !isTop()) return;
    const active = doc.activeElement;
    if (active === root || (active instanceof HTMLElement && root.contains(active) && usable(active))) return;
    focusInitial();
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || event.defaultPrevented || !isTop()) return;
    const candidates = available();
    if (!candidates.length) { event.preventDefault(); root.focus({ preventScroll: true }); return; }
    const index = candidates.indexOf(doc.activeElement as HTMLElement);
    const next = resolveFocusTrapIndex(candidates.length, index, event.shiftKey);
    if (next !== undefined) { event.preventDefault(); candidates[next]!.focus({ preventScroll: true }); }
  };
  doc.addEventListener("keydown", keydown);
  doc.addEventListener("focusin", reconcile);
  if (isTop()) focusInitial();
  return { reconcile, dispose() {
    if (disposed) return;
    disposed = true;
    doc.removeEventListener("keydown", keydown); doc.removeEventListener("focusin", reconcile);
    const top = topLayer(doc);
    if (previous?.isConnected && usable(previous) && (!top || top === backdrop || top.contains(previous))) {
      previous.focus({ preventScroll: true });
    }
  } };
}

function usable(element: HTMLElement): boolean {
  return !element.matches(":disabled") && !element.closest("[hidden],[inert],[aria-hidden='true']") && visible(element);
}
function visible(element: HTMLElement): boolean {
  const style = getComputedStyle(element), bounds = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
}
function topLayer(doc: Document): HTMLElement | undefined {
  let result: HTMLElement | undefined, z = -Infinity;
  for (const layer of doc.querySelectorAll<HTMLElement>(layers)) {
    if (!visible(layer)) continue;
    const candidate = Number.parseFloat(getComputedStyle(layer).zIndex) || 0;
    if (candidate >= z) { result = layer; z = candidate; }
  }
  return result;
}
