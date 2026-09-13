export interface SceneRowSize { key: string; estimateHeight?: number; keepMounted?: boolean }

export function sceneRowOffsets(rows: readonly SceneRowSize[], measured: ReadonlyMap<string, number>, defaultHeight: number) {
  const offsets = [0];
  for (const row of rows) offsets.push(offsets[offsets.length - 1]! + (measured.get(row.key) ?? row.estimateHeight ?? defaultHeight));
  return offsets;
}

/** 半开区间；树可在同一个滚动容器内嵌套，完全离开视口的子树不创建行。 */
export function visibleSceneRows(offsets: readonly number[], top: number, height: number, overscan = 160) {
  const count = offsets.length - 1, total = offsets[count] ?? 0;
  const startY = Math.max(0, top - overscan), endY = Math.min(total, top + height + overscan);
  if (!count || endY <= 0 || startY >= total) return { start: 0, end: 0 };
  const first = (value: number) => {
    let low = 0, high = count;
    while (low < high) { const mid = (low + high) >>> 1; if (offsets[mid + 1]! <= value) low = mid + 1; else high = mid; }
    return low;
  };
  return { start: first(startY), end: Math.min(count, first(endY) + 1) };
}

export function sceneRowScrollDelta(rowTop: number, rowBottom: number, viewportTop: number, viewportHeight: number) {
  if (rowTop < viewportTop) return rowTop - viewportTop;
  if (rowBottom > viewportTop + viewportHeight) return Math.min(rowTop - viewportTop, rowBottom - viewportTop - viewportHeight);
  return 0;
}
