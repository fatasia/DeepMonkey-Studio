/**
 * 逐类适配:认证过的输入 → 批量 display delta + 行为命令。
 * 与 Native `adapter_n1/adapt.rs` + `chart_overlay.rs` 同构:资源身份与预算
 * 全部由宿主注入,适配器不发明资源、不读时钟、不做 IO;所有拒绝携带显式原因,
 * 绝不截断、不降级、不猜测。
 */

import {
  DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION,
  type Deep2dColor, type Deep2dCommand, type Deep2dPathVerb, type Deep2dResource,
} from "../deep2dDisplayList.js";
import {
  MAX_DRAW_VALUE, MAX_STROKE_WIDTH, N1Rejection,
  requireBoundedCoordinate, requireColor, requireId, requirePositive, requirePositiveBounded, stableNodeId,
} from "./validation.js";
import { parseSvgPathSubset } from "./svgPathSubset.js";
import type {
  AnimationAbiInput, AnimationTrack, AnimationValue, ChartExtensionInput, ChartOverlay,
  N1Adapted, N1BehaviorAction, N1Budget, N1DisplayDelta, SvgInputV1,
} from "./types.js";

/** 单位仿射矩阵:适配产出的命令几何即输入几何,摆放归宿主。 */
export const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0] as const;
/** 圆形 marker 的四段三次贝塞尔近似常数(kappa)。 */
const CIRCLE_KAPPA = 0.552_284_749_830_793_6;

export function emptyDelta(): N1DisplayDelta {
  return { schemaVersion: DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION, resources: [], commands: [] };
}

export function derivedCommandId(id: string): string {
  requireId(id, "derived command id");
  return id;
}

/** 统一出口:总命令预算复核后打包。 */
export function finish(delta: N1DisplayDelta, kind: N1Adapted["kind"], commandCount: number, budget: N1Budget): N1Adapted {
  if (commandCount > budget.maxCommands) throw new N1Rejection(`command budget exceeded: ${commandCount} commands > max ${budget.maxCommands}`);
  return { kind, delta, actions: [] };
}

export function adaptSvgInput(input: SvgInputV1, budget: N1Budget): N1Adapted {
  requireId(input.id, "svg input id");
  if (input.paths.length > budget.maxPaths) {
    throw new N1Rejection(`svg path budget exceeded: ${input.paths.length} paths > max ${budget.maxPaths}`);
  }
  requireBoundedCoordinate(input.viewBox[0], "viewBox.minX");
  requireBoundedCoordinate(input.viewBox[1], "viewBox.minY");
  requirePositive(input.viewBox[2], "viewBox.width");
  requirePositive(input.viewBox[3], "viewBox.height");
  const resources: Deep2dResource[] = [];
  const commands: Deep2dCommand[] = [];
  const seenIds = new Set<string>();
  for (const path of input.paths) {
    requireId(path.id, "svg path id");
    // 重复资源 id 会让 delta 无法并入同一 display list(deep2d 合同),在适配层即拒绝。
    if (seenIds.has(path.id)) throw new N1Rejection(`duplicate svg path id '${path.id}'`);
    seenIds.add(path.id);
    if (path.fill === undefined && path.stroke === undefined) {
      throw new N1Rejection(`svg path '${path.id}' requires fill or stroke (empty paint is rejected)`);
    }
    if (path.fill !== undefined) requireColor(path.fill, `path '${path.id}' fill`);
    if (path.stroke !== undefined) requireColor(path.stroke, `path '${path.id}' stroke`);
    if (path.strokeWidth !== undefined) requirePositiveBounded(path.strokeWidth, MAX_STROKE_WIDTH, `path '${path.id}' strokeWidth`);
    let verbs: Deep2dPathVerb[];
    try {
      verbs = parseSvgPathSubset(path.data);
    } catch (error) {
      const detail = error instanceof N1Rejection ? error.reason : String(error);
      throw new N1Rejection(`svg path '${path.id}' rejected: ${detail}`);
    }
    if (verbs.length > budget.maxVerbsPerPath) {
      throw new N1Rejection(`svg path '${path.id}' exceeds the verb budget: ${verbs.length} > max ${budget.maxVerbsPerPath}`);
    }
    resources.push({ kind: "path", id: path.id, revision: 0, verbs });
    commands.push({
      kind: "path",
      id: derivedCommandId(`${path.id}.paint`),
      zOrder: path.zOrder,
      transform: IDENTITY_MATRIX,
      pathId: path.id,
      ...(path.fill !== undefined ? { fill: path.fill } : {}),
      // stroke 风格字段只允许伴随 stroke 颜色出现(deep2d 合同)。
      ...(path.stroke !== undefined
        ? { stroke: path.stroke, lineCap: "butt" as const, lineJoin: "miter" as const, ...(path.strokeWidth !== undefined ? { strokeWidth: path.strokeWidth } : {}) }
        : {}),
    });
  }
  return finish({ ...emptyDelta(), resources, commands }, "svg", input.paths.length, budget);
}

