import type { ViewerEngine } from "../viewer/ViewerEngine";

type RowEngine = Pick<ViewerEngine, "select" | "focusModel">;
interface RowClick { readonly detail: number; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly shiftKey: boolean }
type SelectObject = (id: string, options: { additive: boolean; range: boolean }) => void;

/** 双击的第二个 click 不再切换选择；键盘 click(detail=0)仍按普通单击处理。 */
export function selectSceneObjectRow(event: RowClick, id: string, engine: RowEngine | undefined, select?: SelectObject): void {
  if (event.detail > 1) return;
  if (select) select(id, { additive: event.ctrlKey || event.metaKey, range: event.shiftKey });
  else engine?.select(id);
}

export function focusSceneObjectRow(id: string, engine: RowEngine | undefined): void {
  engine?.select(id);
  engine?.focusModel(id);
}
