import type { RadianceHdrImage } from "../textures/radianceHdr.js";
import type { HdrEnvironmentOptions } from "./hdrEnvironment.js";
import type { ReflectionProbeBoxSpec } from "../lighting/reflectionProbeParallax.js";
import { packPbrReflectionProbes, attachPbrReflectionProbes } from "./pbrReflectionProbes.js";
import { compileReflectionProbePrefilter, createReflectionProbeSpecularEnvironment } from "./reflectionProbeSpecularEnvironment.js";
import type { DeviceSession } from "./deviceSession.js";
import type { StudioEnvironment } from "./studioEnvironment.js";
import { failWithResourceCleanup } from "./resourceCleanup.js";
import { gpuAbortReason } from "./gpuAbort.js";

export interface PbrReflectionProbeSource {
  readonly box: ReflectionProbeBoxSpec;
  /** Omitted reuses the base cubemap with local parallax correction and no upload. */
  readonly image?: RadianceHdrImage;
  readonly options?: HdrEnvironmentOptions;
}

/** Freeze records/options before asynchronous preparation; images are caller-owned published RGB32F pixels. */
export function snapshotPbrReflectionProbeSources(sources: readonly PbrReflectionProbeSource[] | undefined): readonly PbrReflectionProbeSource[] | undefined {
  if (sources === undefined) return undefined;
  packPbrReflectionProbes(sources);
  return Object.freeze(sources.map(source => {
    const image = source.image;
    if (image && (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1
      || !(image.data instanceof Float32Array) || image.data.length !== image.width * image.height * 3)) throw new TypeError("Reflection probe source must be RGB32F pixels.");
    return Object.freeze({ ...source, box: Object.freeze({ ...source.box,
      center: Object.freeze([...source.box.center]), halfExtents: Object.freeze([...source.box.halfExtents]),
      ...(source.box.captureOffset ? { captureOffset: Object.freeze([...source.box.captureOffset]) } : {}) }) as ReflectionProbeBoxSpec,
      ...(source.options ? { options: Object.freeze({ ...source.options }) } : {}) });
  }));
}

/** A bounded per-candidate map shares identical source preparation; nothing persists across epochs. */
export async function preparePbrReflectionProbes(session: DeviceSession, base: StudioEnvironment,
  sources: readonly PbrReflectionProbeSource[] | undefined, signal: AbortSignal, baseImage?: RadianceHdrImage): Promise<StudioEnvironment> {
  if (!sources?.length) return base;
  const device = session.device;
  const owned: StudioEnvironment[] = [];
  try {
    if (signal.aborted) throw gpuAbortReason(signal, "Reflection probe preparation cancelled.");
    let pipeline: GPUComputePipeline | undefined;
    const prepared: { image: RadianceHdrImage; options: string; environment: StudioEnvironment }[] = [];
    const probes = [];
    for (const source of sources) {
      if (session.device !== device) throw new Error("GPU epoch changed during reflection probe preparation.");
      let environment = base;
      if (source.image && source.image !== baseImage) {
        const optionsKey = JSON.stringify(source.options ?? {});
        const existing = prepared.find(item => item.image === source.image && item.options === optionsKey);
        if (existing) environment = existing.environment;
        else {
          pipeline ??= await compileReflectionProbePrefilter(session, signal);
          environment = await createReflectionProbeSpecularEnvironment(session, source.image, base, pipeline, signal, source.options);
          owned.push(environment); prepared.push({ image: source.image, options: optionsKey, environment });
        }
      }
      probes.push({ box: source.box, environment });
    }
    if (signal.aborted) throw gpuAbortReason(signal, "Reflection probe preparation cancelled.");
    if (session.device !== device) throw new Error("GPU epoch changed during reflection probe preparation.");
    return attachPbrReflectionProbes(base, probes);
  } catch (error) {
    failWithResourceCleanup(error, "Reflection probes preparation failed.", [() => base.dispose(), ...owned.map(owner => () => owner.dispose())]);
  }
}
