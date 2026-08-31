import type { SceneSnapshot } from "@bim-studio/contracts";

export type ScenePublicationDiffSection =
  | "scene"
  | "content"
  | "camera"
  | "appearance"
  | "dashboard"
  | "data"
  | "interaction"
  | "simulation"
  | "review"
  | "runtime";

export type ScenePublicationDiffMetric = "objects" | "widgets" | "bindings" | "interactions" | "measurements" | "annotations";

export interface ScenePublicationMetricDiff {
  id: ScenePublicationDiffMetric;
  draft: number;
  published: number;
  delta: number;
}

export interface ScenePublicationDiff {
  changedSections: ScenePublicationDiffSection[];
  metrics: ScenePublicationMetricDiff[];
  hasChanges: boolean;
}

/**
 * Compares the editable draft with an immutable publication while excluding
 * lifecycle timestamps and transient editor selection. The result is kept
 * language-neutral so the publication UI can render it in any locale.
 */
export function summarizeScenePublicationDiff(draft: SceneSnapshot, published: SceneSnapshot): ScenePublicationDiff {
  const sections: Array<[ScenePublicationDiffSection, unknown, unknown]> = [
    ["scene", { name: draft.name, coordinateSystem: draft.coordinateSystem }, { name: published.name, coordinateSystem: published.coordinateSystem }],
    ["content", { models: draft.models, primitives: draft.primitives, floors: draft.floors }, { models: published.models, primitives: published.primitives, floors: published.floors }],
    ["camera", cameraState(draft), cameraState(published)],
    ["appearance", appearanceState(draft), appearanceState(published)],
    ["dashboard", draft.dashboard, published.dashboard],
    ["data", draft.dataBindings, published.dataBindings],
    ["interaction", { interactions: draft.interactions, selectionSets: draft.selectionSets }, { interactions: published.interactions, selectionSets: published.selectionSets }],
    ["simulation", { physics: draft.physics, animation: draft.animation }, { physics: published.physics, animation: published.animation }],
    ["review", { measurements: draft.measurements, annotations: draft.annotations }, { measurements: published.measurements, annotations: published.annotations }],
    ["runtime", publicationRuntimeState(draft), publicationRuntimeState(published)]
  ];
  const changedSections = sections.filter(([, left, right]) => canonicalJson(left) !== canonicalJson(right)).map(([id]) => id);
  const metricValues: Array<[ScenePublicationDiffMetric, number, number]> = [
    ["objects", draft.models.length + draft.primitives.length, published.models.length + published.primitives.length],
    ["widgets", draft.dashboard?.widgets.length ?? 0, published.dashboard?.widgets.length ?? 0],
    ["bindings", draft.dataBindings?.length ?? 0, published.dataBindings?.length ?? 0],
    ["interactions", draft.interactions?.length ?? 0, published.interactions?.length ?? 0],
    ["measurements", draft.measurements.length, published.measurements.length],
    ["annotations", draft.annotations?.length ?? 0, published.annotations?.length ?? 0]
  ];
  const metrics = metricValues.map(([id, draftCount, publishedCount]) => ({
    id,
    draft: draftCount,
    published: publishedCount,
    delta: draftCount - publishedCount
  }));
  return { changedSections, metrics, hasChanges: changedSections.length > 0 };
}

function publicationRuntimeState(scene: SceneSnapshot) {
  return {
    mode: scene.publicationMode ?? "webgl",
    performance: scene.publicationPerformance ?? "standard",
    // 缺省值为 true，保证旧发布的浏览工具不会因升级消失。
    toolbarVisible: scene.publicationToolbarVisible !== false
  };
}

function cameraState(scene: SceneSnapshot) {
  return {
    camera: scene.camera,
    constraints: scene.cameraConstraints,
    navigation: scene.navigationSettings,
    views: scene.cameraViews,
    defaultView: scene.defaultCameraViewId
  };
}

function appearanceState(scene: SceneSnapshot) {
  return {
    clipping: scene.clipping,
    weather: scene.weather,
    lighting: scene.lighting,
    environment: scene.environment,
    postProcessing: scene.postProcessing
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalize(item)]));
}
