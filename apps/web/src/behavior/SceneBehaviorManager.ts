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
  onDataUpdates?: (moduleId: string, updates: Record<string, JsonValue>) => void;
  onEvent?: (moduleId: string, event: { name: string; payload?: JsonValue }) => void;
  onLog?: (moduleId: string, entry: { level: "debug" | "info" | "warn" | "error"; message: string; data?: JsonValue }) => void;
  onChange?: (entries: SceneBehaviorManagerEntry[]) => void;

  private readonly workerFactory: () => SceneBehaviorWorkerPort;
  private readonly hostOptions: SceneBehaviorHostOptions;
  private readonly hosts = new Map<string, { module: SceneBehaviorModule; host: SceneBehaviorHost; sceneId: string }>();
  private disposed = false;
  private paused = false;

  constructor(options: SceneBehaviorManagerOptions = {}) {
    this.workerFactory = options.workerFactory ?? createSceneBehaviorWorker;
    this.hostOptions = options.hostOptions ?? {};
  }

  start(modules: readonly SceneBehaviorModule[], sceneId: string): void {
    if (this.disposed) throw new Error("行为管理器已销毁");
    if (!sceneId.trim()) throw new Error("行为管理器需要 sceneId");
    this.stop();
    this.reconcile(modules, () => sceneId);
  }

  /** Keep unchanged mounts alive across page changes; retire only removed scopes. */
  reconcile(modules: readonly SceneBehaviorModule[], sceneFor: (module: SceneBehaviorModule) => string): void {
    if (this.disposed) throw new Error("行为管理器已销毁");
    const next = new Map(modules.map((module) => [module.id, module]));
    for (const [id, entry] of this.hosts) {
      const candidate = next.get(id);
      if (candidate && sceneFor(candidate) === entry.sceneId && JSON.stringify(candidate) === JSON.stringify(entry.module)) continue;
      this.hosts.delete(id);
      entry.host.dispose();
    }
    const ids = new Set<string>();
    for (const module of modules) {
      if (ids.has(module.id)) {
        this.reportStartFailure(module, `行为脚本 ID 重复：${module.id}`);
        continue;
      }
      ids.add(module.id);
      if (this.hosts.has(module.id)) continue;
      let host: SceneBehaviorHost | undefined;
      try {
        const sceneId = sceneFor(module);
        if (!sceneId.trim()) throw new Error("行为管理器需要 sceneId");
        host = new SceneBehaviorHost(this.workerFactory(), this.hostOptions);
        const stored = structuredClone(module);
        const current = () => !this.disposed && this.hosts.get(stored.id)?.host === host;
        host.onCommands = (commands) => { if (current()) this.onCommands?.(stored.id, commands); };
        host.onDataUpdates = (updates) => { if (current()) this.onDataUpdates?.(stored.id, updates); };
        host.onEvent = (event) => {
          if (!current()) return;
          const sceneEvent: SceneEvent = {
            type: "business.event",
            name: event.name,
            sceneId,
            sourceModuleId: stored.id,
            timestamp: new Date().toISOString(),
            ...(event.payload === undefined ? {} : { data: event.payload })
          };
          for (const [moduleId, entry] of this.hosts) {
            if (moduleId !== stored.id) entry.host.dispatchEvent(sceneEvent);
          }
          this.onEvent?.(stored.id, event);
        };
        host.onLog = (entry) => { if (current()) this.onLog?.(stored.id, entry); };
        host.onDiagnosticsChange = (diagnostics) => {
          if (!current()) return;
          if (this.paused && diagnostics.status === "running") host?.pause();
          else this.emit();
        };
        this.hosts.set(stored.id, { module: stored, host, sceneId });
        host.start(stored, sceneId);
      } catch (reason) {
        this.hosts.delete(module.id);
        host?.dispose();
        this.reportStartFailure(module, reason instanceof Error ? reason.message : String(reason));
      }
    }
    this.emit();
  }

  advance(deltaMs: number): void {
    for (const { host } of this.hosts.values()) host.advance(deltaMs);
  }

  dispatchEvent(event: SceneEvent, componentId?: string): void {
    for (const { module, host, sceneId } of this.hosts.values()) {
      if (componentId && module.target && module.target.kind !== "scene" && (module.target.kind !== "component" || module.target.id !== componentId)) continue;
      const eventScene = event.type === "object.event" ? event.target.sceneId : event.sceneId;
      if (!componentId && event.type !== "business.event" && sceneId !== eventScene) continue;
      if (eventMatchesBehaviorTarget(event, module.target)) host.dispatchEvent(event);
    }
  }

  dispatchData(data: JsonValue): void {
    for (const { host } of this.hosts.values()) host.dispatchData(data);
  }

  pause(): void {
    this.paused = true;
    for (const { host } of this.hosts.values()) host.pause();
    this.emit();
  }

  resume(): void {
    this.paused = false;
    for (const { host } of this.hosts.values()) host.resume();
    this.emit();
  }

  configure(settings: Partial<SceneBehaviorRuntimeSettings>): void {
    for (const { host } of this.hosts.values()) host.configure(settings);
  }

  get canStep(): boolean {
    const entries = this.entries().filter(entry => entry.diagnostics.status !== "error");
    return this.paused && entries.length > 0 && entries.every(entry => entry.diagnostics.status === "paused" && entry.diagnostics.pendingInvocations === 0);
  }

  step(): boolean {
    if (this.disposed || !this.canStep) return false;
    for (const { host } of this.hosts.values()) host.step();
    return true;
  }

  stop(): void {
    this.paused = false;
    const entries = [...this.hosts.values()];
    this.hosts.clear();
    for (const { host } of entries) host.dispose();
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

/** 场景级事件向所有脚本广播；对象级事件只进入匹配的挂载行为。 */
function eventMatchesBehaviorTarget(event: SceneEvent, target: SceneBehaviorModule["target"]): boolean {
  if (!target || target.kind === "scene") return true;
  if (event.type === "object.event") {
    return (event.target.kind === "object" || event.target.kind === "mesh") && (event.target.objectId === target.id || event.target.kind === "mesh" && event.target.meshId === target.id);
  }
  if (event.type === "selection.changed") {
    return event.targets.some((candidate) => (candidate.kind === "object" || candidate.kind === "mesh") && (candidate.objectId === target.id || candidate.kind === "mesh" && candidate.meshId === target.id));
  }
  return true;
}
