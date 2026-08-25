export type AgvMotionMode = "realtime" | "simulation" | "replay";

export interface AgvPose {
  timestampMs: number;
  position: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number; w: number };
  velocityMps?: number;
}

/**
 * Adapter boundary for live telemetry, simulated motion and recorded playback.
 * Source implementations stay outside the flow engine and can be swapped at runtime.
 */
export interface AgvMotionSource {
  readonly mode: AgvMotionMode;
  read(agvId: string, clockMs: number): AgvPose | undefined;
  reset?(): void;
}

export class AgvMotionSourceRouter {
  readonly #sources = new Map<AgvMotionMode, AgvMotionSource>();
  #mode: AgvMotionMode;

  public constructor(sources: readonly AgvMotionSource[], initialMode: AgvMotionMode = "simulation") {
    for (const source of sources) {
      if (this.#sources.has(source.mode)) throw new Error(`duplicate AGV motion source for ${source.mode}`);
      this.#sources.set(source.mode, source);
    }
    if (!this.#sources.has(initialMode)) throw new Error(`AGV motion source ${initialMode} is not registered`);
    this.#mode = initialMode;
  }

  public get mode(): AgvMotionMode {
    return this.#mode;
  }

  public get availableModes(): AgvMotionMode[] {
    return [...this.#sources.keys()].sort();
  }

  public switchMode(mode: AgvMotionMode): void {
    const source = this.#sources.get(mode);
    if (!source) throw new Error(`AGV motion source ${mode} is not registered`);
    source.reset?.();
    this.#mode = mode;
  }

  public read(agvId: string, clockMs: number): AgvPose | undefined {
    return clonePose(this.#sources.get(this.#mode)?.read(agvId, clockMs));
  }

  public resetAll(): void {
    for (const source of this.#sources.values()) source.reset?.();
  }
}

function clonePose(pose: AgvPose | undefined): AgvPose | undefined {
  if (!pose) return undefined;
  return {
    ...pose,
    position: { ...pose.position },
    ...(pose.rotation ? { rotation: { ...pose.rotation } } : {})
  };
}
