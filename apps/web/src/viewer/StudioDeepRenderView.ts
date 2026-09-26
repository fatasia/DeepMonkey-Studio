import * as THREE from "three";
import type { RenderPacket } from "@bim-studio/deep-engine";
import type { RenderView } from "@bim-studio/deep-engine/webgpu";
import type { ViewerEngine } from "./ViewerEngine";
import type { StudioDeepEnvironmentSession } from "./StudioDeepEnvironmentSession";
import type { StudioDeepShadowSession } from "./StudioDeepShadowSession";
import { StudioDeepEditorOverlaySession } from "./StudioDeepEditorOverlaySession";
import type { DeepOverlayPrimitiveSource } from "./deepOverlayPrimitiveSource";
import { StudioDeepGridSession } from "./StudioDeepGridSession";
import { projectStudioDeepLights } from "./studioDeepEnvironmentLights";
import { readStudioDeepEnvironmentView } from "./studioDeepEnvironmentView";
import { readStudioDeepFog } from "./studioDeepFog";
import { readStudioDeepColorEffects, readStudioDeepPostProcess } from "./studioDeepColorEffects";
type BridgeModule = typeof import("@bim-studio/deep-engine/three-bridge");

type EnvironmentView = ReturnType<typeof readStudioDeepEnvironmentView>;

/** renderViewSource 的显式返回类型;相机手势缓存依赖它,不能用 ReturnType 自指。 */
interface SourceView extends EnvironmentView {
  camera: THREE.PerspectiveCamera;
  authorGrid: ReturnType<StudioDeepGridSession["read"]>;
  target: readonly [number, number, number];
  width: number;
  height: number;
  pixelRatio: number;
  extent: number;
  fog: NonNullable<RenderView["fog"]> | null;
  authorColorEffects: NonNullable<RenderView["authorColorEffects"]>;
  postProcess: NonNullable<RenderView["postProcess"]>;
  exposure: number;
  roughness: number;
  lights: NonNullable<RenderView["lights"]>;
}

/** Captures one author camera/environment/helper view; temporal frames retain this immutable input. */
export class StudioDeepRenderView {
  private readonly editorOverlay = new StudioDeepEditorOverlaySession();
  private readonly grid = new StudioDeepGridSession();
  private deepOverlayPrimitives: DeepOverlayPrimitiveSource | undefined;
  private projectionExtent: number | undefined;
  private cachedGestureSource: { source: SourceView; at: number; sceneRevision: number } | undefined;
  /** 场景修订号(由桥从 renderDemand 诊断同步);-1 表示不可用,退回 TTL 兜底。 */
  private sceneRevision = -1;

  /** 桥在每帧 syncPath 同步场景修订号;编辑递增 → 手势缓存下次立即失效。 */
  setSceneRevision(revision: number | undefined): void {
    this.sceneRevision = revision ?? -1;
  }
  constructor(private readonly viewer: ViewerEngine, private readonly container: HTMLElement,
    private readonly environmentSession: () => StudioDeepEnvironmentSession | undefined,
    private readonly shadowSession: () => StudioDeepShadowSession | undefined) {}
  reset(): void { this.editorOverlay.dispose(); this.grid.dispose(); this.projectionExtent = undefined; this.cachedGestureSource = undefined; }
  invalidateProjectionBounds(): void { this.projectionExtent = undefined; this.cachedGestureSource = undefined; }
  /**
   * Supplies bounds for the immutable packet path.  This keeps Deep WebGPU
   * view construction from traversing the author Three hierarchy merely to
   * derive an orbit extent.
   */
  setIndependentPacketBounds(packet: RenderPacket): void {
    this.projectionExtent = packetExtent(packet);
    this.cachedGestureSource = undefined;
  }
  /** Deep 原生编辑辅助图形(切片 A/B/C)顶点来源;未注册时保持纯 Three 投影行为。 */
  setDeepOverlayPrimitiveSource(source: DeepOverlayPrimitiveSource | undefined): void {
    this.deepOverlayPrimitives = source;
  }
  renderView(module: BridgeModule, canvas: HTMLCanvasElement): RenderView {
    const source = this.renderViewSource(canvas);
    return { ...module.threeRenderView(source), lights: source.lights, authorGrid: source.authorGrid,
      authorColorEffects: source.authorColorEffects,
      postProcess: source.postProcess,
      fog: source.fog,
      environmentIntensity: source.environmentIntensity,
      ...(source.panoramaBackground ? { panoramaBackground: source.panoramaBackground } : {}) };
  }

