import * as THREE from "three";
import { ViewerEngine } from "./ViewerEngine";
import { StudioDeepWebGpuBridge } from "./StudioDeepWebGpuBridge";
import * as module from "@bim-studio/deep-engine/three-bridge";
import type { PbrRenderer } from "@bim-studio/deep-engine/webgpu";

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
type ProbeWindow = Window & { __j3LossReady?: boolean; __j3ContinueLoss?: () => void; __j3ReleaseViewer?: () => void };

/** Synthetic host notification; both runtimes use actual, separately requested GPU devices. */
export async function runJ3DeviceEpochReplacementProbe() {
  const container = document.querySelector<HTMLElement>("#viewport")!;
  const viewer = await ViewerEngine.create(container, "webgl");
  viewer.setSceneEnvironment({ ...viewer.getSceneEnvironment(), gridVisible: false }); viewer.scene.fog = null;
  const root = viewer.getDeepProjectionRoot() as THREE.Object3D;
  const geometry = new THREE.BoxGeometry(3, 3, 3), material = new THREE.MeshStandardMaterial({ color: 0x689baa, roughness: 0.4, metalness: 0.25 });
  const box = new THREE.Mesh(geometry, material); box.position.y = 1.5; root.add(box); viewer.scene.updateMatrixWorld(true);
  const failures: string[] = [], gpuErrors: string[] = [], notifications: Array<() => void> = [], backends: module.DeepWebGpuBackend[] = [];
  let fatalCalls = 0;
  class ObservedBackend extends module.DeepWebGpuBackend {
    static override async create(...args: Parameters<typeof module.DeepWebGpuBackend.create>) {
      const backend = await module.DeepWebGpuBackend.create(...args), runtime = backend.runtime as PbrRenderer;
      backends.push(backend);
      const subscribe = backend.onDeviceRecreated.bind(backend);
      backend.onDeviceRecreated = listener => { notifications.push(() => listener(1)); return subscribe(listener); };
      runtime.session.onFatalLoss(() => { fatalCalls++; });
      runtime.session.device.addEventListener("uncapturederror", event => {
        event.preventDefault(); gpuErrors.push((event as GPUUncapturedErrorEvent).error.message);
      });
      return backend;
    }
  }
  const bridge = new StudioDeepWebGpuBridge(viewer, container, {
    loadModule: async () => ({ ...module, DeepWebGpuBackend: ObservedBackend }), onRuntimeFailure: error => failures.push(error.message),
  });
  const active = () => bridge.activeBackend;
  const camera = () => [...viewer.camera.position.toArray(), ...viewer.orbit.target.toArray(), viewer.camera.fov, viewer.camera.near, viewer.camera.far];
  const authorPixels = () => {
    viewer.renderer.render(viewer.scene, viewer.camera);
    const canvas = viewer.renderer.domElement, gl = (viewer.renderer as THREE.WebGLRenderer).getContext();
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (gl.getError() !== gl.NO_ERROR) throw new Error("author WebGL readback failed");
    let sum = 0, fingerprint = 2166136261;
    for (const value of pixels) { sum += value; fingerprint = Math.imul(fingerprint ^ value, 16777619) >>> 0; }
    return { width: canvas.width, height: canvas.height, sum, fingerprint };
  };
  try {
    await nextFrame(); await nextFrame();
    const beforeCamera = camera(), beforeAuthor = authorPixels(), authorId = box.uuid;
    const result = await bridge.switchTo("webgpu");
    if (result.status !== "switched") throw new Error(JSON.stringify(result));
    const previous = backends[0]!, runtime = previous.runtime as PbrRenderer, oldDevice = runtime.session.device;
    const actualOldLost = oldDevice.lost;
    document.querySelector("#status")!.textContent = "旧真实GPU已发布 · 等待明确模拟的重开通知";
    (window as ProbeWindow).__j3LossReady = true;
    await new Promise<void>(resolve => { (window as ProbeWindow).__j3ContinueLoss = resolve; });
    if (notifications.length !== 1) throw new Error("actual product recovered listener was not observed");
    notifications[0]!();
    const immediateFallback = active() === "webgl" && viewer.renderer.domElement.style.opacity === "1";
    for (let frame = 0; active() !== "webgpu" && frame < 720; frame++) await nextFrame();
    const replacement = backends[1], next = replacement?.runtime as PbrRenderer | undefined;
    if (!next || active() !== "webgpu") throw new Error("complete GPU replacement did not publish");
    await next.session.device.queue.onSubmittedWorkDone();
    const retiredLoss = await actualOldLost;
    notifications[0]!(); await nextFrame();
    const evidence = { stimulus: "synthetic-recreated-notification", actualUnknownDriverFault: false,
      strategy: "complete-product-candidate-replacement", immediateFallback,
      differentDevice: next.session.device !== oldDevice, createdCandidates: backends.length,
      oldSession: runtime.session.state, oldResources: runtime.session.resourceCount,
      newSession: next.session.state, newResources: next.session.resourceCount,
      retiredLossReason: retiredLoss.reason, fatalCalls, failures, beforeCamera, afterCamera: camera(),
      beforeAuthor, afterAuthor: authorPixels(), authorIdentityPreserved: root.getObjectByProperty("uuid", authorId) === box,
      deepCanvases: container.querySelectorAll('[data-renderer-backend="deep-webgpu"]').length, gpuErrors };
    document.querySelector("#status")!.textContent = "完整候选已发布 · 新真实设备 · 作者状态保留（回调模拟）";
    return evidence;
  } finally {
    (window as ProbeWindow).__j3ReleaseViewer = () => { bridge.dispose(); viewer.dispose(); geometry.dispose(); material.dispose(); };
  }
}
