import type { KeyboardEvent } from "react";

const rowSelector = "[data-layer-keyboard-row]";
const primarySelector = "[data-layer-primary],.asset-main,.layer-node-main,.scene-tree-name,.dashboard-layer-select,[role='treeitem'][tabindex='0']";
export type LayerKeyboardActionResult = "handled" | "blocked" | "unsupported";
export interface LayerKeyboardActions { rename?: (row: HTMLElement) => LayerKeyboardActionResult }

/** 只触发现有明确标记的行操作，不能用删除键隐式执行解组。 */
export function activateLayerRowAction(row: HTMLElement, action: "rename" | "delete"): LayerKeyboardActionResult {
  const button = [...row.querySelectorAll<HTMLButtonElement>(`button[data-layer-action="${action}"]`)]
    .find(candidate => candidate.closest(rowSelector) === row);
  if (!button) return "unsupported";
  if (button.disabled || button.matches(":disabled") || button.getAttribute("aria-disabled") === "true") return "blocked";
  button.click(); return "handled";
}

/** 输入法确认、文本编辑与菜单内部的方向键由控件自己处理。 */
export function layerKeyboardOccupied(event: Pick<KeyboardEvent, "target" | "nativeEvent">): boolean {
  const target = event.target as HTMLElement;
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
    || Boolean(target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'));
}

export function layerNavigationIndex(key: string, index: number, count: number): number | undefined {
  if (count === 0 || index < 0) return undefined;
  if (key === "ArrowDown") return Math.min(count - 1, index + 1);
  if (key === "ArrowUp") return Math.max(0, index - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}

export function focusLayerRow(row: HTMLElement | undefined): void {
  (row?.matches(primarySelector) ? row : row?.querySelector<HTMLElement>(primarySelector))?.focus();
}

/** 折叠后的子树不挂载；行标识只放在行头，避免父编组匹配到后代。 */
export function handleLayerTreeKeyDown(event: KeyboardEvent<HTMLElement>, navigate = true, actions?: LayerKeyboardActions): LayerKeyboardActionResult | undefined {
  if (event.defaultPrevented || layerKeyboardOccupied(event)) return;
  const target = event.target as HTMLElement;
  const menu = target.closest<HTMLDetailsElement>("details[open]");
  if (menu) {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); menu.open = false;
      menu.querySelector<HTMLElement>("summary")?.focus();
    }
    return;
  }
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const row = target.closest<HTMLElement>(rowSelector);
  if (!row || !event.currentTarget.contains(row)) return;
  if (event.key === "F2" || event.key === "Delete") {
    // 未支持的组/空间不能冒泡成“删除上一次画布选择”；长按也不重复打开确认框。
    event.preventDefault(); event.stopPropagation();
    if (event.repeat) return "blocked";
    const action = event.key === "F2" ? "rename" : "delete";
    const result = activateLayerRowAction(row, action);
    return result === "unsupported" && action === "rename" ? actions?.rename?.(row) ?? "unsupported" : result;
  }
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(rowSelector)];
  const index = rows.indexOf(row);
  const next = navigate ? layerNavigationIndex(event.key, index, rows.length) : undefined;
  if (next !== undefined) {
    event.preventDefault(); event.stopPropagation(); focusLayerRow(rows[next]); return;
  }
  const group = row.closest<HTMLElement>("[data-layer-keyboard-group]");
  const expander = row.querySelector<HTMLElement>("[data-layer-expander]");
  if (event.key === "ArrowRight" && expander) {
    event.preventDefault(); event.stopPropagation();
    if (group?.getAttribute("aria-expanded") === "false") expander.click();
    else focusLayerRow(group?.querySelector<HTMLElement>(`[role='group'] ${rowSelector}`) ?? undefined);
  } else if (event.key === "ArrowLeft" && group) {
    event.preventDefault(); event.stopPropagation();
    if (expander && group.getAttribute("aria-expanded") === "true") expander.click();
    else if (!expander) focusLayerRow(group.querySelector<HTMLElement>(rowSelector) ?? undefined);
  } else if (event.key === "Escape") {
    event.preventDefault(); event.stopPropagation(); focusLayerRow(row);
  }
}
