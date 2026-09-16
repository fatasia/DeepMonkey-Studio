import { BackendCanvasDeck } from "../src/threeBridge/BackendCanvasDeck.js";
import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { createDashboardCompositionGpuHost } from "../src/webgpu/dashboardCompositionHost.js";
import { DashboardCandidateController } from "../src/runtimePackage/dashboardCandidateController.js";
import type { DashboardCandidateNode } from "../src/runtimePackage/dashboardCandidateTypes.js";
import type { Deep2dRuntimePackage, DeepRuntimePackageV5 } from "../src/runtimePackage/types.js";
import { domCanvasHost, domCanvasSurface } from "./domCanvasPort.js";

export async function runDashboardCompositionProbe(element: HTMLElement, value: DeepRuntimePackageV5,
  chartFrame: (node: DashboardCandidateNode, signal: AbortSignal) => Promise<Deep2dRuntimePackage>) {
  const canvas = element.ownerDocument.createElement("canvas"); canvas.width = 960; canvas.height = 640;
  element.append(canvas);
  const deck = new BackendCanvasDeck(domCanvasHost(element), "initial", domCanvasSurface(canvas));
  const session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  const { loader, host } = createDashboardCompositionGpuHost({ deck, session, width: 960, height: 640,
    deviceEpoch: () => 1, chartFrame });
  const controller = new DashboardCandidateController(loader, host);
  try {
    const initial = await controller.publish(value, { deviceEpoch: 1 });
    if (initial.status !== "committed") throw new Error(JSON.stringify(initial));
    deck.initial.dispose();
    return {
      initial,
      get page() { return controller.activePage; },
      get diagnostics() { return session.diagnostics; },
      get surfaces() { return deck.surfaceCount; },
      async tick(elapsedMs: number) {
        return controller.publish(value, { deviceEpoch: 1, elapsedMs, expectedSource: controller.activePage!.identity });
      },
      async pageId(pageId: string) { return controller.publish(value, { deviceEpoch: 1, pageId }); },
      image() { return (deck.active!.canvas.native as HTMLCanvasElement).toDataURL("image/png"); },
      dispose() { controller.dispose(); deck.dispose(); session.dispose(); },
    };
  } catch (error) { controller.dispose(); deck.dispose(); session.dispose(); throw error; }
}
