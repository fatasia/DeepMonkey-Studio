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
  const ordered = [...candidates].sort((left, right) => {
    if (left.selected !== right.selected) return left.selected ? -1 : 1;
    if (left.distance !== right.distance) return left.distance - right.distance;
    return left.id.localeCompare(right.id);
  });

  for (const candidate of ordered) {
    const rectangle = candidateRectangle(candidate, padding);
    if (!candidate.selected && !fitsViewport(rectangle, viewportWidth, viewportHeight)) continue;
    if (!candidate.selected && occupied.some((current) => intersects(current, rectangle))) continue;
    visible.add(candidate.id);
    occupied.push(rectangle);
  }
  return visible;
}

interface ScreenRectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
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
