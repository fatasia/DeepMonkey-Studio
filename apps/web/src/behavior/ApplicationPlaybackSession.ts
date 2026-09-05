import type { ApplicationDocument, JsonValue, ProjectRecord } from "@bim-studio/contracts";
import type { ApplicationInteractionEffect, ApplicationInteractionEvent } from "@bim-studio/studio-core";
import type { SceneBehaviorDependencyModule, SceneBehaviorModule, SceneCommand, SceneEvent } from "@bim-studio/scene-sdk";
import { ApplicationPlaybackState } from "./ApplicationPlaybackState";
import { SceneBehaviorManager, type SceneBehaviorManagerEntry, type SceneBehaviorManagerOptions } from "./SceneBehaviorManager";
import { SceneCommandExecutor, type SceneCommandPort } from "./SceneCommandExecutor";
import { resolveSceneBehaviorModule } from "./scriptModuleAdapter";
import { authorizeSceneCommands } from "./sceneCommandPolicy";
import { executeUnityScriptCommand, isUnitySceneCommand } from "./unityScriptCommandHost";
import { publishApplicationInteractionEffects } from "../studio/applicationInteractionHost";
import type { ViewerEngine } from "../viewer/ViewerEngine";

export interface PlaybackLog {
  moduleId: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: JsonValue;
}

/** One preview owns its Workers, command ports, event bus and transient state. */
export class ApplicationPlaybackSession {
  readonly state: ApplicationPlaybackState;
  readonly effects = new EventTarget();
  readonly manager: SceneBehaviorManager;
  entries: SceneBehaviorManagerEntry[] = [];
  logs: PlaybackLog[] = [];
  loading = true;
  paused = false;
  onChange?: () => void;
  private modules: SceneBehaviorModule[] = [];
  private readonly ports = new Map<string, Set<SceneCommandPort>>();
  private readonly viewers = new Map<SceneCommandPort, ViewerEngine>();
  private readonly mounts = new Map<string, { sceneId: string }>();
  private pageId: string;
  private disposed = false;
  private generation = 0;
  private queue = Promise.resolve();

  constructor(readonly source: ApplicationDocument, pageId: string, private readonly options: SceneBehaviorManagerOptions & {
    project?: ProjectRecord;
    variables?: Readonly<Record<string, JsonValue>>;
    filters?: Readonly<Record<string, JsonValue>>;
    protectedDataEnabled?: boolean;
    isolateNavigation?: boolean;
    allowLegacyScripts?: boolean;
  } = {}) {
    this.state = new ApplicationPlaybackState(source, options.variables, options.filters);
    this.pageId = pageId;
    this.manager = new SceneBehaviorManager(options);
    this.state.onChange = () => this.emit();
    this.manager.onChange = (entries) => { this.entries = entries; this.emit(); };
    this.manager.onLog = (moduleId, log) => this.log({ moduleId, ...log });
    this.manager.onCommands = (id, commands) => {
      const mount = this.mounts.get(id);
      this.queue = this.queue.then(async () => {
        for (const command of commands) {
          if (this.disposed || !mount || this.mounts.get(id) !== mount) return;
          await this.execute(id, mount.sceneId, command);
        }
      }).catch((reason) => { if (!this.disposed) this.log({ moduleId: id, level: "error", message: String(reason) }); });
    };
    this.manager.onDataUpdates = (_id, updates) => this.setVariables(updates);
  }

