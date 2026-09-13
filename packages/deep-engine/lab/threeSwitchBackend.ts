import * as THREE from "three";

export interface ThreeFrameProof {
  readonly width: number;
  readonly height: number;
  readonly centerRgba: readonly number[];
}

/** Three 只存在于迁移验证 Lab；正式 Deep runtime 不依赖它。 */
export class ThreeSwitchBackend {
  readonly id = "three";
  private readonly renderer: THREE.WebGLRenderer;
  private disposed = false;

  private constructor(readonly canvas: HTMLCanvasElement, private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false,
      powerPreference: "high-performance", preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
  }

  static async create(canvas: HTMLCanvasElement, scene: THREE.Scene, camera: THREE.PerspectiveCamera,
    signal: AbortSignal): Promise<ThreeSwitchBackend> {
    if (signal.aborted) throw abortError();
    const backend = new ThreeSwitchBackend(canvas, scene, camera);
    try {
      await backend.validateFrame(signal);
      return backend;
    } catch (error) {
      backend.dispose();
      throw error;
    }
  }

  render(): void {
    this.assertOpen();
    const width = Math.max(1, this.canvas.clientWidth || this.canvas.width);
    const height = Math.max(1, this.canvas.clientHeight || this.canvas.height);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    this.renderer.render(this.scene, this.camera);
  }

  async validateFrame(signal?: AbortSignal): Promise<ThreeFrameProof> {
    if (signal?.aborted) throw abortError();
    this.render();
    const gl = this.renderer.getContext();
    gl.finish();
    if (signal?.aborted) throw abortError();
    const pixel = new Uint8Array(4);
    gl.readPixels(Math.floor(gl.drawingBufferWidth / 2), Math.floor(gl.drawingBufferHeight / 2),
      1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    if (pixel[3] === 0 || (pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0)) {
      throw new Error("Three candidate did not produce a readable first frame.");
    }
    return { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight,
      centerRgba: Object.freeze(Array.from(pixel)) };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Three switch backend is disposed.");
  }
}

function abortError(): Error {
  const error = new Error("Three backend preparation cancelled.");
  error.name = "AbortError";
  return error;
}
