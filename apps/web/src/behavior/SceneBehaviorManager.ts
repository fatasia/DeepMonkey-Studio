import type { JsonValue } from "@bim-studio/contracts";
import type {
  SceneBehaviorModule,
  SceneBehaviorRuntimeSettings,
  SceneCommand,
  SceneEvent
} from "@bim-studio/scene-sdk";
import {
  createSceneBehaviorWorker,
  SceneBehaviorHost,
  type SceneBehaviorHostDiagnostics,
  type SceneBehaviorHostOptions,
  type SceneBehaviorWorkerPort
} from "./SceneBehaviorHost";

export interface SceneBehaviorManagerEntry {
  module: SceneBehaviorModule;
  diagnostics: SceneBehaviorHostDiagnostics;
}

export interface SceneBehaviorManagerOptions {
  workerFactory?: () => SceneBehaviorWorkerPort;
  hostOptions?: SceneBehaviorHostOptions;
}

/** Owns the isolated Worker hosts for one scene without depending on React or Three.js. */
export class SceneBehaviorManager {
  onCommands?: (moduleId: string, commands: SceneCommand[]) => void;
  onLog?: (moduleId: string, entry: { level: "debug" | "info" | "warn" | "error"; message: string; data?: JsonValue }) => void;
  onChange?: (entries: SceneBehaviorManagerEntry[]) => void;

  private readonly workerFactory: () => SceneBehaviorWorkerPort;
  private readonly hostOptions: SceneBehaviorHostOptions;
  private readonly hosts = new Map<string, { module: SceneBehaviorModule; host: SceneBehaviorHost }>();
  private disposed = false;

  constructor(options: SceneBehaviorManagerOptions = {}) {
    this.workerFactory = options.workerFactory ?? createSceneBehaviorWorker;
    this.hostOptions = options.hostOptions ?? {};
  }

  start(modules: readonly SceneBehaviorModule[], sceneId: string): void {
    if (this.disposed) throw new Error("行为管理器已销毁");
    if (!sceneId.trim()) throw new Error("行为管理器需要 sceneId");
    this.stop();
    const ids = new Set<string>();
    for (const module of modules) {
      if (ids.has(module.id)) {
        this.reportStartFailure(module, `行为脚本 ID 重复：${module.id}`);
        continue;
      }
      ids.add(module.id);
      try {
        const host = new SceneBehaviorHost(this.workerFactory(), this.hostOptions);
        const stored = structuredClone(module);
        host.onCommands = (commands) => this.onCommands?.(stored.id, commands);
        host.onLog = (entry) => this.onLog?.(stored.id, entry);
        host.onDiagnosticsChange = () => this.emit();
        this.hosts.set(stored.id, { module: stored, host });
        host.start(stored, sceneId);
      } catch (reason) {
        this.hosts.delete(module.id);
        this.reportStartFailure(module, reason instanceof Error ? reason.message : String(reason));
      }
    }
    this.emit();
  }

  advance(deltaMs: number): void {
    for (const { host } of this.hosts.values()) host.advance(deltaMs);
  }

  dispatchEvent(event: SceneEvent): void {
    for (const { host } of this.hosts.values()) host.dispatchEvent(event);
  }

  dispatchData(data: JsonValue): void {
    for (const { host } of this.hosts.values()) host.dispatchData(data);
  }

  pause(): void {
    for (const { host } of this.hosts.values()) host.pause();
    this.emit();
  }

  resume(): void {
    for (const { host } of this.hosts.values()) host.resume();
    this.emit();
  }

  configure(settings: Partial<SceneBehaviorRuntimeSettings>): void {
    for (const { host } of this.hosts.values()) host.configure(settings);
  }

  stop(): void {
    for (const { host } of this.hosts.values()) host.dispose();
    this.hosts.clear();
    this.emit();
  }

  entries(): SceneBehaviorManagerEntry[] {
    return [...this.hosts.values()].map(({ module, host }) => ({
      module: structuredClone(module),
      diagnostics: host.diagnostics()
    }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
  }

  private reportStartFailure(module: SceneBehaviorModule, message: string): void {
    this.onLog?.(module.id, { level: "error", message });
  }

  private emit(): void {
    this.onChange?.(this.entries());
  }
}
