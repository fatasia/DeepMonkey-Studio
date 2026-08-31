/** 单对象走选择端口；编组只修改未锁定对象。 */
export function applyGroupedOrSelected(groupedIds: readonly string[], isLocked: (id: string) => boolean, applyObject: (id: string) => void, applySelection: () => void): void {
  if (groupedIds.length > 1) {
    for (const id of groupedIds) if (!isLocked(id)) applyObject(id);
  } else {
    applySelection();
  }
}
