export interface SurfaceSize { readonly width: number; readonly height: number }

/** 隐藏表面不创建零尺寸纹理；保持纵横比并遵守设备纹理上限。 */
export function surfaceSize(width: number, height: number, ratio: number, limit: number): SurfaceSize | undefined {
  if (![width, height, ratio, limit].every(Number.isFinite) || width <= 0 || height <= 0 || ratio <= 0 || limit < 1) {
    return undefined;
  }
  const scale = Math.min(ratio, 2, limit / width, limit / height);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}
