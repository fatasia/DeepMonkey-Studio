import type {
  InstalledPluginFactory,
  PluginActivationContext,
  PluginInstance,
  PluginManifestV1
} from "@bim-studio/plugin-runtime";
import { AgvMotionSourceRouter, type AgvMotionMode, type AgvMotionSource } from "./agv-motion.js";
import type { FactoryFlowModel } from "./model.js";
import { FactoryFlowSimulation } from "./simulation.js";

export const FACTORY_FLOW_PLUGIN_ID = "bim-studio.factory-flow";

export const FACTORY_FLOW_PLUGIN_MANIFEST: PluginManifestV1 = {
  schemaVersion: 1,
  id: FACTORY_FLOW_PLUGIN_ID,
  name: "Factory Flow",
  version: "0.1.0",
  apiVersion: "1.0",
  hosts: ["browser", "tauri", "cloud"],
  capabilities: [],
  permissions: [],
  extensionPoints: [
    {
      kind: "editor.panel",
      id: "bim-studio.factory-flow-panel",
      title: "工厂物流仿真",
      placement: "right",
      order: 80
    }
  ]
};

export interface FactoryFlowPluginService {
  readonly simulation: FactoryFlowSimulation;
  readonly agvMotion: AgvMotionSourceRouter;
  readonly disposed: boolean;
}

export interface FactoryFlowPluginOptions {
  model: FactoryFlowModel;
  agvMotionSources: readonly AgvMotionSource[];
  initialAgvMotionMode?: AgvMotionMode;
  onActivate?(service: FactoryFlowPluginService, context: PluginActivationContext): void | Promise<void>;
  onDeactivate?(service: FactoryFlowPluginService): void | Promise<void>;
}

/**
 * Produces an installed factory for PluginRegistry. Merely importing or registering this
 * package creates no simulation, timer, renderer hook or application state.
 */
export function createFactoryFlowPluginFactory(options: FactoryFlowPluginOptions): InstalledPluginFactory {
  return async (context) => {
    const service = new MutableFactoryFlowPluginService(options);
    const abort = () => service.dispose();
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      await options.onActivate?.(service, context);
    } catch (error) {
      context.signal.removeEventListener("abort", abort);
      service.dispose();
      throw error;
    }
    return new FactoryFlowPluginInstance(service, options.onDeactivate, context.signal, abort);
  };
}

class MutableFactoryFlowPluginService implements FactoryFlowPluginService {
  public readonly simulation: FactoryFlowSimulation;
  public readonly agvMotion: AgvMotionSourceRouter;
  #disposed = false;

  public constructor(options: FactoryFlowPluginOptions) {
    this.simulation = new FactoryFlowSimulation(options.model);
    this.agvMotion = new AgvMotionSourceRouter(options.agvMotionSources, options.initialAgvMotionMode ?? "simulation");
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.simulation.pause();
    this.agvMotion.resetAll();
  }
}

class FactoryFlowPluginInstance implements PluginInstance {
  #deactivated = false;

  public constructor(
    private readonly service: MutableFactoryFlowPluginService,
    private readonly onDeactivate: FactoryFlowPluginOptions["onDeactivate"],
    private readonly signal: AbortSignal,
    private readonly abortListener: () => void
  ) {}

  public async deactivate(): Promise<void> {
    if (this.#deactivated) return;
    this.#deactivated = true;
    this.signal.removeEventListener("abort", this.abortListener);
    this.service.dispose();
    await this.onDeactivate?.(this.service);
  }
}
