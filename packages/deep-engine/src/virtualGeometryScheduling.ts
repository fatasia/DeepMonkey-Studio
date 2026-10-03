import type { LodCamera, LodViewport } from "./spatial/index.js";
import type { VirtualGeometryDagPage, VirtualGeometryDagPageTable } from "./virtualGeometryDagPages.js";

/**
 * Nanite M3 —— 屏幕误差页调度:按投影像素误差对 DAG 做割(cut)选择。
 *
 * 投影口径与 spatial/lodValidation 同源:projectionScale = height/(2·tan(fov/2))
 * (透视)/ height/verticalSize(正交);页误差 e(世界单位)在球面视距 d 处的
 * 投影像素 = e·scale/d(球面视距 = 中心距 − 半径,保守)。割性质:请求的绘制页
 * 两两无祖先-后代关系,且每个根页区域恰有一条到被选页的路径 —— 相邻档只随
 * 相机连续变化,不出现同区域双份绘制。最细层误差恒 0,近距必然收敛到 level 0。
 */

/** 默认像素误差门(1px,Nanite 惯例);maxPixelError 上限防误配置。 */
export const DEEP_VIRTUAL_GEOMETRY_DEFAULT_PIXEL_ERROR = 1;
export const DEEP_VIRTUAL_GEOMETRY_MAX_PIXEL_ERROR = 1024;
export const DEEP_VIRTUAL_GEOMETRY_MIN_CAMERA_DISTANCE = 1e-9;

export interface VirtualGeometrySchedulingOptions {
  /** 投影误差门(像素)。页投影误差 ≤ 门 ⇒ 该页足够精细。 */
  readonly pixelErrorThreshold?: number;
}

export interface VirtualGeometryDagRequests {
  /** 本帧应绘制的页(割集,反链)。 */
  readonly drawPageIds: readonly string[];
  /** 绘制页 ∪ 全部祖先链(上传目标:绘制页的粗层回退必须先行驻留)。 */
  readonly pageIds: readonly string[];
  /** 投影比例因子(viewport 高 / 视口世界高),诊断用。 */
  readonly projectionScale: number;
}

/** 页在相机下的投影误差(像素)。 */
export function projectedErrorPixels(page: VirtualGeometryDagPage, camera: LodCamera,
  viewport: LodViewport, projectionScale = projectionScaleOf(camera, viewport)): number {
  const centerDistance = Math.hypot(
    camera.position[0]! - page.sphere[0]!,
    camera.position[1]! - page.sphere[1]!,
    camera.position[2]! - page.sphere[2]!,
  );
  const distance = Math.max(centerDistance - page.sphere[3]!, DEEP_VIRTUAL_GEOMETRY_MIN_CAMERA_DISTANCE);
  return page.error * projectionScale / distance;
}

/** 与 spatial/lodValidation 同口径的投影比例(viewport 高对应的世界/角跨度换算)。 */
export function projectionScaleOf(camera: LodCamera, viewport: LodViewport): number {
  if (viewport.width <= 0 || viewport.height <= 0
    || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) {
    throw new RangeError("Virtual geometry viewport dimensions must be positive finite numbers.");
  }
  if (camera.projection === "perspective") {
    if (!(camera.verticalFovRadians > 0) || camera.verticalFovRadians >= Math.PI) {
      throw new RangeError("Virtual geometry perspective verticalFovRadians must be in (0, π).");
    }
    return viewport.height / (2 * Math.tan(camera.verticalFovRadians * 0.5));
  }
  if (!(camera.verticalSize > 0) || !Number.isFinite(camera.verticalSize)) {
    throw new RangeError("Virtual geometry orthographic verticalSize must be a positive finite number.");
  }
  return viewport.height / camera.verticalSize;
}

/**
 * 屏幕误差割:从最粗层根页向下遍历,页投影误差 ≤ 门即选入割集并停在该子树,
 * 超门则下钻子页;到最细层仍超门时选最细页(优雅降级,不出现空洞)。
 */
export function buildVirtualGeometryDagRequests(table: VirtualGeometryDagPageTable,
  camera: LodCamera, viewport: LodViewport,
  options: VirtualGeometrySchedulingOptions = {}): VirtualGeometryDagRequests {
  const threshold = validateThreshold(options.pixelErrorThreshold);
  const scale = projectionScaleOf(camera, viewport);
  const drawPageIds: string[] = [];
  const pageIds = new Set<string>();
  // BFS 天然粗→细:根(最粗层)入队,子页晚一层。
  const queue = [...table.rootIds].sort();
  while (queue.length > 0) {
    const id = queue.shift()!;
    const page = table.byId.get(id);
    if (!page) throw new Error(`Virtual geometry scheduling referenced unknown page: ${id}.`);
    pageIds.add(id);
    if (projectedErrorPixels(page, camera, viewport, scale) <= threshold) {
      drawPageIds.push(page.id);
      continue;
    }
    if (page.childIds.length === 0) { drawPageIds.push(page.id); continue; } // 最细层保底
    queue.push(...page.childIds);
  }
  // 祖先链并入上传目标:绘制页的粗层回退必须先行驻留(链前缀不变量的请求侧)。
  for (const id of drawPageIds) {
    let cursor = table.byId.get(id);
    while (cursor?.parentId) { pageIds.add(cursor.parentId); cursor = table.byId.get(cursor.parentId); }
  }
  return Object.freeze({
    drawPageIds: Object.freeze(drawPageIds),
    pageIds: Object.freeze([...pageIds]),
    projectionScale: scale,
  });
}

function validateThreshold(value: number | undefined): number {
  const threshold = value ?? DEEP_VIRTUAL_GEOMETRY_DEFAULT_PIXEL_ERROR;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > DEEP_VIRTUAL_GEOMETRY_MAX_PIXEL_ERROR) {
    throw new RangeError(
      `Virtual geometry pixelErrorThreshold must be in (0, ${DEEP_VIRTUAL_GEOMETRY_MAX_PIXEL_ERROR}].`);
  }
  return threshold;
}

/**
 * 绘制集解析:割页在驻留集中取"自身或最细已驻留祖先"(draw-path fallback)。
 * 细页尚在流送时由粗层回退顶上,画面不断裂;解析结果仍是反链(不同割页的祖先
 * 链落在不相交的根子树内)。整链未驻留的割页跳过(仅出现在首批准入提交前的瞬态)。
 */
export function resolveVirtualGeometryDrawablePages(table: VirtualGeometryDagPageTable,
  cutPageIds: readonly string[], residentPageIds: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const drawable: string[] = [];
  for (const id of cutPageIds) {
    let cursor: string | null = id;
    while (cursor && !residentPageIds.has(cursor)) cursor = table.byId.get(cursor)?.parentId ?? null;
    if (cursor && !seen.has(cursor)) { seen.add(cursor); drawable.push(cursor); }
  }
  return drawable;
}
