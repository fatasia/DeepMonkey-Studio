import * as THREE from "three";
import type { RenderView } from "@bim-studio/deep-engine/webgpu";
import type { ViewerEngine } from "./ViewerEngine";
import type { StudioDeepEnvironmentSession } from "./StudioDeepEnvironmentSession";
import type { StudioDeepShadowSession } from "./StudioDeepShadowSession";
import { StudioDeepEditorOverlaySession } from "./StudioDeepEditorOverlaySession";
import { StudioDeepGridSession } from "./StudioDeepGridSession";
import { projectStudioDeepLights } from "./studioDeepEnvironmentLights";
import { readStudioDeepEnvironmentView } from "./studioDeepEnvironmentView";
import { readStudioDeepFog } from "./studioDeepFog";
import { readStudioDeepColorEffects, readStudioDeepPostProcess } from "./studioDeepColorEffects";
type BridgeModule = typeof import("@bim-studio/deep-engine/three-bridge");

/** Captures one author camera/environment/helper view; temporal frames retain this immutable input. */
export class StudioDeepRenderView {
  private readonly editorOverlay = new StudioDeepEditorOverlaySession();
  private readonly grid = new StudioDeepGridSession();
  constructor(private readonly viewer: ViewerEngine, private readonly container: HTMLElement,
    private readonly environmentSession: () => StudioDeepEnvironmentSession | undefined,
    private readonly shadowSession: () => StudioDeepShadowSession | undefined) {}
  reset(): void { this.editorOverlay.dispose(); this.grid.dispose(); }
  renderView(module: BridgeModule, canvas: HTMLCanvasElement): RenderView {
    const source = this.renderViewSource(canvas);
    return { ...module.threeRenderView(source), lights: source.lights, authorGrid: source.authorGrid,
      authorColorEffects: source.authorColorEffects,
      postProcess: source.postProcess,
      fog: source.fog,
      environmentIntensity: source.environmentIntensity,
      ...(source.panoramaBackground ? { panoramaBackground: source.panoramaBackground } : {}) };
  }

  renderViewDirect(canvas: HTMLCanvasElement): RenderView {
    const source = this.renderViewSource(canvas);
    const matrix = source.camera.matrixWorld.elements;
    const verticalFovRadians = 2 * Math.atan(Math.tan(source.camera.fov * Math.PI / 360) / source.camera.zoom);
    return {
      editorOverlay: this.editorOverlay.read(this.viewer.getDeepEditorOverlayRoots(), this.viewer.camera,
        source.width, source.height, source.pixelRatio),
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

  private renderViewSource(canvas: HTMLCanvasElement) {
    const post = this.viewer.getPostProcessing(), composerActive = this.viewer.usesAuthorPostProcessing();
    const lighting = projectStudioDeepLights(this.viewer.scene, this.viewer.camera.layers.mask,
      this.viewer.renderer.shadowMap?.enabled ?? true, this.viewer.renderer.shadowMap?.type ?? THREE.PCFShadowMap);
    if (lighting.issues.length) throw new Error(lighting.issues.map(issue => `${issue.path}: ${issue.message}`).join("\n"));
    const bounds = new THREE.Box3().setFromObject(this.viewer.getDeepProjectionRoot() as THREE.Object3D);
    const size = bounds.isEmpty() ? new THREE.Vector3(2, 2, 2) : bounds.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z, 1);
    const environment = this.environmentSession()?.view()
      ?? readStudioDeepEnvironmentView(this.viewer.scene, composerActive);
    return {
      camera: this.viewer.camera,
      authorGrid: this.grid.read(this.viewer.getDeepGrid?.(), this.viewer.camera, composerActive, readStudioDeepFog(this.viewer.scene, composerActive)),
      target: tuple(this.viewer.orbit.target),
      width: Math.max(this.container.clientWidth, canvas.clientWidth, 1),
      height: Math.max(this.container.clientHeight, canvas.clientHeight, 1),
      pixelRatio: this.viewer.renderer.getPixelRatio(),
      extent,
      ...environment,
      fog: readStudioDeepFog(this.viewer.scene, composerActive),
      authorColorEffects: readStudioDeepColorEffects(post, composerActive),
      postProcess: readStudioDeepPostProcess(post, composerActive),
      exposure: this.viewer.renderer.toneMappingExposure,
      roughness: 1,
      lights: this.shadowSession()?.lights(lighting.lights) ?? lighting.lights,
    };
  }

}
function tuple(value: THREE.Vector3): [number, number, number] { return [value.x, value.y, value.z]; }
