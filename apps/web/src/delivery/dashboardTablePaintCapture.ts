import type { DashboardTextCaptureBinding } from "./captureDashboardDataLayout";
import type { DashboardDataPaint } from "./dashboardDataRasterTypes";
import { dashboardDataPaint } from "./dashboardDataPaint";

/** Validate an adapter-supplied order for the existing report table's bounded CSS. */
export function validateDashboardTablePaint(root: HTMLElement, text: readonly DashboardTextCaptureBinding[],
  backgrounds: readonly HTMLElement[], paint: readonly DashboardDataPaint[]): void {
  dashboardDataPaint({ textBoxes: text as never, backgrounds: backgrounds as never, paint });
  const view = root.ownerDocument.defaultView;
  if (!view) throw new Error("Measured table paint needs a document");
  const table = root.querySelector("table.freeze-first-column");
  if (!table || root.querySelectorAll("table").length !== 1) throw new Error("Expected one frozen report table");
  const items = paint.map(entry => {
    const element = entry.kind === "background" ? backgrounds[entry.index]! : text[entry.index]!.element;
    if (!root.contains(element)) throw new Error("Paint element is outside the table widget");
    const cell = element.closest("td,th");
    if (cell && cell.closest("table") !== table) throw new Error("Nested table paint is unsupported");
    const owner = cell as HTMLElement | null ?? element;
    let rank = 0;
    for (let current: HTMLElement | null = element; current && current !== root; current = current.parentElement) {
      const style = view.getComputedStyle(current);
      if ((style.transform && style.transform !== "none") || (style.isolation && style.isolation !== "auto")
        || (style.mixBlendMode && style.mixBlendMode !== "normal")) throw new Error("Nested paint contexts are unsupported");
      if (current === cell && style.position === "sticky") {
        if (!["auto", "2", "4"].includes(style.zIndex)) throw new Error("Unknown frozen-cell stacking level");
        rank = style.zIndex === "auto" ? 1 : Number(style.zIndex);
      } else if ((style.zIndex && style.zIndex !== "auto") || (style.position && style.position !== "static"))
        throw new Error("Unsupported table paint positioning");
    }
    return { entry, element, owner, rank };
  });
  for (let index = 1; index < items.length; index++) {
    const previous = items[index - 1]!, next = items[index]!;
    if (next.rank < previous.rank) throw new Error("Paint order disagrees with measured stacking levels");
    if (next.rank !== previous.rank) continue;
    if (previous.owner !== next.owner) {
      if (!(previous.owner.compareDocumentPosition(next.owner) & 4)) throw new Error("Paint order disagrees with DOM order");
    } else if (previous.entry.kind === "text" && next.entry.kind === "background") {
      throw new Error("A cell background must precede its text");
    }
  }
  for (const cell of table.querySelectorAll("td,th")) {
    const style = view.getComputedStyle(cell);
    if (style.position === "sticky" && style.visibility === "visible" && style.display !== "none"
      && cell.getBoundingClientRect().width > 0 && !backgrounds.includes(cell as HTMLElement))
      throw new Error("A visible sticky cell is missing its measured background");
  }
}
