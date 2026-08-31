export interface AnnotationLabelPresentationInput {
  distance: number;
  verticalFovDegrees: number;
  viewportHeightPx: number;
  authoredSize: number;
  hasDescription: boolean;
  selected: boolean;
}

export interface AnnotationLabelPresentation {
  scaleMultiplier: number;
  opacity: number;
  visible: boolean;
  estimatedHeightPx: number;
}

const LABEL_WORLD_HEIGHT = 0.6;

/**
 * 将作者尺寸转换为稳定的屏幕视觉权重。
 * 普通标签只在有限范围内补偿距离，极远时逐渐隐藏；选中标签始终保持可读。
 */
export function annotationLabelPresentation(input: AnnotationLabelPresentationInput): AnnotationLabelPresentation {
  const distance = Math.max(input.distance, 0.01);
  const viewportHeight = Math.max(input.viewportHeightPx, 1);
  const fovRadians = clamp(input.verticalFovDegrees, 1, 179) * Math.PI / 180;
  const authoredSize = clamp(input.authoredSize, 0.35, 3);
  const worldHeightPerPixel = 2 * distance * Math.tan(fovRadians / 2) / viewportHeight;
  const preferredPixels = clamp((input.hasDescription ? 50 : 40) * Math.sqrt(authoredSize), 24, 96);
  const authoredWorldHeight = LABEL_WORLD_HEIGHT * authoredSize;
  const requestedMultiplier = preferredPixels * worldHeightPerPixel / authoredWorldHeight;
  const maximumMultiplier = input.selected ? 20 : 3.4;
  const scaleMultiplier = clamp(requestedMultiplier, 0.06, maximumMultiplier);
  const estimatedHeightPx = authoredWorldHeight * scaleMultiplier / worldHeightPerPixel;

  if (input.selected) {
    return { scaleMultiplier, opacity: 1, visible: true, estimatedHeightPx };
  }
  // 过远后不再无限放大；先降低透明度，再隐藏，避免标签海永久遮挡模型。
  const opacity = clamp((estimatedHeightPx - 10) / 14, 0, 0.96);
  return {
    scaleMultiplier,
    opacity,
    visible: estimatedHeightPx >= 12,
    estimatedHeightPx,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
