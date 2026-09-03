export interface BehaviorFloatRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BehaviorFloatViewport {
  width: number;
  height: number;
}

export function defaultBehaviorFloatRect(viewport: BehaviorFloatViewport): BehaviorFloatRect {
  const width = Math.min(1_040, Math.max(320, viewport.width - 48));
  const height = Math.min(680, Math.max(260, viewport.height - 92));
  return clampBehaviorFloatRect({
    x: Math.round((viewport.width - width) / 2),
    y: 68,
    width,
    height,
  }, viewport);
}

export function clampBehaviorFloatRect(rect: BehaviorFloatRect, viewport: BehaviorFloatViewport): BehaviorFloatRect {
  const compact = viewport.width <= 760;
  const margin = compact ? 6 : 12;
  const minimumTop = compact ? 68 : 60;
  const maximumWidth = Math.max(320, viewport.width - margin * 2);
  const maximumHeight = Math.max(260, viewport.height - minimumTop - margin);
  const minimumWidth = Math.min(compact ? 320 : 640, maximumWidth);
  const minimumHeight = Math.min(compact ? 260 : 420, maximumHeight);
  const width = clamp(finite(rect.width, maximumWidth), minimumWidth, maximumWidth);
  const height = clamp(finite(rect.height, maximumHeight), minimumHeight, maximumHeight);
  return {
    x: clamp(finite(rect.x, margin), margin, Math.max(margin, viewport.width - margin - width)),
    y: clamp(finite(rect.y, minimumTop), minimumTop, Math.max(minimumTop, viewport.height - margin - height)),
    width,
    height,
  };
}

export function moveBehaviorFloatRect(
  rect: BehaviorFloatRect,
  deltaX: number,
  deltaY: number,
  viewport: BehaviorFloatViewport,
): BehaviorFloatRect {
  return clampBehaviorFloatRect({ ...rect, x: rect.x + deltaX, y: rect.y + deltaY }, viewport);
}

export function resizeBehaviorFloatRect(
  rect: BehaviorFloatRect,
  deltaWidth: number,
  deltaHeight: number,
  viewport: BehaviorFloatViewport,
): BehaviorFloatRect {
  return clampBehaviorFloatRect({ ...rect, width: rect.width + deltaWidth, height: rect.height + deltaHeight }, viewport);
}

export function parseBehaviorFloatRect(value: string | null, viewport: BehaviorFloatViewport): BehaviorFloatRect {
  if (!value) return defaultBehaviorFloatRect(viewport);
  try {
    const parsed = JSON.parse(value) as Partial<BehaviorFloatRect>;
    if ([parsed.x, parsed.y, parsed.width, parsed.height].every((item) => typeof item === "number" && Number.isFinite(item))) {
      return clampBehaviorFloatRect(parsed as BehaviorFloatRect, viewport);
    }
  } catch {
    // Invalid preferences fall back to a usable centered window.
  }
  return defaultBehaviorFloatRect(viewport);
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