export function adaptChartExtensionInput(input: ChartExtensionInput, budget: N1Budget): N1Adapted {
  requireId(input.id, "chart extension id");
  if (input.overlays.length > budget.maxPaths) {
    throw new N1Rejection(`chart overlay budget exceeded: ${input.overlays.length} overlays > max ${budget.maxPaths}`);
  }
  const resources: Deep2dResource[] = [];
  const commands: Deep2dCommand[] = [];
  const seenIds = new Set<string>();
  for (const overlay of input.overlays) {
    const { id, zOrder, verbs, paint } = overlayVerbs(overlay);
    if (seenIds.has(id)) throw new N1Rejection(`duplicate chart overlay id '${id}'`);
    seenIds.add(id);
    resources.push({ kind: "path", id, revision: 0, verbs });
    commands.push({
      kind: "path",
      id: derivedCommandId(`${id}.paint`),
      zOrder,
      transform: IDENTITY_MATRIX,
      pathId: id,
      ...(paint.fill !== undefined ? { fill: paint.fill } : {}),
      // stroke 风格字段只允许伴随 stroke 颜色出现(deep2d 合同)。
      ...(paint.stroke !== undefined
        ? { stroke: paint.stroke, lineCap: "butt" as const, lineJoin: "miter" as const, ...(paint.strokeWidth !== undefined ? { strokeWidth: paint.strokeWidth } : {}) }
        : {}),
    });
  }
  return finish({ ...emptyDelta(), resources, commands }, "chart-extension", input.overlays.length, budget);
}

interface OverlayPaint {
  readonly fill?: Deep2dColor;
  readonly stroke?: Deep2dColor;
  readonly strokeWidth?: number;
}

/** 趋势线 = M+L;阈值带 = 矩形闭合;标记点 = 四段贝塞尔圆(kappa 常数,双跑一致)。 */
function overlayVerbs(overlay: ChartOverlay): {
  id: string; zOrder: number; verbs: Deep2dPathVerb[]; paint: OverlayPaint;
} {
  if (overlay.overlay === "trend-line") {
    requireId(overlay.id, "trend line id");
    overlay.points.forEach(([x, y], index) => {
      requireBoundedCoordinate(x, `trend line '${overlay.id}' point ${index} x`);
      requireBoundedCoordinate(y, `trend line '${overlay.id}' point ${index} y`);
    });
    requireColor(overlay.stroke, `trend line '${overlay.id}' stroke`);
    requirePositiveBounded(overlay.strokeWidth, MAX_STROKE_WIDTH, `trend line '${overlay.id}' strokeWidth`);
    const [[x0, y0], [x1, y1]] = overlay.points;
    return {
      id: overlay.id, zOrder: overlay.zOrder,
      verbs: [{ op: "move", x: x0, y: y0 }, { op: "line", x: x1, y: y1 }],
      paint: { stroke: overlay.stroke, strokeWidth: overlay.strokeWidth },
    };
  }
  if (overlay.overlay === "threshold-band") {
    requireId(overlay.id, "threshold band id");
    requireBoundedCoordinate(overlay.x0, `band '${overlay.id}' x0`);
    requireBoundedCoordinate(overlay.y0, `band '${overlay.id}' y0`);
    requireBoundedCoordinate(overlay.x1, `band '${overlay.id}' x1`);
    requireBoundedCoordinate(overlay.y1, `band '${overlay.id}' y1`);
    if (overlay.x1 <= overlay.x0 || overlay.y1 <= overlay.y0) {
      throw new N1Rejection(`threshold band '${overlay.id}' is degenerate (requires x1 > x0 and y1 > y0)`);
    }
    requireColor(overlay.fill, `band '${overlay.id}' fill`);
    return {
      id: overlay.id, zOrder: overlay.zOrder,
      verbs: [
        { op: "move", x: overlay.x0, y: overlay.y0 }, { op: "line", x: overlay.x1, y: overlay.y0 },
        { op: "line", x: overlay.x1, y: overlay.y1 }, { op: "line", x: overlay.x0, y: overlay.y1 },
        { op: "close" },
      ],
      paint: { fill: overlay.fill },
    };
  }
  requireId(overlay.id, "marker id");
  requireBoundedCoordinate(overlay.center[0], `marker '${overlay.id}' center x`);
  requireBoundedCoordinate(overlay.center[1], `marker '${overlay.id}' center y`);
  requirePositiveBounded(overlay.radius, MAX_DRAW_VALUE, `marker '${overlay.id}' radius`);
  requireColor(overlay.fill, `marker '${overlay.id}' fill`);
  return { id: overlay.id, zOrder: overlay.zOrder, verbs: circleVerbs(overlay.center, overlay.radius), paint: { fill: overlay.fill } };
}