  async start(loadDependencies: () => Promise<readonly SceneBehaviorDependencyModule[]> = async () => []) {
    const generation = ++this.generation;
    try {
      const dependencies = await loadDependencies();
      if (this.disposed || generation !== this.generation) return;
      this.modules = this.source.scripts.flatMap((script) => {
        const result = resolveSceneBehaviorModule(script, dependencies);
        if (result.status === "rejected") this.log({ moduleId: script.id, level: "error", message: result.message });
        return result.status === "ready" ? [result.module] : [];
      });
      this.reconcile();
    } catch (reason) {
      if (!this.disposed && generation === this.generation) this.log({ moduleId: "runtime", level: "error", message: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      if (!this.disposed && generation === this.generation) { this.loading = false; this.emit(); }
    }
  }

  get allowsProtectedData() { return this.options.protectedDataEnabled !== false; }
  get currentPageId() { return this.pageId; }

  selectPage(pageId: string) {
    if (this.disposed || pageId === this.pageId || !this.source.pages.some((page) => page.id === pageId)) return;
    this.pageId = pageId;
    this.reconcile();
    this.emit();
  }

  registerScene(sceneId: string, port: SceneCommandPort, viewer?: ViewerEngine): () => void {
    if (this.disposed) return () => undefined;
    const ports = this.ports.get(sceneId) ?? new Set<SceneCommandPort>();
    ports.add(port);
    this.ports.set(sceneId, ports);
    if (viewer) this.viewers.set(port, viewer);
    this.reconcile();
    return () => {
      ports.delete(port);
      this.viewers.delete(port);
      if (!ports.size) this.ports.delete(sceneId);
      if (!this.disposed) this.reconcile();
    };
  }

  advance(deltaMs: number) { if (!this.disposed && !this.paused) this.manager.advance(deltaMs); }
  get canStep() { return !this.disposed && this.paused && this.manager.canStep; }
  step() { return this.canStep && this.manager.step(); }
  togglePause() {
    this.paused = !this.paused;
    if (this.paused) this.manager.pause(); else this.manager.resume();
    this.emit();
  }
  setVariables(updates: Readonly<Record<string, JsonValue>>) {
    if (!this.disposed && this.state.setVariables(updates)) this.manager.dispatchData(this.state.variables);
  }
  dispatchEvent(event: SceneEvent) { if (!this.disposed) this.manager.dispatchEvent(event); }

  interact(event: ApplicationInteractionEvent) {
    const result = this.state.interact(event);
    this.manager.dispatchData(this.state.variables);
    this.emitEffects(result.effects);
    for (const id of result.matchedFlowIds) {
      const flow = this.state.document.interactions.find((flow) => flow.id === id);
      if (!flow?.legacyScript?.script.enabled) continue;
      if (!this.allowsProtectedData || this.options.allowLegacyScripts === false) {
        this.log({ moduleId: flow.id, level: "warn", message: "隔离运行不执行旧式主线程事件脚本；请迁移到 Worker 生命周期脚本。" });
        continue;
      }
      void import("../studio/trustedApplicationScript").then(async ({ runTrustedApplicationScript }) => {
        if (this.disposed) return;
        await runTrustedApplicationScript({
          application: this.state.document, flow, source: event.source, trigger: event.trigger, variables: this.state.variables,
          resolveSceneRuntime: (sceneId) => this.disposed ? undefined : [...(this.ports.get(sceneId) ?? [])].map((port) => this.viewers.get(port)).find(Boolean),
          setData: (key, value) => this.setVariables({ [key]: value }),
          updateComponent: (id, patch) => { if (!this.disposed) this.state.updateComponent(id, patch); },
          emitAction: (action) => this.emitEffects([{ flowId: flow.id, source: event.source, action, timestamp: event.timestamp }]),
          log: (message) => this.log({ moduleId: flow.id, level: "info", message }),
        });
      }).catch((reason) => this.log({ moduleId: flow.id, level: "error", message: String(reason) }));
    }
    if (event.source.kind === "widget") {
      this.manager.dispatchEvent({ type: "business.event", name: `component.${event.trigger}`, sceneId: `application:${this.source.metadata.id}`, sourceModuleId: `component:${event.source.id}`, timestamp: event.timestamp, data: { componentId: event.source.id, ...(event.payload === undefined ? {} : { payload: event.payload }) } }, event.source.id);
    }
    return result;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.mounts.clear();
    this.manager.dispose();
    this.ports.clear();
    this.viewers.clear();
    delete this.state.onChange;
    delete this.onChange;
  }

  private emitEffects(effects: readonly ApplicationInteractionEffect[]) {
    if (this.disposed) return;
    for (const effect of effects) {
      const { action, source } = effect;
      if (action.type === "setData" && action.dataKey && action.value !== undefined) this.setVariables({ [action.dataKey]: action.value });
      if (action.type === "unityAction" && source.kind === "widget" && action.unityAction) {
        this.effects.dispatchEvent(new CustomEvent("bim-studio:unity-action", { detail: { widgetId: source.id, action: action.unityAction, objectId: action.unityObjectId, value: action.value } }));
      }
    }
    publishApplicationInteractionEffects(effects, this.effects);
    // Navigation/message effects keep the existing platform routing; scene/data
    // effects stay on this session's private bus and cannot hit an author viewer.
    if (!this.options.isolateNavigation && typeof window !== "undefined") publishApplicationInteractionEffects(effects.filter(({ action }) => ["dashboard", "navigateScene", "openUrl", "message"].includes(action.type)), window);
  }

  private reconcile() {
    const page = this.source.pages.find((candidate) => candidate.id === this.pageId);
    const sceneIds = page?.nodes.flatMap((node) => node.kind === "scene-viewport" && node.renderMode !== "static-placeholder" ? [node.sceneId] : []) ?? [];
    const scopes = new Map<string, string>();
    for (const module of this.modules) {
      const target = module.target;
      if (target?.kind === "component") {
        if (page?.nodes.some((node) => node.id === target.id)) scopes.set(module.id, sceneIds[0] ?? `application:${this.source.metadata.id}`);
      } else if (target?.kind === "object") {
        const scene = this.source.scenes.find((scene) => sceneIds.includes(scene.id) && this.ports.has(scene.id) && [...scene.models, ...scene.primitives].some((item) => item.modelId === target.id));
        if (scene) scopes.set(module.id, scene.id);
      } else if (!sceneIds.length || this.ports.has(sceneIds[0]!)) {
        scopes.set(module.id, sceneIds[0] ?? `application:${this.source.metadata.id}`);
      }
    }
    for (const [id, mount] of this.mounts) if (scopes.get(id) !== mount.sceneId) this.mounts.delete(id);
    for (const [id, sceneId] of scopes) if (!this.mounts.has(id)) this.mounts.set(id, { sceneId });
    this.manager.reconcile(this.modules.filter((module) => scopes.has(module.id)), (module) => scopes.get(module.id)!);
    this.manager.dispatchData(this.state.variables);
    if (this.paused) this.manager.pause();
  }

  private async execute(id: string, sceneId: string, command: SceneCommand) {
    const module = this.modules.find((candidate) => candidate.id === id);
    if (!module) return;
    const authorization = authorizeSceneCommands(module, [command]);
    for (const rejection of authorization.rejected) this.log({ moduleId: id, level: "error", message: rejection.message });
    if (!authorization.allowed.length) return;
    try {
      if (command.type === "component.update") this.state.updateComponent(command.componentId, command.patch);
      else if (isUnitySceneCommand(command)) executeUnityScriptCommand(command, {
        application: this.state.document,
        ...(this.options.project ? { project: this.options.project } : {}),
        updateWidget: (componentId, widget) => this.state.updateComponent(componentId, { widget }),
        dispatchAction: (detail) => this.effects.dispatchEvent(new CustomEvent("bim-studio:unity-action", { detail })),
      });
      else {
        const ports = this.ports.get(sceneId);
        if (!ports?.size) throw new Error("关联三维视口尚未就绪，命令未执行");
        for (const port of ports) {
          if (this.disposed || !this.ports.get(sceneId)?.has(port)) return;
          const [result] = await new SceneCommandExecutor(sceneId, port).execute([command]);
          if (result && !result.success) this.log({ moduleId: id, level: "error", message: result.message });
        }
      }
    } catch (reason) {
      this.log({ moduleId: id, level: "error", message: reason instanceof Error ? reason.message : String(reason) });
    }
  }

  private log(entry: PlaybackLog) { if (!this.disposed) { this.logs = [...this.logs.slice(-199), entry]; this.emit(); } }
  private emit() { if (!this.disposed) this.onChange?.(); }
}
