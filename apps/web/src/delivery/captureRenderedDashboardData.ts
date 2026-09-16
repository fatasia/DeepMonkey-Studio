import { captureDashboardDataLayout, type DashboardDataCaptureOptions, type DashboardTextCaptureBinding } from "./captureDashboardDataLayout";
import type { DashboardDataPaint, DashboardDataTextRole, DashboardFrozenData } from "./dashboardDataRasterTypes";

export type RenderedDashboardCaptureOptions = Pick<DashboardDataCaptureOptions, "logicalSize" | "resolveFonts">;

/** Read semantic bindings from the mounted production widget, including its current table state. */
export function captureRenderedDashboardData(root: HTMLElement, options: RenderedDashboardCaptureOptions):
  Pick<DashboardFrozenData, "layout" | "table"> {
  const kind = root.dataset.dashboardCapture, view = root.ownerDocument.defaultView;
  if (!view || !root.isConnected || !["value", "table"].includes(kind ?? ""))
    throw new Error("Capture requires a mounted value or report-table widget root");
  if (root.querySelector("[data-dashboard-capture]")) throw new Error("Nested widget capture is unsupported");
  const visible = (element: HTMLElement) => {
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      const style = view.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return true;
  };
  const text: DashboardTextCaptureBinding[] = [];
  for (const element of root.querySelectorAll<HTMLElement>("[data-capture-role]")) {
    if (!visible(element)) continue;
    const runs = [...element.childNodes].filter(node => node.nodeType === 3 && Boolean(node.textContent?.length));
    if (!runs.length && !element.textContent) continue;
    if (runs.length !== 1) throw new Error("Capture text must have exactly one direct text run");
    const run = runs[0]!;
    const range = root.ownerDocument.createRange(); range.selectNodeContents(run);
    text.push({ role: role(element), element, range });
  }
  const backgrounds = [root, ...root.querySelectorAll<HTMLElement>("[data-capture-background]")]
    .filter(element => element.hasAttribute("data-capture-background") && visible(element)
      && !["previous", "next"].includes(element.dataset.captureRole ?? ""));
  if (kind === "value") {
    if (!text.some(binding => binding.role.kind === "value")) throw new Error("Value capture is missing its numeric text");
    return { layout: captureDashboardDataLayout(root, { ...options, text, backgrounds }) };
  }
  const scroll = root.querySelector<HTMLElement>("[data-capture-scroll]");
  const page = Number(root.dataset.capturePage), column = root.dataset.captureSortColumn;
  const direction = root.dataset.captureSortDirection;
  if (!scroll || !Number.isSafeInteger(page) || page < 0 || !Number.isFinite(scroll.scrollLeft) || scroll.scrollLeft < 0
    || Boolean(column) !== Boolean(direction) || direction && direction !== "asc" && direction !== "desc")
    throw new Error("Invalid rendered table page, sort or scroll state");
  const tablePaint = paintOrder(root, text, backgrounds);
  return { layout: captureDashboardDataLayout(root, { ...options, text, backgrounds, tablePaint }),
    table: { page, scrollLeft: scroll.scrollLeft, ...(column && (direction === "asc" || direction === "desc") ? { sort: { column, direction } } : {}) } };
}

function role(element: HTMLElement): DashboardDataTextRole {
  const kind = element.dataset.captureRole, column = element.dataset.captureColumn;
  const row = Number(element.dataset.captureRow);
  if (["header", "sort", "total", "cell"].includes(kind ?? "") && !column) throw new Error("Missing captured table column");
  if (["cell", "row-number"].includes(kind ?? "") && (!element.hasAttribute("data-capture-row") || !Number.isSafeInteger(row) || row < 0))
    throw new Error("Invalid captured table row");
  if (kind === "cell") return { kind, row, column: column! };
  if (kind === "row-number") return { kind, row };
  if (kind === "header" || kind === "sort" || kind === "total") return { kind, column: column! };
  if (kind === "title" || kind === "value" || kind === "unit" || kind === "footer" || kind === "previous" || kind === "next" || kind === "row-number-header") return { kind };
  throw new Error("Unknown rendered data capture role");
}

function paintOrder(root: HTMLElement, text: readonly DashboardTextCaptureBinding[], backgrounds: readonly HTMLElement[]): DashboardDataPaint[] {
  const view = root.ownerDocument.defaultView!;
  const entries = [...backgrounds.map((element, index) => ({ element, entry: { kind: "background" as const, index } })),
    ...text.map(({ element }, index) => ({ element, entry: { kind: "text" as const, index } }))];
  const items = entries.map(item => {
    const owner = item.element.closest<HTMLElement>("th,td") ?? item.element;
    const style = view.getComputedStyle(owner);
    const rank = style.position === "sticky" ? style.zIndex === "auto" ? 1 : Number(style.zIndex) : 0;
    if (!Number.isFinite(rank)) throw new Error("Unknown measured paint rank");
    return { ...item, owner, rank };
  });
  items.sort((a, b) => a.rank - b.rank || (a.owner === b.owner
    ? (a.entry.kind === b.entry.kind ? 0 : a.entry.kind === "background" ? -1 : 1)
    : a.owner.compareDocumentPosition(b.owner) & 4 ? -1 : 1));
  return items.map(item => item.entry);
}
