import { MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { translate as tr, type AppLocale } from "../i18n";
import { useDismissableDetails } from "../hooks/useDismissableDetails";
import { SceneLayerMenuActions } from "./SceneLayerInteractions";

export function SceneRowMenu({ locale, children }: { locale: AppLocale; children: ReactNode }) {
  const detailsRef = useDismissableDetails<HTMLDetailsElement>();
  return (
    <details ref={detailsRef} className="scene-row-menu">
      <summary aria-label={tr(locale, "更多操作", "More actions")} title={tr(locale, "更多操作", "More actions")}>
        <MoreHorizontal size={15} />
      </summary>
      <div className="scene-row-menu-popover" onClick={(event) => {
        const details = event.currentTarget.parentElement;
        if (details instanceof HTMLDetailsElement) details.open = false;
      }}>
        {children}
        <SceneLayerMenuActions />
      </div>
    </details>
  );
}
