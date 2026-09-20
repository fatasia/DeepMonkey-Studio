import { DeviceSession } from "./deviceSession.js";
import { LocalSpotShadowRuntime } from "./localSpotShadowRuntime.js";
import { ForwardPlusPbrRuntime } from "../lighting/forwardPlusPbrRuntime.js";
import { createPbrPipelineSet } from "./pbrPipelineSet.js";
import { createPbrEnvironment } from "./pbrEnvironmentSource.js";
import { resolvePbrRendererFeatures, type PbrRendererFeatures } from "./pbrRendererFeatures.js";
import type { Pipelines } from "./pipelines.js";
import type { StudioEnvironment } from "./studioEnvironment.js";
import type { PbrRendererOptions } from "./pbrRendererTypes.js";

/** Owns bootstrap error scopes and cancellation; the renderer owns successfully prepared resources. */
export async function openPbrRenderer<T>(session: DeviceSession,
  signal: AbortSignal, options: PbrRendererOptions, abortError: () => Error,
  create: (session: DeviceSession, pipelines: Pipelines, environment: StudioEnvironment,
    lighting: ForwardPlusPbrRuntime, shadows: LocalSpotShadowRuntime, options: PbrRendererOptions,
    features: PbrRendererFeatures, deformation?: Pipelines) => T): Promise<T> {
  const cancel = (): void => session.dispose();
  let scopeOpen = false;
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw abortError();
    session.device.pushErrorScope("validation"); scopeOpen = true;
    const localShadows = await LocalSpotShadowRuntime.create(session, signal), lighting = new ForwardPlusPbrRuntime(session, localShadows.bindings);
    const features = resolvePbrRendererFeatures(options.features);
    const [{ pipelines, deformationPipelines }, environment] = await Promise.all([
      createPbrPipelineSet(session, lighting.layout, options, features),
      createPbrEnvironment(session, options.environment, signal),
    ]);
    if (signal.aborted || session.state !== "ready") throw new Error("GPU preparation interrupted.");
    const renderer = create(session, pipelines, environment, lighting, localShadows, options, features, deformationPipelines);
    const pendingError = session.device.popErrorScope(); scopeOpen = false;
    const error = await pendingError;
    if (error) throw new Error(error.message);
    if (signal.aborted || session.state !== "ready") throw new Error("GPU preparation interrupted.");
    return renderer;
  } catch (error) {
    if (scopeOpen) try { await session.device.popErrorScope(); } catch { /* device loss owns diagnostics */ }
    session.dispose(); throw error;
  }
  finally { signal.removeEventListener("abort", cancel); }
}
