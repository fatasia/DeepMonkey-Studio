import * as THREE from "three";
import { ViewerEngine } from "./ViewerEngine";
import { StudioDeepWebGpuBridge } from "./StudioDeepWebGpuBridge";
import * as module from "@bim-studio/deep-engine/three-bridge";
import type { PbrRenderer } from "@bim-studio/deep-engine/webgpu";

type ProbeWindow = Window & { __j3LossReady?: boolean; __j3ContinueLoss?: () => void };
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/** Drives the actual product bridge; observes creation without substituting its runtime. */
export async function runJ3DeviceFallbackProbe() {
  const container = document.querySelector<HTMLElement>("#viewport")!;
  const viewer = await ViewerEngine.create(container, "webgl");
  // This lifecycle fixture uses the existing no-fog profile. Display-domain
  // fog without author postprocessing has a separate production capability gate.
  viewer.setSceneEnvironment({ ...viewer.getSceneEnvironment(), gridVisible: false });
  viewer.scene.fog = null;
  const root = viewer.getDeepProjectionRoot() as THREE.Object3D;
  const geometry = new THREE.BoxGeometry(3, 3, 3);
  const material = new THREE.MeshStandardMaterial({ color: 0x689baa, roughness: 0.4, metalness: 0.25 });
  const box = new THREE.Mesh(geometry, material); box.position.y = 1.5; box.name = "j3-preserved-author";
  root.add(box); viewer.scene.updateMatrixWorld(true);
  const failures: string[] = [], gpuErrors: string[] = [];
  let fatalCalls = 0;
  let observedBackend: module.DeepWebGpuBackend | undefined;
  class ObservedBackend extends module.DeepWebGpuBackend {
    static override async create(...args: Parameters<typeof module.DeepWebGpuBackend.create>) {
      const backend = await module.DeepWebGpuBackend.create(...args);
      observedBackend = backend;
      const runtime = backend.runtime as PbrRenderer;
      runtime.session.onFatalLoss(() => { fatalCalls++; });
      runtime.session.device.addEventListener("uncapturederror", event => {
        event.preventDefault(); gpuErrors.push((event as GPUUncapturedErrorEvent).error.message);
      });
      return backend;
    }
  }
  const bridge = new StudioDeepWebGpuBridge(viewer, container, {
    loadModule: async () => ({ ...module, DeepWebGpuBackend: ObservedBackend }),
    onRuntimeFailure: error => failures.push(error.message),
  });
  const authorCanvas = viewer.renderer.domElement;
  const currentBackend = () => bridge.activeBackend;
  const camera = () => [...viewer.camera.position.toArray(), ...viewer.orbit.target.toArray(), viewer.camera.fov, viewer.camera.near, viewer.camera.far];
  const authorPixels = () => {
    viewer.renderer.render(viewer.scene, viewer.camera);
    const gl = (viewer.renderer as THREE.WebGLRenderer).getContext();
    const pixels = new Uint8Array(authorCanvas.width * authorCanvas.height * 4);
    gl.readPixels(0, 0, authorCanvas.width, authorCanvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (gl.getError() !== gl.NO_ERROR) throw new Error("author WebGL readback failed");
    let sum = 0, varyingPixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      sum += pixels[offset]! + pixels[offset + 1]! + pixels[offset + 2]!;
      if (pixels[offset] !== pixels[0] || pixels[offset + 1] !== pixels[1] || pixels[offset + 2] !== pixels[2]) varyingPixels++;
    }
    return { width: authorCanvas.width, height: authorCanvas.height, sum, varyingPixels };
  };
  try {
    await nextFrame(); await nextFrame();
    const beforeCamera = camera(), beforeAuthor = authorPixels(), authorId = box.uuid;
    const switched = await bridge.switchTo("webgpu");
    if (switched.status !== "switched" || bridge.activeBackend !== "webgpu") throw new Error(JSON.stringify(switched));
    const backend = observedBackend!;
    const runtime = backend.runtime as PbrRenderer, session = runtime.session, device = session.device;
    if (session.recovery !== undefined || session.state !== "ready") throw new Error("probe must exercise actual default no-recovery session");
    const resourcesBefore = session.resourceCount;
    document.querySelector("#status")!.textContent = "WebGPU 已发布 · 等待真实设备丢失";
    (window as ProbeWindow).__j3LossReady = true;
    await new Promise<void>(resolve => { (window as ProbeWindow).__j3ContinueLoss = resolve; });
    const actualLost = device.lost;
    device.destroy();
    const lost = await actualLost;
    for (let frame = 0; currentBackend() !== "webgl" && frame < 120; frame++) await nextFrame();
    await nextFrame(); await nextFrame();
    const afterAuthor = authorPixels(), afterCamera = camera();
    const deepCanvasesAfter = container.querySelectorAll('[data-renderer-backend="deep-webgpu"]').length;
    const fallback = currentBackend() === "webgl" && authorCanvas.isConnected && authorCanvas.style.opacity === "1";
    // Repeated destroy/dispose must not trigger a second fallback or resurrect a surface.
    device.destroy(); bridge.dispose();
    await nextFrame(); await nextFrame();
    const afterDisposeBackend = bridge.activeBackend;
    const evidence = { reason: lost.reason, recovery: session.recovery ?? null, fatalCalls, failures,
      strategy: "destroyed-web-product-webgl-fallback", fallback, deepCanvasesAfter,
      resourcesBefore, resourcesAfter: session.resourceCount, sessionAfter: session.state,
      authorIdentityPreserved: root.getObjectByProperty("uuid", authorId) === box,
      beforeCamera, afterCamera, beforeAuthor, afterAuthor, afterDisposeBackend, gpuErrors };
    document.querySelector("#status")!.textContent = "WebGL 已恢复 · 作者场景和相机保留 · 回退一次";
    return evidence;
  } finally {
    bridge.dispose();
    // Keep the actual author surface alive for the runner's final screenshot.
    (window as Window & { __j3ReleaseViewer?: () => void }).__j3ReleaseViewer = () => {
      viewer.dispose(); geometry.dispose(); material.dispose();
    };
  }
}
