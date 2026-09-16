import { PbrRenderer } from "@bim-studio/deep-engine/webgpu";
import { verifySceneChunkResidency } from "./sceneChunkResidencyProbe.js";

const output = document.querySelector<HTMLPreElement>("#result")!;
const canvas = document.querySelector<HTMLCanvasElement>("#scene")!;
const controller = new AbortController();
const cancel = () => controller.abort();
window.addEventListener("pagehide", cancel, { once: true });
let renderer: PbrRenderer | undefined;
try {
  renderer = await PbrRenderer.create(canvas, navigator.gpu, controller.signal);
  const result = await verifySceneChunkResidency(renderer, canvas);
  const adapter = renderer.session.adapterInfo;
  renderer.dispose();
  const remainingResources = renderer.session.resourceCount;
  const passed = result.success && remainingResources === 0;
  output.textContent = JSON.stringify({ passed, adapter, remainingResources, result }, null, 2);
  document.title = passed ? "Scene Chunk Frame PASS" : "Scene Chunk Frame FAIL";
} catch (error) {
  output.textContent = JSON.stringify({ passed: false, error: String(error) }, null, 2);
  document.title = "Scene Chunk Frame ERROR";
} finally {
  renderer?.dispose();
  window.removeEventListener("pagehide", cancel);
}
