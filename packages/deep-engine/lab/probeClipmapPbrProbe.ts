/// <reference types="@webgpu/types" />
import {
  ProbeClipmapPbrController,
  type PbrRenderer,
  type ProbeClipmapPbrTarget,
  type ProbeClipmapRuntimeFrameInput,
  type RenderView,
} from "@bim-studio/deep-engine/webgpu";

const FALLBACK_RADIANCE = Object.freeze([0.25, 0.5, 0.75] as const);
const SCENE_BOUNDS = Object.freeze({ min: [-100, -100, -100], max: [100, 100, 100] } as const);

export interface ProbeClipmapPbrProbeChecks {
  readonly committedBindingRendered: boolean;
  readonly smallMoveUpdatedWithinBudget: boolean;
  readonly cameraCutDirtyPrioritized: boolean;
  readonly cancellationPreservedBinding: boolean;
  readonly disposeClearedRendererBinding: boolean;
  readonly resourcesReturnedToBaseline: boolean;
  readonly gpuHealthy: boolean;
  readonly fallbackModeReported: boolean;
}

export interface ProbeClipmapPbrProbeResult {
  readonly action: "probe-clipmap-pbr-controller";
  readonly success: boolean;
  readonly checks: Readonly<ProbeClipmapPbrProbeChecks>;
  readonly metrics: Readonly<{
    captureMode: "fallback-radiance";
    sceneCaptureVerified: false;
    fallbackRadiance: typeof FALLBACK_RADIANCE;
    publishedGenerations: readonly number[];
    renderedFrameNumbers: readonly number[];
    updateCounts: readonly number[];
    updatesByClass: readonly Readonly<Record<string, number>>[];
    cancelledStatus: string;
    resourcesBefore: number;
    peakResources: number;
    resourcesAfter: number;
  }>;
  readonly failure?: string;
}

export function evaluateProbeClipmapPbrChecks(checks: ProbeClipmapPbrProbeChecks): boolean {
  return Object.values(checks).every(Boolean);
}

