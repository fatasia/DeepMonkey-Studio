import * as THREE from "three";
import type { OffscreenFrame, OffscreenRequest, OffscreenResponse, OffscreenSnapshot } from "./offscreenRenderProtocol";
import { closeOffscreenImages, parseOffscreenSnapshot } from "./offscreenSceneSnapshot";
import { applyOffscreenFrame } from "./offscreenSceneFrames";
import { createOffscreenPostProcessing } from "./offscreenPostProcessing";
import type { PostProcessingRuntime } from "./postProcessingRuntime";

let renderer: THREE.WebGLRenderer | undefined; let scene: THREE.Scene | undefined; let snapshot: OffscreenSnapshot | undefined;
let canvas: OffscreenCanvas | undefined;
const camera = new THREE.PerspectiveCamera(); let post: PostProcessingRuntime | undefined; let closed = false;
let width = 0; let height = 0; let pixelRatio = 0;
const respond = (response: OffscreenResponse, transfer?: Transferable[]) => self.postMessage(response, transfer ?? []);
function dispose() {
  closed = true; post?.dispose(); post = undefined; canvas = undefined;
  const geometry = new Set<THREE.BufferGeometry>(); const materials = new Set<THREE.Material>(); const textures = new Set<THREE.Texture>();
  scene?.traverse(object => { const mesh = object as THREE.Mesh; if (mesh.geometry) geometry.add(mesh.geometry);
    for (const material of mesh.material ? Array.isArray(mesh.material) ? mesh.material : [mesh.material] : []) {
      materials.add(material); for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  if (scene?.environment) textures.add(scene.environment); if (scene?.background instanceof THREE.Texture) textures.add(scene.background);
  geometry.forEach(value => value.dispose()); materials.forEach(value => value.dispose()); textures.forEach(value => value.dispose());
  renderer?.dispose(); renderer?.forceContextLoss(); renderer = undefined; scene = undefined;
  if (snapshot) closeOffscreenImages(snapshot.images); snapshot = undefined;
}
async function draw(frame: OffscreenFrame) {
  if (!renderer || !scene || !canvas || closed) return;
  const start = performance.now(); applyOffscreenFrame(scene, camera, frame);
  if (width !== frame.width || height !== frame.height || pixelRatio !== frame.pixelRatio) {
    width = frame.width; height = frame.height; pixelRatio = frame.pixelRatio;
    renderer.setPixelRatio(pixelRatio); renderer.setSize(width, height, false); post?.setPixelRatio(pixelRatio); post?.setSize(width, height);
  }
  renderer.outputColorSpace = frame.renderer.outputColorSpace; renderer.toneMapping = frame.renderer.toneMapping as THREE.ToneMapping;
  renderer.toneMappingExposure = frame.renderer.exposure; renderer.setClearColor(frame.renderer.clearColor, frame.renderer.clearAlpha);
  renderer.shadowMap.enabled = frame.renderer.shadowEnabled; renderer.shadowMap.type = frame.renderer.shadowType as THREE.ShadowMapType;
  if (frame.postProcessing.enabled || frame.outlined.length) {
    if (!post) { post = await createOffscreenPostProcessing(renderer, scene, camera); post.setPixelRatio(pixelRatio); post.setSize(width, height); }
    if (closed) { post.dispose(); post = undefined; return; }
    const selected = frame.outlined.map(id => scene!.getObjectByProperty("uuid", id)).filter((object): object is THREE.Object3D => Boolean(object));
    post.apply(frame.postProcessing, selected); renderer.info.reset(); post.render(frame.delta);
  } else { post?.suspend(); renderer.info.reset(); renderer.render(scene, camera); }
  renderer.getContext().flush();
  // 提交绘图缓冲并转移给主线程；WebGL 上下文的绘图缓冲在转移后被清空，下一帧整体重绘即可。
  const bitmap = canvas.transferToImageBitmap();
  respond({ type: "frame", sequence: frame.sequence, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, renderMs: performance.now() - start, bitmap }, [bitmap]);
}
self.onmessage = (event: MessageEvent<OffscreenRequest>) => {
  const message = event.data;
  if (message.type === "dispose") { dispose(); return; }
  void (async () => {
    try {
      if (message.type === "init") {
        snapshot = message.snapshot; scene = parseOffscreenSnapshot(snapshot); canvas = message.canvas;
        message.canvas.addEventListener("webglcontextlost", () => { if (!closed) respond({ type: "error", reason: "后台 GPU 上下文已丢失" }); });
        renderer = new THREE.WebGLRenderer({ canvas: message.canvas, antialias: true, alpha: true, powerPreference: "high-performance" }); renderer.info.autoReset = false;
        respond({ type: "ready" });
      }
      await draw(message.frame);
    } catch (error) {
      // 结构漂移(主线程新增/删除对象)可静默重启；其余失败对主线程回退并附上原始原因便于诊断。
      const stale = error instanceof Error && /stale/i.test(error.message);
      const stack = error instanceof Error ? (error.stack ?? "").split("\n").slice(0, 4).join(" | ") : "";
      respond({ type: "error", reason: stale ? "scene-stale" : `后台渲染失败: ${error instanceof Error ? error.message : String(error)} @${stack}` });
      dispose();
    }
  })();
};
