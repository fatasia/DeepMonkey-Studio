import type { ModelManifest } from "@bim-studio/contracts";
import { ViewerEngine } from "../viewer/ViewerEngine";

/** Heavy Viewer-based format normalization stays behind an explicit optimizer-only lazy boundary. */
export async function convertManifestToOptimizerGlb(manifest: ModelManifest, signal?: AbortSignal): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-2px;top:-2px;width:1px;height:1px;overflow:hidden;pointer-events:none";
  document.body.append(host);
  let engine: ViewerEngine | undefined;
  try {
    engine = await ViewerEngine.create(host, "webgl");
    signal?.throwIfAborted();
    await engine.loadManifest(manifest);
    signal?.throwIfAborted();
    return await engine.exportSceneGlb({ scope: "all" });
  } finally {
    engine?.dispose();
    host.remove();
  }
}
