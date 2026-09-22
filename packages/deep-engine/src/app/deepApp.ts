import { FrameLoop, type FrameLoopDiagnostics, type FrameLoopMode } from "../frameLoop.js";
import { FrameScheduler, FrameSchedulerError, type FrameStageTrace } from "../frameScheduler.js";
import { DeepAppCleanupError, DeepAppConfigurationError, DeepAppInitializationError } from "./deepAppErrors.js";
import type { DeepAppAccess, DeepAppCleanup, DeepAppFrameStage, DeepAppHost, DeepAppOptions,
  DeepAppPlugin, DeepAppPluginContext, DeepAppResource, DeepAppStatus } from "./appTypes.js";

interface PluginRuntime {
  readonly id: string;
  readonly cleanups: DeepAppCleanup[];
}

export class DeepApp<TState> implements DeepAppHost<TState> {
  private statusValue: DeepAppStatus = "initializing";
  private readonly resources = new Map<DeepAppResource<unknown>, unknown>();
  private readonly resourceOwners = new Map<DeepAppResource<unknown>, string>();
  private readonly frameStages: DeepAppFrameStage<TState>[] = [];
  private readonly runtimes: PluginRuntime[] = [];
  private readonly plugins: ReadonlyMap<string, DeepAppPlugin<TState>>;
  private readonly pendingInvalidations = new Set<string>();
  private loop: FrameLoop<DeepAppAccess<TState>> | undefined;
  private activeAdvance: Promise<unknown> | undefined;
  private disposePromise: Promise<void> | undefined;

  private constructor(readonly state: TState, private readonly initialMode: FrameLoopMode,
    plugins: ReadonlyMap<string, DeepAppPlugin<TState>>) {
    this.plugins = plugins;
  }

  static async create<TState>(options: DeepAppOptions<TState>): Promise<DeepApp<TState>> {
    const plugins = compilePlugins(options.plugins ?? []);
    const app = new DeepApp(options.state, options.mode ?? "demand", plugins);
    await app.initialize();
    return app;
  }

  get status(): DeepAppStatus { return this.statusValue; }

  getResource<T>(key: DeepAppResource<T>): T | undefined {
    return this.resources.get(key as DeepAppResource<unknown>) as T | undefined;
  }

  requireResource<T>(key: DeepAppResource<T>): T {
    const value = this.getResource(key);
    if (value === undefined) throw new Error(`Application resource ${key.id} is unavailable.`);
    return value;
  }

  invalidate(reason: string): boolean {
    this.assertUsable("invalidate");
    if (this.loop) return this.loop.invalidate(reason);
    const before = this.pendingInvalidations.size;
    this.pendingInvalidations.add(reason);
    return before === 0;
  }

  shouldRequestFrame(): boolean {
    this.assertReady("inspect frame demand");
    return this.loop!.shouldRequestFrame();
  }

  setMode(mode: FrameLoopMode): void {
    this.assertReady("set frame mode");
    this.loop!.setMode(mode);
  }

  diagnostics(): FrameLoopDiagnostics {
    this.assertReady("read frame diagnostics");
    return this.loop!.diagnostics();
  }

  async advance(timeMs: number) {
    this.assertReady("advance a frame");
    const pending = this.loop!.advance(timeMs, this);
    this.activeAdvance = pending;
    try { return await pending; }
    finally { if (this.activeAdvance === pending) this.activeAdvance = undefined; }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    if (this.statusValue === "disposed") return Promise.resolve();
    this.statusValue = "disposing";
    this.disposePromise = this.disposeImpl();
    return this.disposePromise;
  }

  private async initialize(): Promise<void> {
    let firstCause: unknown;
    const descriptors = [...this.plugins.values()].map(plugin => ({
      id: plugin.id, ...(plugin.dependencies === undefined ? {} : { dependencies: plugin.dependencies }),
      shouldRun: () => firstCause === undefined,
      execute: async () => {
        const runtime = { id: plugin.id, cleanups: [] }; this.runtimes.push(runtime);
        try {
          const returned = await plugin.setup(this.pluginContext(runtime));
          if (returned !== undefined) this.addCleanup(runtime, returned);
        } catch (error: unknown) { firstCause = error; throw error; }
      },
    }));
    let scheduler: FrameScheduler<void>;
    try { scheduler = new FrameScheduler(descriptors); }
    catch (error: unknown) {
      this.statusValue = "failed";
      if (error instanceof FrameSchedulerError) throw new DeepAppConfigurationError(error.issues);
      throw error;
    }
    const result = await scheduler.run(undefined);
    if (result.status !== "completed" || firstCause !== undefined) {
      await this.failInitialization(result.trace, firstCause); return;
    }
    try {
      this.loop = new FrameLoop(this.initialMode, this.frameStages);
      for (const reason of this.pendingInvalidations) this.loop.invalidate(reason);
      this.pendingInvalidations.clear(); this.statusValue = "ready";
    } catch (error: unknown) {
      await this.failInitialization([], error);
    }
  }

