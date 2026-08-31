import * as THREE from "three";
import type { SceneSpatialAudioState } from "@bim-studio/contracts";
import { modelScreenSourceUrl } from "./modelScreenTexture";
import { ViewerEngineObjects } from "./viewerEngineObjects";

const DEFAULT_SPATIAL_AUDIO: SceneSpatialAudioState = {
  enabled: false,
  url: "",
  autoplay: true,
  loopMode: "loop",
  muted: false,
  volume: 0.7,
  refDistance: 2,
  maxDistance: 50,
  rolloffFactor: 1,
};

/** 模型空间音频运行时；浏览器手势解锁和资源生命周期集中在这里。 */
export abstract class ViewerEngineSpatialAudio extends ViewerEngineObjects {
  getSpatialAudioState(id: string): SceneSpatialAudioState | undefined {
    const state = this.spatialAudioStates.get(id);
    return state ? structuredClone(state) : undefined;
  }

  setSpatialAudioState(id: string, state: SceneSpatialAudioState | undefined): void {
    const model = this.models.get(id);
    if (!model) return;
    if (!state) {
      this.spatialAudioStates.delete(id);
      this.disposeSpatialAudioRuntime(id);
      this.onModelChange?.(model);
      return;
    }
    const normalized = normalizeSpatialAudioState(state);
    this.spatialAudioStates.set(id, normalized);
    const sourceUrl = modelScreenSourceUrl(normalized.url, window.location.href);
    if (!normalized.enabled || !sourceUrl) {
      this.disposeSpatialAudioRuntime(id);
      this.onModelChange?.(model);
      return;
    }
    const runtime = this.ensureSpatialAudioRuntime(id);
    applySpatialAudioSettings(runtime.audio, normalized);
    if (runtime.sourceUrl !== sourceUrl) this.loadSpatialAudioBuffer(id, sourceUrl);
    else if (normalized.autoplay && this.audioUnlocked) this.playSpatialAudio(runtime.audio, false);
    else if (!normalized.autoplay && runtime.audio.isPlaying) runtime.audio.pause();
    this.onModelChange?.(model);
  }

  controlSpatialAudio(id: string, action: "play" | "pause" | "stop" | "replay"): void {
    const state = this.spatialAudioStates.get(id);
    const runtime = this.spatialAudioRuntimes.get(id);
    if (!state || !runtime) return;
    if (action === "pause") {
      if (runtime.audio.isPlaying) runtime.audio.pause();
      this.spatialAudioStates.set(id, { ...state, autoplay: false });
    } else if (action === "stop") {
      if (runtime.audio.isPlaying) runtime.audio.stop();
      this.spatialAudioStates.set(id, { ...state, autoplay: false });
    } else {
      void this.unlockSpatialAudio().then(() => this.playSpatialAudio(runtime.audio, action === "replay"));
      this.spatialAudioStates.set(id, { ...state, enabled: true, autoplay: true });
    }
    this.onModelChange?.(this.models.get(id)!);
  }

  protected async unlockSpatialAudio(): Promise<void> {
    const listener = this.audioListener;
    if (!listener) return;
    if (listener.context.state === "suspended") await listener.context.resume().catch(() => undefined);
    this.audioUnlocked = listener.context.state === "running";
    if (!this.audioUnlocked) return;
    for (const [id, state] of this.spatialAudioStates) {
      if (!state.enabled || !state.autoplay) continue;
      const audio = this.spatialAudioRuntimes.get(id)?.audio;
      if (audio?.buffer && !audio.isPlaying) this.playSpatialAudio(audio, false);
    }
  }

  protected disposeAllSpatialAudio(): void {
    for (const id of [...this.spatialAudioRuntimes.keys()]) this.disposeSpatialAudioRuntime(id);
    this.spatialAudioStates.clear();
    this.spatialAudioBuffers.clear();
    this.audioListener?.removeFromParent();
    this.audioListener = undefined;
    this.audioUnlocked = false;
  }

