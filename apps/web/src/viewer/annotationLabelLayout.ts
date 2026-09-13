export interface AnnotationLabelLayoutCandidate {
  id: string;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  distance: number;
  selected: boolean;
}

/**
 * 为密集设备标签选择稳定的可见集合。
 * 选中标签始终优先，其余标签按距离和 ID 稳定排序，避免相机静止时闪烁。
 */
export function visibleAnnotationLabelIds(
  candidates: readonly AnnotationLabelLayoutCandidate[],
  viewportWidth: number,
  viewportHeight: number,
  padding = 12,
): Set<string> {
  const visible = new Set<string>();
  const occupied: ScreenRectangle[] = [];
  // 小集合线性扫描更便宜；密集标签只查询相邻屏幕网格，优先级与精确相交规则不变。
  let grid: LabelRectangleGrid | undefined;
  const ordered = [...candidates].sort((left, right) => {
    if (left.selected !== right.selected) return left.selected ? -1 : 1;
    if (left.distance !== right.distance) return left.distance - right.distance;
    return left.id.localeCompare(right.id);
  });

  for (const candidate of ordered) {
    const rectangle = candidateRectangle(candidate, padding);
    if (!candidate.selected && !fitsViewport(rectangle, viewportWidth, viewportHeight)) continue;
    if (!candidate.selected && (grid ? grid.intersects(rectangle) : occupied.some((current) => intersects(current, rectangle)))) continue;
    visible.add(candidate.id);
    if (grid) grid.add(rectangle);
    else {
      occupied.push(rectangle);
      if (occupied.length === 128 && candidates.length >= 512) {
        grid = new LabelRectangleGrid();
        occupied.forEach(current => grid!.add(current));
      }
    }
  }
  return visible;
}

interface ScreenRectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

class LabelRectangleGrid {
  private readonly cells = new Map<number, Map<number, ScreenRectangle[]>>();
  private readonly oversized: ScreenRectangle[] = [];
  private readonly all: ScreenRectangle[] = [];

  add(rectangle: ScreenRectangle): void {
    this.all.push(rectangle);
    const range = this.range(rectangle);
    // 极大选中标签可超出视口，不能因此创建无界网格。
    if (!range) { this.oversized.push(rectangle); return; }
    for (let x = range.left; x <= range.right; x += 1) {
      let column = this.cells.get(x);
      if (!column) { column = new Map(); this.cells.set(x, column); }
      for (let y = range.top; y <= range.bottom; y += 1) {
        const cell = column.get(y);
        if (cell) cell.push(rectangle);
        else column.set(y, [rectangle]);
      }
    }
  }

  intersects(rectangle: ScreenRectangle): boolean {
    const range = this.range(rectangle);
    if (!range) return this.all.some(current => intersects(current, rectangle));
    if (this.oversized.some(current => intersects(current, rectangle))) return true;
    for (let x = range.left; x <= range.right; x += 1) {
      const column = this.cells.get(x);
      if (!column) continue;
      for (let y = range.top; y <= range.bottom; y += 1) {
        if (column.get(y)?.some(current => intersects(current, rectangle))) return true;
      }
    }
    return false;
  }

  private range(rectangle: ScreenRectangle): ScreenRectangle | undefined {
    const range = { left: Math.floor(rectangle.left / 128), top: Math.floor(rectangle.top / 128),
      right: Math.floor(rectangle.right / 128), bottom: Math.floor(rectangle.bottom / 128) };
    if (!Number.isFinite(range.left + range.top + range.right + range.bottom)
      || (range.right - range.left + 1) * (range.bottom - range.top + 1) > 256) return undefined;
    return range;
  }
}

function candidateRectangle(candidate: AnnotationLabelLayoutCandidate, padding: number): ScreenRectangle {
  const halfWidth = Math.max(candidate.width, 1) / 2 + padding;
  const halfHeight = Math.max(candidate.height, 1) / 2 + padding;
  return {
    left: candidate.centerX - halfWidth,
    top: candidate.centerY - halfHeight,
    right: candidate.centerX + halfWidth,
    bottom: candidate.centerY + halfHeight,
  };
}

function intersects(left: ScreenRectangle, right: ScreenRectangle): boolean {
  return left.left < right.right
    && left.right > right.left
    && left.top < right.bottom
    && left.bottom > right.top;
}

function fitsViewport(rectangle: ScreenRectangle, width: number, height: number): boolean {
  return rectangle.left >= 0
    && rectangle.top >= 0
    && rectangle.right <= Math.max(width, 1)
    && rectangle.bottom <= Math.max(height, 1);
}
