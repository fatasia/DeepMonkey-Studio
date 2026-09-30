import * as THREE from "three";
import { ViewerEngine } from "./ViewerEngine";
import { StudioDeepWebGpuBridge } from "./StudioDeepWebGpuBridge";
import * as module from "@bim-studio/deep-engine/three-bridge";
import type { PbrRenderer } from "@bim-studio/deep-engine/webgpu";

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
type ProbeWindow = Window & { __j3FailureReady?: boolean; __j3ContinueFailure?: () => void; __j3ReleaseViewer?: () => void };

/** Explicit recreated notification, then actual destruction of a real replacement candidate. */
export async function runJ3DeviceEpochFailureProbe() {
  const container = document.querySelector<HTMLElement>("#viewport")!;
  const viewer = await ViewerEngine.create(container, "webgl");
  viewer.setSceneEnvironment({ ...viewer.getSceneEnvironment(), gridVisible: false }); viewer.scene.fog = null;
  const root = viewer.getDeepProjectionRoot() as THREE.Object3D;
  const geometry = new THREE.BoxGeometry(3, 3, 3), material = new THREE.MeshStandardMaterial({ color: 0x689baa, roughness: 0.4, metalness: 0.25 });
  const box = new THREE.Mesh(geometry, material); box.position.y = 1.5; root.add(box); viewer.scene.updateMatrixWorld(true);
  const failures: string[] = [], gpuErrors: string[] = [], notifications: Array<() => void> = [], backends: module.DeepWebGpuBackend[] = [];
  const projection = new module.ThreeProjectionBridge({ hooks: {
    objectBeforeRender: THREE.Object3D.prototype.onBeforeRender, objectAfterRender: THREE.Object3D.prototype.onAfterRender,
    objectBeforeShadow: THREE.Object3D.prototype.onBeforeShadow, objectAfterShadow: THREE.Object3D.prototype.onAfterShadow,
    materialBeforeRender: THREE.Material.prototype.onBeforeRender, materialBeforeCompile: THREE.Material.prototype.onBeforeCompile,
    materialProgramCacheKey: THREE.Material.prototype.customProgramCacheKey,
  } });
  const lost: Array<Promise<GPUDeviceLostInfo>> = [], fatalCalls = [0, 0];
  let candidateReadyBeforeDestroy = false, candidateResourcesBeforeDestroy = 0;
  class ObservedBackend extends module.DeepWebGpuBackend {
    static override async create(...args: Parameters<typeof module.DeepWebGpuBackend.create>) {
      const backend = await module.DeepWebGpuBackend.create(...args), runtime = backend.runtime as PbrRenderer;
      const index = backends.length; backends.push(backend); lost.push(runtime.session.device.lost);
      const subscribe = backend.onDeviceRecreated.bind(backend);
      backend.onDeviceRecreated = listener => { notifications.push(() => listener(1)); return subscribe(listener); };
      runtime.session.onFatalLoss(() => { fatalCalls[index] = (fatalCalls[index] ?? 0) + 1; });
      runtime.session.device.addEventListener("uncapturederror", event => {
        event.preventDefault(); gpuErrors.push((event as GPUUncapturedErrorEvent).error.message);
      });
      if (index === 1) {
        candidateReadyBeforeDestroy = runtime.session.state === "ready";
        candidateResourcesBeforeDestroy = runtime.session.resourceCount;
        runtime.session.device.destroy();
      }
      return backend;
    }
  }
  const bridge = new StudioDeepWebGpuBridge(viewer, container, {
    loadModule: async () => ({ ...module, DeepWebGpuBackend: ObservedBackend }), onRuntimeFailure: error => failures.push(error.message),
    authorRenderPacket: async signal => {
      signal.throwIfAborted(); box.updateWorldMatrix(true, false);
      const packet = projection.project(box as unknown as module.ThreeObjectSource, { cameraLayerMask: viewer.camera.layers.mask });
      if (!packet.ok) throw new Error(JSON.stringify(packet.issues));
      return packet.packet;
    },
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
    const old = backends[0]!.runtime as PbrRenderer, oldDevice = old.session.device;
    document.querySelector("#status")!.textContent = "旧真实GPU已发布 · 等待明确模拟的重开通知";
    (window as ProbeWindow).__j3FailureReady = true;
    await new Promise<void>(resolve => { (window as ProbeWindow).__j3ContinueFailure = resolve; });
    notifications[0]!();
    const immediateFallback = active() === "webgl" && viewer.renderer.domElement.style.opacity === "1";
    for (let frame = 0; failures.length === 0 && frame < 720; frame++) await nextFrame();
    const failed = backends[1]?.runtime as PbrRenderer | undefined;
    if (!failed || failures.length === 0) throw new Error("destroyed replacement candidate was not rejected");
    const [oldLoss, candidateLoss] = await Promise.all([lost[0]!, lost[1]!]);
    notifications[0]!(); await nextFrame(); await nextFrame();
    const evidence = { stimulus: ["synthetic-recreated-notification", "actual-candidate-device-destroy"], actualUnknownDriverFault: false,
      strategy: "candidate-failure-keeps-author-webgl", immediateFallback, activeBackend: active(), authorOpacity: viewer.renderer.domElement.style.opacity,
      differentDevice: failed.session.device !== oldDevice, createdCandidates: backends.length,
      independentPacketCandidate: backends[1]!.usesIndependentPacket,
      candidateReadyBeforeDestroy, candidateResourcesBeforeDestroy, oldSession: old.session.state, oldResources: old.session.resourceCount,
      failedCandidateSession: failed.session.state, failedCandidateResources: failed.session.resourceCount,
      oldLossReason: oldLoss.reason, candidateLossReason: candidateLoss.reason, fatalCalls, failures,
      beforeCamera, afterCamera: camera(), beforeAuthor, afterAuthor: authorPixels(),
      authorIdentityPreserved: root.getObjectByProperty("uuid", authorId) === box,
      deepCanvases: container.querySelectorAll('[data-renderer-backend="deep-webgpu"]').length, gpuErrors };
    document.querySelector("#status")!.textContent = "真实候选device被销毁 · 首帧验证拒绝 · 作者WebGL保留";
    return evidence;
  } finally {
    (window as ProbeWindow).__j3ReleaseViewer = () => { bridge.dispose(); viewer.dispose(); geometry.dispose(); material.dispose(); };
  }
}