  protected disposeSpatialAudioRuntime(id: string): void {
    const runtime = this.spatialAudioRuntimes.get(id);
    if (!runtime) return;
    if (runtime.audio.isPlaying) runtime.audio.stop();
    runtime.audio.disconnect();
    runtime.audio.removeFromParent();
    this.spatialAudioRuntimes.delete(id);
  }

  private ensureSpatialAudioRuntime(id: string) {
    const existing = this.spatialAudioRuntimes.get(id);
    if (existing) return existing;
    const listener = this.ensureAudioListener();
    const audio = new THREE.PositionalAudio(listener);
    audio.name = `spatial-audio:${id}`;
    this.models.get(id)!.object.add(audio);
    const runtime: { audio: THREE.PositionalAudio; sourceUrl?: string; requestKey?: string } = { audio };
    this.spatialAudioRuntimes.set(id, runtime);
    return runtime;
  }

  private ensureAudioListener(): THREE.AudioListener {
    if (this.audioListener) return this.audioListener;
    this.audioListener = new THREE.AudioListener();
    this.camera.add(this.audioListener);
    return this.audioListener;
  }

  private loadSpatialAudioBuffer(id: string, sourceUrl: string): void {
    const runtime = this.spatialAudioRuntimes.get(id);
    if (!runtime) return;
    const requestKey = `${id}:${sourceUrl}:${crypto.randomUUID()}`;
    runtime.requestKey = requestKey;
    runtime.sourceUrl = sourceUrl;
    let request = this.spatialAudioBuffers.get(sourceUrl);
    if (!request) {
      request = new THREE.AudioLoader().loadAsync(sourceUrl).catch((error) => {
        this.spatialAudioBuffers.delete(sourceUrl);
        throw error;
      });
      this.spatialAudioBuffers.set(sourceUrl, request);
    }
    void request.then((buffer) => {
      const current = this.spatialAudioRuntimes.get(id);
      const state = this.spatialAudioStates.get(id);
      if (!current || current.requestKey !== requestKey || !state?.enabled) return;
      if (current.audio.isPlaying) current.audio.stop();
      current.audio.setBuffer(buffer);
      applySpatialAudioSettings(current.audio, state);
      if (state.autoplay && this.audioUnlocked) this.playSpatialAudio(current.audio, false);
    }).catch(() => undefined);
  }

  private playSpatialAudio(audio: THREE.PositionalAudio, replay: boolean): void {
    if (!audio.buffer || !this.audioUnlocked) return;
    if (audio.isPlaying) {
      if (!replay) return;
      audio.stop();
    }
    audio.play();
  }
}

export function normalizeSpatialAudioState(state: SceneSpatialAudioState): SceneSpatialAudioState {
  const refDistance = THREE.MathUtils.clamp(state.refDistance, 0.01, 100_000);
  return {
    enabled: Boolean(state.enabled),
    url: state.url.trim().slice(0, 4_096),
    ...(state.name?.trim() ? { name: state.name.trim().slice(0, 240) } : {}),
    autoplay: Boolean(state.autoplay),
    loopMode: state.loopMode === "once" ? "once" : "loop",
    muted: Boolean(state.muted),
    volume: THREE.MathUtils.clamp(state.volume, 0, 1),
    refDistance,
    maxDistance: THREE.MathUtils.clamp(state.maxDistance, refDistance, 1_000_000),
    rolloffFactor: THREE.MathUtils.clamp(state.rolloffFactor, 0, 10),
  };
}

function applySpatialAudioSettings(audio: THREE.PositionalAudio, state: SceneSpatialAudioState): void {
  audio.setLoop(state.loopMode === "loop");
  audio.setVolume(state.muted ? 0 : state.volume);
  audio.setRefDistance(state.refDistance);
  audio.setMaxDistance(state.maxDistance);
  audio.setRolloffFactor(state.rolloffFactor);
  audio.setDistanceModel("inverse");
}
