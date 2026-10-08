import type * as THREE from "three";
import { isStudioDeepEnvironmentSourceCurrent, prepareStudioDeepEnvironmentSource,
  type PreparedStudioDeepEnvironment } from "./studioDeepEnvironmentSource";

/** One CPU environment snapshot per bridge; no GPU owners survive retirement. */
export class StudioDeepEnvironmentCache {
  private prepared: PreparedStudioDeepEnvironment | undefined;
  private removeListeners: (() => void) | undefined;
  private generation = 0;

  async prepare(scene: THREE.Scene, signal: AbortSignal): Promise<PreparedStudioDeepEnvironment> {
    signal.throwIfAborted();
    if (this.prepared && isStudioDeepEnvironmentSourceCurrent(scene, this.prepared)) return this.prepared;
    this.clear();
    const generation = this.generation;
    const prepared = await prepareStudioDeepEnvironmentSource(scene, signal);
    signal.throwIfAborted();
    if (generation === this.generation && isStudioDeepEnvironmentSourceCurrent(scene, prepared)) {
      this.prepared = prepared;
      const textures = prepared.textures.map(item => item.identity.texture);
      const disposed = () => this.clear();
      for (const texture of textures) texture.addEventListener("dispose", disposed);
      this.removeListeners = () => {
        for (const texture of textures) texture.removeEventListener("dispose", disposed);
      };
    }
    return prepared;
  }

  clear(): void {
    this.generation++;
    this.removeListeners?.();
    this.removeListeners = undefined;
    this.prepared = undefined;
  }
}
