import { getViewerPerformancePreferences, subscribeViewerPerformancePreferences, type ViewerPerformancePreferences } from "./viewerPerformancePreferences";

interface PerformanceViewer {
  setContinuousRender: (reason: string, active: boolean) => void;
  setRepeatedAssetBatchingEnabled: (enabled: boolean) => void;
  setPickingAccelerationEnabled: (enabled: boolean) => void;
  setOcclusionCullingEnabled: (enabled: boolean) => void;
  setOffscreenRenderingEnabled: (enabled: boolean) => void;
}
const bindings = new WeakMap<object, () => void>();
export function bindViewerPerformancePreferences(viewer: PerformanceViewer): void {
  disposeViewerPerformanceBinding(viewer);
  let previous: ViewerPerformancePreferences | undefined;
  const apply = () => {
    const next = getViewerPerformancePreferences();
    if (previous?.demandRendering !== next.demandRendering) viewer.setContinuousRender("user-continuous", !next.demandRendering);
    if (previous?.repeatedAssets !== next.repeatedAssets) viewer.setRepeatedAssetBatchingEnabled(next.repeatedAssets);
    if (previous?.acceleratedPicking !== next.acceleratedPicking) viewer.setPickingAccelerationEnabled(next.acceleratedPicking);
    if (previous?.occlusionCulling !== next.occlusionCulling) viewer.setOcclusionCullingEnabled(next.occlusionCulling);
    if (previous?.offscreenRendering !== next.offscreenRendering) viewer.setOffscreenRenderingEnabled(next.offscreenRendering);
    previous = next;
  };
  apply(); bindings.set(viewer, subscribeViewerPerformancePreferences(apply));
}
export function disposeViewerPerformanceBinding(viewer: object): void { bindings.get(viewer)?.(); bindings.delete(viewer); }