function circleVerbs([cx, cy]: readonly [number, number], radius: number): Deep2dPathVerb[] {
  const k = CIRCLE_KAPPA * radius;
  const right = { x: cx + radius, y: cy };
  const top = { x: cx, y: cy - radius };
  const left = { x: cx - radius, y: cy };
  const bottom = { x: cx, y: cy + radius };
  return [
    { op: "move", x: right.x, y: right.y },
    { op: "cubic", c1x: right.x, c1y: right.y + k, c2x: bottom.x + k, c2y: bottom.y, x: bottom.x, y: bottom.y },
    { op: "cubic", c1x: bottom.x - k, c1y: bottom.y, c2x: left.x, c2y: left.y + k, x: left.x, y: left.y },
    { op: "cubic", c1x: left.x, c1y: left.y - k, c2x: top.x - k, c2y: top.y, x: top.x, y: top.y },
    { op: "cubic", c1x: top.x + k, c1y: top.y, c2x: right.x, c2y: right.y - k, x: right.x, y: right.y },
    { op: "close" },
  ];
}

/** 动画 ABI:在注入时刻做关键帧阶梯采样(取 atMs <= elapsed 的最后一帧;早于首帧保持首帧)。 */
export function adaptAnimationAbiInput(input: AnimationAbiInput, elapsedMs: number, budget: N1Budget): N1Adapted {
  requireId(input.id, "animation input id");
  if (input.tracks.length > budget.maxAnimationTracks) {
    throw new N1Rejection(`animation track budget exceeded: ${input.tracks.length} tracks > max ${budget.maxAnimationTracks}`);
  }
  const actions: N1BehaviorAction[] = input.tracks.map((track) => {
    validateAnimationTrack(track, budget);
    const sampled = [...track.keyframes].reverse().find((keyframe) => keyframe.atMs <= elapsedMs) ?? track.keyframes[0]!;
    return { kind: "set-property", nodeId: track.nodeId, property: track.property, value: toScalar(sampled.value) };
  });
  if (actions.length > budget.maxCommands) {
    throw new N1Rejection(`command budget exceeded: ${actions.length} actions > max ${budget.maxCommands}`);
  }
  return { kind: "animation-abi", delta: emptyDelta(), actions };
}

function toScalar(value: AnimationValue): N1BehaviorAction["value"] {
  if (value.kind === "number") return { kind: "number", value: value.value };
  if (value.kind === "bool") return { kind: "bool", value: value.value };
  return { kind: "index", value: value.value };
}

function validateAnimationTrack(track: AnimationTrack, budget: N1Budget): void {
  if (!stableNodeId(track.nodeId)) throw new N1Rejection(`animation track node id '${track.nodeId}' is not a stable id`);
  if (track.keyframes.length === 0) throw new N1Rejection(`animation track '${track.nodeId}' requires at least one keyframe`);
  if (track.keyframes.length > budget.maxKeyframesPerTrack) {
    throw new N1Rejection(`animation track '${track.nodeId}' exceeds the keyframe budget: ${track.keyframes.length} > max ${budget.maxKeyframesPerTrack}`);
  }
  for (const keyframe of track.keyframes) {
    if (keyframe.value.kind === "number" && !Number.isFinite(keyframe.value.value)) {
      throw new N1Rejection(`animation track '${track.nodeId}' keyframe value must be finite`);
    }
  }
  for (let index = 1; index < track.keyframes.length; index += 1) {
    if (track.keyframes[index]!.atMs <= track.keyframes[index - 1]!.atMs) {
      throw new N1Rejection(`animation track '${track.nodeId}' keyframes must be strictly increasing in atMs`);
    }
  }
}