  renderViewDirect(canvas: HTMLCanvasElement, cameraGesture = false): RenderView {
    const source = this.renderViewSource(canvas, cameraGesture);
    const matrix = source.camera.matrixWorld.elements;
    const verticalFovRadians = 2 * Math.atan(Math.tan(source.camera.fov * Math.PI / 360) / source.camera.zoom);
    return {
      editorOverlay: this.editorOverlay.read(this.viewer.getDeepEditorOverlayRoots(), this.viewer.camera,
        source.width, source.height, source.pixelRatio,
        this.deepOverlayPrimitives?.(source.width, source.height, source.pixelRatio) ?? []),
      authorGrid: source.authorGrid,
      width: source.width,
      height: source.height,
      pixelRatio: source.pixelRatio,
      extent: source.extent,
      eye: [matrix[12]!, matrix[13]!, matrix[14]!],
      target: source.target,
      up: [matrix[4]!, matrix[5]!, matrix[6]!],
      background: source.background,
      floor: source.floor,
      exposure: source.exposure,
      authorColorEffects: source.authorColorEffects,
      postProcess: source.postProcess,
      roughness: source.roughness,
      lights: source.lights,
      fog: source.fog,
      environmentIntensity: source.environmentIntensity,
      ...(source.panoramaBackground ? { panoramaBackground: source.panoramaBackground } : {}),
      verticalFovRadians,
      near: source.camera.near,
      far: source.camera.far,
    };
  }

  private renderViewSource(canvas: HTMLCanvasElement, cameraGesture = false): SourceView {
    // 相机手势帧(连续指针拖拽)复用场景派生字段(灯光/雾/环境/后处理),只重建
    // 相机派生部分——拖拽中这些字段不随相机变化。失效信号是场景修订号(任何编辑
    // 都经 renderDemand.invalidate 递增,由桥在 syncPath 传入),而不是时间窗:
    // 200ms TTL 在长拖拽中每 12 帧左右触发一次全场景重读(灯光 traverseVisible 等),
    // 正是输入帧 P95 尾部的来源。修订号不可用时退回 TTL 兜底。
    const gestureCacheValid = cameraGesture && this.cachedGestureSource !== undefined
      && this.cachedGestureSource.sceneRevision === this.sceneRevision
      && (this.sceneRevision >= 0 || performance.now() - this.cachedGestureSource.at < 200);
    if (gestureCacheValid) return this.cachedGestureSource!.source;
    const post = this.viewer.getPostProcessing(), composerActive = this.viewer.usesAuthorPostProcessing();
    const fog = readStudioDeepFog(this.viewer.scene, composerActive);
    const lighting = projectStudioDeepLights(this.viewer.scene, this.viewer.camera.layers.mask,
      this.viewer.renderer.shadowMap?.enabled ?? true, this.viewer.renderer.shadowMap?.type ?? THREE.PCFShadowMap);
    if (lighting.issues.length) throw new Error(lighting.issues.map(issue => `${issue.path}: ${issue.message}`).join("\n"));
    const extent = this.projectionExtent ?? (() => {
      const bounds = new THREE.Box3().setFromObject(this.viewer.getDeepProjectionRoot() as THREE.Object3D);
      const size = bounds.isEmpty() ? new THREE.Vector3(2, 2, 2) : bounds.getSize(new THREE.Vector3());
      return this.projectionExtent = Math.max(size.x, size.y, size.z, 1);
    })();
    const environment = this.environmentSession()?.view()
      ?? readStudioDeepEnvironmentView(this.viewer.scene, composerActive);
    const source = {
      camera: this.viewer.camera,
      authorGrid: this.grid.read(this.viewer.getDeepGrid?.(), this.viewer.camera, composerActive, fog),
      target: tuple(this.viewer.orbit.target),
      width: Math.max(this.container.clientWidth, canvas.clientWidth, 1),
      height: Math.max(this.container.clientHeight, canvas.clientHeight, 1),
      pixelRatio: this.viewer.renderer.getPixelRatio(),
      extent,
      ...environment,
      fog,
      authorColorEffects: readStudioDeepColorEffects(post, composerActive),
      postProcess: readStudioDeepPostProcess(post, composerActive),
      exposure: this.viewer.renderer.toneMappingExposure,
      roughness: 1,
      lights: this.shadowSession()?.lights(lighting.lights) ?? lighting.lights,
    };
    if (cameraGesture || this.cachedGestureSource !== undefined) {
      this.cachedGestureSource = { source, at: performance.now(), sceneRevision: this.sceneRevision };
    }
    return source;
  }

}
function tuple(value: THREE.Vector3): [number, number, number] { return [value.x, value.y, value.z]; }

function packetExtent(packet: RenderPacket): number {
  const bounds = new Map<string, [number, number, number, number, number, number]>();
  for (const geometry of packet.geometries) {
    const b: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let offset = 0; offset < geometry.vertices.length; offset += 6) {
      b[0] = Math.min(b[0], geometry.vertices[offset]!); b[1] = Math.min(b[1], geometry.vertices[offset + 1]!); b[2] = Math.min(b[2], geometry.vertices[offset + 2]!);
      b[3] = Math.max(b[3], geometry.vertices[offset]!); b[4] = Math.max(b[4], geometry.vertices[offset + 1]!); b[5] = Math.max(b[5], geometry.vertices[offset + 2]!);
    }
    bounds.set(geometry.id, b);
  }
  let max = 1;
  for (const instance of packet.instances) {
    const b = bounds.get(instance.geometry); if (!b || !Number.isFinite(b[0])) continue;
    const m = instance.transform;
    for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) {
      const px = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      const py = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      const pz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
      max = Math.max(max, Math.abs(px), Math.abs(py), Math.abs(pz));
    }
  }
  return max;
}