/** Proves committed probe volumes cross the controller boundary into real PBR frames. */
export async function runProbeClipmapPbrProbe(renderer: PbrRenderer, canvas: HTMLCanvasElement,
  signal?: AbortSignal): Promise<ProbeClipmapPbrProbeResult> {
  const session = renderer.session;
  if (session.state !== "ready") throw new Error("Probe clipmap PBR probe requires a ready renderer.");
  const renderView = view(canvas), diagnosticsBefore = session.diagnostics.length;
  await renderer.validateFrame(renderView);
  const resourcesBefore = session.resourceCount;
  const published: Array<Parameters<ProbeClipmapPbrTarget["setProbeClipmap"]>[0]> = [];
  const publishedGenerations: number[] = [], renderedFrameNumbers: number[] = [], updateCounts: number[] = [];
  const updatesByClass: Array<Readonly<Record<string, number>>> = [];
  let peakResources = resourcesBefore, cancelledStatus = "not-run", failure: string | undefined;
  let committedBindingRendered = false, smallMoveUpdatedWithinBudget = false;
  let cameraCutDirtyPrioritized = false, cancellationPreservedBinding = false;
  let disposeClearedRendererBinding = false, resourcesReturnedToBaseline = false;
  let controller: ProbeClipmapPbrController | undefined;
  try {
    const epoch = `lab-pbr-probe-${Date.now()}`;
    controller = new ProbeClipmapPbrController({ session, setProbeClipmap(binding) {
      published.push(binding); renderer.setProbeClipmap(binding);
    } }, epoch, { frameBudget: 4, cameraCutBudget: 6,
      clipmap: { levelCount: 2, gridSize: [4, 2, 4] }, fallbackRadiance: FALLBACK_RADIANCE });

    const first = await controller.beginFrame(input(0, [0, 0, 0], canvas), signal);
    const firstFrame = await renderer.validateFrame(renderView);
    collect(first, publishedGenerations, renderedFrameNumbers, updateCounts, updatesByClass, firstFrame.frame);
    peakResources = Math.max(peakResources, session.resourceCount);
    committedBindingRendered = first.status === "committed" && !!first.snapshot?.binding
      && published.at(-1) === first.snapshot.binding;

    const moved = await controller.beginFrame(input(1, [4, 0, 0], canvas), signal);
    const movedFrame = await renderer.validateFrame(renderView);
    collect(moved, publishedGenerations, renderedFrameNumbers, updateCounts, updatesByClass, movedFrame.frame);
    peakResources = Math.max(peakResources, session.resourceCount);
    smallMoveUpdatedWithinBudget = moved.status === "committed"
      && moved.snapshot?.frameStats.invalidation === "none"
      && (moved.snapshot.frameStats.updatesByClass.scroll ?? 0) > 0
      && moved.snapshot.frameStats.updateCount > 0 && moved.snapshot.frameStats.updateCount <= 4;

    const dirtyBounds = [{ min: [-100, -100, -100], max: [100, 100, 100] } as const];
    const cut = await controller.beginFrame({ ...input(2, [32, 0, 0], canvas), cameraCut: true, dirtyBounds }, signal);
    const cutFrame = await renderer.validateFrame(renderView);
    collect(cut, publishedGenerations, renderedFrameNumbers, updateCounts, updatesByClass, cutFrame.frame);
    peakResources = Math.max(peakResources, session.resourceCount);
    cameraCutDirtyPrioritized = cut.status === "committed" && cut.snapshot?.frameStats.frameBudget === 6
      && cut.snapshot.frameStats.updateCount > 0 && cut.snapshot.frameStats.updateCount <= 6
      && (cut.snapshot.frameStats.updatesByClass.dirty ?? 0) > 0;

    const committed = controller.current, publishCount = published.length;
    const cancelled = new AbortController(); cancelled.abort(new Error("probe cancellation"));
    const cancelledFrame = await controller.beginFrame(input(3, [33, 0, 0], canvas), cancelled.signal);
    cancelledStatus = cancelledFrame.status;
    cancellationPreservedBinding = cancelledFrame.status === "cancelled" && controller.current === committed
      && cancelledFrame.snapshot === committed && published.length === publishCount;

    controller.dispose(); controller = undefined;
    const clearedFrame = await renderer.validateFrame(renderView); renderedFrameNumbers.push(clearedFrame.frame);
    disposeClearedRendererBinding = published.at(-1) === undefined;
    resourcesReturnedToBaseline = session.resourceCount === resourcesBefore;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    controller?.dispose();
  }

  const resourcesAfter = session.resourceCount;
  resourcesReturnedToBaseline &&= resourcesAfter === resourcesBefore;
  const gpuHealthy = session.state === "ready" && session.diagnostics.length === diagnosticsBefore;
  const checks = Object.freeze({ committedBindingRendered, smallMoveUpdatedWithinBudget,
    cameraCutDirtyPrioritized, cancellationPreservedBinding, disposeClearedRendererBinding,
    resourcesReturnedToBaseline, gpuHealthy, fallbackModeReported: true });
  const metrics = Object.freeze({ captureMode: "fallback-radiance" as const,
    sceneCaptureVerified: false as const, fallbackRadiance: FALLBACK_RADIANCE,
    publishedGenerations: Object.freeze(publishedGenerations),
    renderedFrameNumbers: Object.freeze(renderedFrameNumbers), updateCounts: Object.freeze(updateCounts),
    updatesByClass: Object.freeze(updatesByClass), cancelledStatus, resourcesBefore, peakResources, resourcesAfter });
  return Object.freeze({ action: "probe-clipmap-pbr-controller", success: !failure && evaluateProbeClipmapPbrChecks(checks),
    checks, metrics, ...(failure ? { failure } : {}) });
}

function input(frame: number, cameraPosition: readonly [number, number, number],
  canvas: HTMLCanvasElement): ProbeClipmapRuntimeFrameInput {
  return { frame, viewport: [Math.max(1, canvas.width), Math.max(1, canvas.height)],
    cameraPosition, sceneBounds: SCENE_BOUNDS };
}

function view(canvas: HTMLCanvasElement): RenderView {
  return { width: Math.max(1, canvas.clientWidth || canvas.width),
    height: Math.max(1, canvas.clientHeight || canvas.height), pixelRatio: devicePixelRatio,
    eye: [0, 1.5, 4], target: [0, 0.8, 0], up: [0, 1, 0], extent: 3,
    background: [0.002, 0.003, 0.005], floor: [0.01, 0.012, 0.015], exposure: 1, roughness: 0.7 };
}

function collect(result: Awaited<ReturnType<ProbeClipmapPbrController["beginFrame"]>>,
  generations: number[], rendered: number[], counts: number[],
  classes: Array<Readonly<Record<string, number>>>, frame: number): void {
  if (result.snapshot) generations.push(result.snapshot.generation);
  rendered.push(frame); counts.push(result.snapshot?.frameStats.updateCount ?? 0);
  classes.push(result.snapshot?.frameStats.updatesByClass ?? Object.freeze({}));
}
