import { aabbCenter, aabbHalfExtents } from "./bounds.js";
import {
  DEEP_SCREEN_SPACE_LOD_LIMITS,
  validateBudget,
  validateCamera,
  validateLodObjects,
  validateSelectorOptions,
  type ValidatedLodCamera,
  type ValidatedLodObject,
} from "./lodValidation.js";
import type {
  LodCamera,
  LodFrameBudget,
  LodSelectionReason,
  LodViewport,
  ScreenSpaceLodFrameResult,
  ScreenSpaceLodObject,
  ScreenSpaceLodSelection,
  ScreenSpaceLodSelectorConfiguration,
  ScreenSpaceLodSelectorOptions,
} from "./lodTypes.js";
import type { SpatialItemId } from "./types.js";

export { DEEP_SCREEN_SPACE_LOD_LIMITS } from "./lodValidation.js";

interface ProjectedMetrics {
  readonly visible: boolean;
  readonly diameterPixels: number;
  readonly pixelsPerWorldUnit: number;
}

interface WorkingSelection<TId extends SpatialItemId> {
  readonly object: ValidatedLodObject<TId>;
  readonly metrics: ProjectedMetrics;
  readonly baseLevel: number;
  readonly preferredLevel: number;
  selectedLevel: number | null;
  reason: LodSelectionReason;
}

/** Stateful screen-space LOD selection with bounded hysteresis memory. */
export class ScreenSpaceLodSelector<TId extends SpatialItemId = string> {
  readonly options: Readonly<ScreenSpaceLodSelectorConfiguration>;

  private readonly previousLevels = new Map<TId, number>();
  private stateRevision = 0;

  constructor(options: ScreenSpaceLodSelectorOptions = {}) {
    this.options = validateSelectorOptions(options);
  }

  get trackedObjects(): number {
    return this.previousLevels.size;
  }

  get revision(): number {
    return this.stateRevision;
  }

  remove(id: TId): boolean {
    const removed = this.previousLevels.delete(id);
    if (removed) this.stateRevision += 1;
    return removed;
  }

  resetForCameraJump(): void {
    this.previousLevels.clear();
    this.stateRevision += 1;
  }

  reset(): void {
    this.resetForCameraJump();
  }

  selectFrame(
    objects: readonly ScreenSpaceLodObject<TId>[],
    camera: LodCamera,
    viewport: LodViewport,
    budget: LodFrameBudget = {},
  ): ScreenSpaceLodFrameResult<TId> {
    // No state changes occur until every camera, object, level and budget has passed validation.
    const validatedCamera = validateCamera(camera, viewport);
    const validatedBudget = validateBudget(budget, this.options.maxTrackedObjects);
    const validatedObjects = validateLodObjects(objects, this.options);
    const working = validatedObjects.map((object) => this.projectObject(object, validatedCamera));

    applyObjectBudget(working, validatedBudget.maxObjects);
    applyTriangleBudget(working, validatedBudget.maxTriangles);
    const selections = working.map(freezeSelection).sort((left, right) => compareIds(left.id, right.id));
    let renderedObjects = 0;
    let renderedTriangles = 0;
    for (const selection of selections) {
      if (selection.selectedLevel === null) continue;
      renderedObjects += 1;
      renderedTriangles += selection.triangles;
    }
    const nextRevision = this.stateRevision + 1;
    const result: ScreenSpaceLodFrameResult<TId> = Object.freeze({
      selections: Object.freeze(selections),
      renderedObjects,
      renderedTriangles,
      trackedObjects: validatedObjects.length,
      revision: nextRevision,
    });

    // Replace, rather than append to, hysteresis state so disappeared objects cannot leak memory.
    this.previousLevels.clear();
    for (const selection of working) this.previousLevels.set(selection.object.id, selection.preferredLevel);
    this.stateRevision = nextRevision;
    return result;
  }

  private projectObject(
    object: ValidatedLodObject<TId>,
    camera: ValidatedLodCamera,
  ): WorkingSelection<TId> {
    const metrics = projectBounds(object, camera);
    const baseLevel = baseLevelForDiameter(object, metrics.diameterPixels);
    const previous = this.previousLevels.get(object.id);
    const preferredLevel = previous === undefined || previous >= object.levels.length
      ? baseLevel
      : levelWithHysteresis(object, previous, baseLevel, metrics.diameterPixels);
    return {
      object,
      metrics,
      baseLevel,
      preferredLevel,
      selectedLevel: metrics.visible ? preferredLevel : null,
      reason: metrics.visible ? "preferred" : "depth-range",
    };
  }
}

