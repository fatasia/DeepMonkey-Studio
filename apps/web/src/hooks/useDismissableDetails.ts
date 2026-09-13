import { useEffect, useRef } from "react";

/** Native details menus do not dismiss themselves; standardize popover behavior. */
export function useDismissableDetails<T extends HTMLDetailsElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const dismissOutside = (event: PointerEvent | FocusEvent) => {
      const details = ref.current;
      if (!details?.open || !(event.target instanceof Node) || details.contains(event.target)) return;
      details.open = false;
    };
    const dismissEscape = (event: KeyboardEvent) => {
      const details = ref.current;
      if (event.key !== "Escape" || !details?.open) return;
      event.preventDefault();
      event.stopPropagation();
      details.open = false;
      details.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside, true);
    document.addEventListener("keydown", dismissEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside, true);
      document.removeEventListener("keydown", dismissEscape, true);
    };
  }, []);
  return ref;
}
