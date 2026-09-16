import type { BackendCanvasDeck, BackendCanvasLease } from "../threeBridge/BackendCanvasDeck.js";
import type { DashboardCandidateHost, DashboardCandidateNode } from "../runtimePackage/dashboardCandidateTypes.js";
import type { Deep2dRuntimePackage } from "../runtimePackage/types.js";
import type { DeviceSession } from "./deviceSession.js";
import { buildDeep2dGpuFrame, type Deep2dFrameLayer } from "./deep2d/frame.js";
import { renderDeep2dGpuFrame, type Deep2dGpuLease } from "./deep2d/gpu.js";
import { dashboardGpuResourceLoader, decodeDeep2dAtlases, type DashboardGpuResource } from "./deep2d/resources.js";

export interface DashboardCompositionGpuOptions {
  readonly deck: BackendCanvasDeck;
  readonly session: Pick<DeviceSession, "device" | "format" | "state">;
  readonly width: number;
  readonly height: number;
  readonly deviceEpoch: () => number;
  readonly chartFrame?: (node: DashboardCandidateNode, signal: AbortSignal) => Promise<Deep2dRuntimePackage>;
}
export interface DashboardVisibleGpuFrame {
  readonly surface: BackendCanvasLease;
  readonly previous: BackendCanvasLease;
  readonly context: GPUCanvasContext;
  readonly gpu: Deep2dGpuLease;
  readonly epoch: number;
  released: boolean;
}

/** Real GPU preparation on a hidden canvas; the only visible operation is the existing transactional deck swap. */
export function createDashboardCompositionGpuHost(options: DashboardCompositionGpuOptions) {
  const { deck, session } = options;
  if (session.format !== "rgba8unorm" && session.format !== "bgra8unorm") throw new Error("Unsupported dashboard canvas format.");
  const targetFormat: GPUTextureFormat = session.format === "rgba8unorm" ? "rgba8unorm-srgb" : "bgra8unorm-srgb";
  const epoch = () => session.state === "ready" ? options.deviceEpoch() : -1;
  const host: DashboardCandidateHost<DashboardGpuResource, DashboardGpuResource, DashboardVisibleGpuFrame> = {
    currentDeviceEpoch: epoch,
    async prepare(page, resources, signal) {
      const check = () => { if (signal.aborted || epoch() !== page.identity.deviceEpoch) throw new Error("Dashboard GPU candidate cancelled or device changed."); };
      check();
      const prepared = new Map(resources.map(resource => [resource.item.resourceId, resource.prepared]));
      const layers: Deep2dFrameLayer[] = []; let chartAtlasBytes = 0;
      for (const node of page.nodes) {
        if (!node.node.visible) continue;
        if (node.deep2d) {
          const resource = prepared.get(node.deep2d.id);
          if (!resource?.atlases) throw new Error("Static Deep2D resource was not prepared.");
          layers.push({ node, content: node.deep2d, atlasBytes: resource.atlases });
        }
        if (node.chart) {
          if (!options.chartFrame) throw new Error("Dashboard chart requires a real ChartIR frame producer.");
          const content = await options.chartFrame(node, signal); check();
          if (content.displayList.logicalWidth !== node.node.frame[2] || content.displayList.logicalHeight !== node.node.frame[3]) {
            throw new Error("Chart frame dimensions differ from the dashboard node.");
          }
          chartAtlasBytes += content.atlases.reduce((sum, atlas) => sum + atlas.width * atlas.height * (atlas.kind === "glyph" ? 1 : 4), 0);
          if (chartAtlasBytes > 64 * 1024 * 1024) throw new Error("Combined chart atlas budget exceeded.");
          layers.push({ node, content, atlasBytes: decodeDeep2dAtlases(content) });
        }
      }
      check();
      const frame = buildDeep2dGpuFrame(layers, page.width, page.height, options.width, options.height);
      if (frame.width > session.device.limits.maxTextureDimension2D || frame.height > session.device.limits.maxTextureDimension2D) {
        throw new Error("Dashboard surface exceeds GPU limits.");
      }
      const previous = deck.active; if (!previous) throw new Error("Dashboard canvas deck has no active surface.");
      const surface = deck.reserve("deep-dashboard"), canvas = surface.canvas.native as HTMLCanvasElement;
      let context: GPUCanvasContext | null = null, gpu: Deep2dGpuLease | undefined;
      try {
        surface.canvas.width = frame.width; surface.canvas.height = frame.height;
        context = canvas.getContext("webgpu"); if (!context) throw new Error("Dashboard canvas requires WebGPU.");
        context.configure({ device: session.device, format: session.format, viewFormats: [targetFormat],
          alphaMode: "premultiplied", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
        gpu = await renderDeep2dGpuFrame(session.device, context, targetFormat, frame, signal);
        check();
        return { surface, previous, context, gpu, epoch: page.identity.deviceEpoch, released: false };
      } catch (error) {
        const failures: unknown[] = [error];
        for (const release of [() => gpu?.dispose(), () => context?.unconfigure(), () => surface.dispose()]) {
          try { release(); } catch (error) { failures.push(error); }
        }
        throw new AggregateError(failures, "Dashboard WebGPU preparation failed.");
      }
    },
    commitVisible(frame) {
      if (frame.released || epoch() !== frame.epoch) throw new Error("Stale dashboard GPU frame.");
      deck.publish(frame.surface, frame.previous);
    },
    release(frame) {
      if (frame.released) return; frame.released = true;
      const failures: unknown[] = [];
      for (const release of [() => frame.gpu.dispose(), () => frame.context.unconfigure(), () => frame.surface.dispose()]) {
        try { release(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Dashboard GPU release failed.");
    },
  };
  return { host, loader: dashboardGpuResourceLoader() };
}