  private pluginContext(runtime: PluginRuntime): DeepAppPluginContext<TState> {
    return Object.freeze({
      pluginId: runtime.id,
      state: this.state,
      get status() { return "initializing" as const; },
      getResource: <T>(key: DeepAppResource<T>) => this.getResource(key),
      requireResource: <T>(key: DeepAppResource<T>) => this.requireResource(key),
      invalidate: (reason: string) => this.invalidate(reason),
      hasPlugin: (id: string) => this.plugins.has(id),
      provide: <T>(key: DeepAppResource<T>, value: T) => this.provide(runtime, key, value),
      addFrameStage: (stage: DeepAppFrameStage<TState>) => this.frameStages.push(stage),
      onDispose: (cleanup: DeepAppCleanup) => this.addCleanup(runtime, cleanup),
    });
  }

  private provide<T>(runtime: PluginRuntime, key: DeepAppResource<T>, value: T): void {
    const untyped = key as DeepAppResource<unknown>, owner = this.resourceOwners.get(untyped);
    if (owner !== undefined) throw new Error(`Application resource ${key.id} is already provided by plugin ${owner}.`);
    this.resources.set(untyped, value); this.resourceOwners.set(untyped, runtime.id);
  }

  private addCleanup(runtime: PluginRuntime, cleanup: DeepAppCleanup): void {
    if (typeof cleanup !== "function") throw new TypeError(`Plugin ${runtime.id} disposer must be a function.`);
    runtime.cleanups.push(cleanup);
  }

  private async failInitialization(trace: readonly FrameStageTrace[], cause: unknown): Promise<never> {
    this.statusValue = "failed";
    const cleanupErrors = await this.cleanupPlugins();
    this.clearContributions();
    throw new DeepAppInitializationError(trace, cleanupErrors, cause);
  }

  private async disposeImpl(): Promise<void> {
    if (this.activeAdvance) await this.activeAdvance.catch(() => undefined);
    const errors = await this.cleanupPlugins();
    this.clearContributions(); this.statusValue = "disposed";
    if (errors.length > 0) throw new DeepAppCleanupError(errors);
  }

  private async cleanupPlugins(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (let pluginIndex = this.runtimes.length - 1; pluginIndex >= 0; pluginIndex--) {
      const cleanups = this.runtimes[pluginIndex]!.cleanups;
      for (let index = cleanups.length - 1; index >= 0; index--) {
        try { await cleanups[index]!(); } catch (error: unknown) { errors.push(error); }
      }
    }
    this.runtimes.length = 0;
    return errors;
  }

  private clearContributions(): void {
    this.resources.clear(); this.resourceOwners.clear(); this.frameStages.length = 0;
    this.pendingInvalidations.clear(); this.loop = undefined;
  }

  private assertUsable(action: string): void {
    if (this.statusValue !== "initializing" && this.statusValue !== "ready") {
      throw new Error(`Cannot ${action} while application is ${this.statusValue}.`);
    }
  }

  private assertReady(action: string): void {
    if (this.statusValue !== "ready") throw new Error(`Cannot ${action} while application is ${this.statusValue}.`);
  }
}

function compilePlugins<TState>(plugins: readonly DeepAppPlugin<TState>[]): ReadonlyMap<string, DeepAppPlugin<TState>> {
  const result = new Map<string, DeepAppPlugin<TState>>(), issues: string[] = [];
  for (const plugin of plugins) {
    if (!plugin || typeof plugin.id !== "string" || plugin.id.trim().length === 0) {
      issues.push("Plugin id must be a non-empty string."); continue;
    }
    if (plugin.id !== plugin.id.trim()) issues.push(`Plugin id must not contain surrounding whitespace: ${plugin.id}.`);
    if (result.has(plugin.id)) issues.push(`Duplicate plugin: ${plugin.id}.`);
    else result.set(plugin.id, plugin);
  }
  if (issues.length > 0) throw new DeepAppConfigurationError(issues);
  return result;
}
