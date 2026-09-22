import type { ViewerEngine } from "../viewer/ViewerEngine";
import type { LayerSelectionIntent } from "./layerSelection";

type RowEngine = Pick<ViewerEngine, "select" | "focusModel">;
interface RowClick { readonly detail: number; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly shiftKey: boolean; readonly currentTarget?: HTMLElement }
type SelectObject = (id: string, options: LayerSelectionIntent & { additive: boolean; range: boolean }) => void;

/** 双击的第二个 click 不再切换选择；键盘 click(detail=0)仍按普通单击处理。 */
export function selectSceneObjectRow(event: RowClick, id: string, engine: RowEngine | undefined, select?: SelectObject): void {
  if (event.detail > 1) return;
  if (select) {
    // 模型行由调用方闭包构造，目录边界携带完整可见顺序，避免虚拟列表 DOM 抽样。
    const scope = event.currentTarget?.closest<HTMLElement>("[data-layer-order]");
    const orderedIds: string[] | undefined = scope ? JSON.parse(scope.dataset.layerOrder ?? "[]") : undefined;
    if (scope && (!event.shiftKey || !scope.dataset.layerAnchor)) scope.dataset.layerAnchor = id;
    select(id, { additive: event.ctrlKey || event.metaKey, range: event.shiftKey,
      ...(orderedIds ? { orderedIds } : {}), ...(scope?.dataset.layerAnchor ? { anchorId: scope.dataset.layerAnchor } : {}) });
  }
  else engine?.select(id);
}

export function focusSceneObjectRow(id: string, engine: RowEngine | undefined): void {
  engine?.select(id);
  engine?.focusModel(id);
}