function projectBounds<TId extends SpatialItemId>(
  object: ValidatedLodObject<TId>,
  camera: ValidatedLodCamera,
): ProjectedMetrics {
  const center = aabbCenter(object.bounds);
  const half = aabbHalfExtents(object.bounds);
  const radius = Math.hypot(...half);
  const dx = center[0] - camera.position[0];
  const dy = center[1] - camera.position[1];
  const dz = center[2] - camera.position[2];
  const depth = dx * camera.forward[0] + dy * camera.forward[1] + dz * camera.forward[2];
  const visible = depth + radius >= camera.near && depth - radius <= camera.far;
  if (!visible) return Object.freeze({ visible: false, diameterPixels: 0, pixelsPerWorldUnit: 0 });
  const pixelsPerWorldUnit = camera.projection === "perspective"
    ? camera.projectionScale / Math.max(depth, camera.near)
    : camera.projectionScale;
  const diameterPixels = radius * 2 * pixelsPerWorldUnit;
  return Object.freeze({ visible: true, diameterPixels, pixelsPerWorldUnit });
}

function baseLevelForDiameter<TId extends SpatialItemId>(
  object: ValidatedLodObject<TId>,
  diameter: number,
): number {
  const level = object.levels.findIndex((candidate) => diameter >= candidate.minProjectedDiameterPixels);
  return level < 0 ? object.levels.length - 1 : level;
}

function levelWithHysteresis<TId extends SpatialItemId>(
  object: ValidatedLodObject<TId>,
  previous: number,
  base: number,
  diameter: number,
): number {
  let level = previous;
  while (level > base) {
    const finerThreshold = object.levels[level - 1]!.minProjectedDiameterPixels;
    if (diameter < finerThreshold * (1 + object.hysteresisRatio)) break;
    level -= 1;
  }
  while (level < base) {
    const currentThreshold = object.levels[level]!.minProjectedDiameterPixels;
    if (diameter >= currentThreshold * (1 - object.hysteresisRatio)) break;
    level += 1;
  }
  return level;
}

function applyObjectBudget<TId extends SpatialItemId>(
  selections: WorkingSelection<TId>[],
  maximum: number,
): void {
  const ranked = selections.filter(isSelected).sort(compareKeepPriority);
  for (let index = maximum; index < ranked.length; index += 1) {
    ranked[index]!.selectedLevel = null;
    ranked[index]!.reason = "object-budget";
  }
}

function applyTriangleBudget<TId extends SpatialItemId>(
  selections: WorkingSelection<TId>[],
  maximum: number,
): void {
  const ranked = selections.filter(isSelected).sort(compareDegradePriority);
  let triangles = ranked.reduce((total, selection) => total + selectedTriangles(selection), 0);
  for (const selection of ranked) {
    while (triangles > maximum && selection.selectedLevel! < selection.object.levels.length - 1) {
      const previousTriangles = selectedTriangles(selection);
      selection.selectedLevel! += 1;
      triangles -= previousTriangles - selectedTriangles(selection);
      selection.reason = "triangle-budget";
    }
    if (triangles <= maximum) return;
  }
  for (const selection of ranked) {
    if (triangles <= maximum) return;
    if (selection.selectedLevel === null) continue;
    triangles -= selectedTriangles(selection);
    selection.selectedLevel = null;
    selection.reason = "triangle-budget";
  }
}

function freezeSelection<TId extends SpatialItemId>(
  selection: WorkingSelection<TId>,
): ScreenSpaceLodSelection<TId> {
  const level = selection.selectedLevel;
  return Object.freeze({
    id: selection.object.id,
    projectedDiameterPixels: selection.metrics.diameterPixels,
    baseLevel: selection.baseLevel,
    preferredLevel: selection.preferredLevel,
    selectedLevel: level,
    projectedErrorPixels: level === null ? 0 : selection.object.levels[level]!.geometricError * selection.metrics.pixelsPerWorldUnit,
    triangles: level === null ? 0 : selection.object.levels[level]!.triangles,
    reason: selection.reason,
  });
}

function selectedTriangles<TId extends SpatialItemId>(selection: WorkingSelection<TId>): number {
  return selection.selectedLevel === null ? 0 : selection.object.levels[selection.selectedLevel]!.triangles;
}

function isSelected<TId extends SpatialItemId>(selection: WorkingSelection<TId>): boolean {
  return selection.selectedLevel !== null;
}

function compareKeepPriority<TId extends SpatialItemId>(left: WorkingSelection<TId>, right: WorkingSelection<TId>): number {
  return right.object.priority - left.object.priority
    || right.metrics.diameterPixels - left.metrics.diameterPixels
    || compareIds(left.object.id, right.object.id);
}

function compareDegradePriority<TId extends SpatialItemId>(left: WorkingSelection<TId>, right: WorkingSelection<TId>): number {
  return left.object.priority - right.object.priority
    || left.metrics.diameterPixels - right.metrics.diameterPixels
    || compareIds(right.object.id, left.object.id);
}

function compareIds(left: SpatialItemId, right: SpatialItemId): number {
  if (typeof left === "number" && typeof right === "number") return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === "number") return -1;
  if (typeof right === "number") return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}
