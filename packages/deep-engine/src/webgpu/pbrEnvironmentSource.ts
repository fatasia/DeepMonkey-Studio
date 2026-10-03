import type { RadianceHdrImage } from "../textures/radianceHdr.js";
import { createHdrEnvironment, type HdrEnvironmentOptions } from "./hdrEnvironment.js";
import type { DeviceSession } from "./deviceSession.js";
import { createStudioEnvironment, type StudioEnvironment } from "./studioEnvironment.js";
import { createPrefilteredEnvironment } from "./prefilteredEnvironment.js";
import type { RuntimePrefilteredIbl } from "../runtimePackage/environmentTypes.js";
import { preparePbrReflectionProbes, snapshotPbrReflectionProbeSources, type PbrReflectionProbeSource } from "./pbrReflectionProbePreparation.js";

function cancelled(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error("GPU preparation cancelled"); error.name = "AbortError"; return error;
}

export type PbrEnvironmentSource = (
  | { readonly kind: "studio" }
  | { readonly kind: "prefiltered-ibl"; readonly environment: RuntimePrefilteredIbl }
  | {
    readonly kind: "radiance-hdr";
    readonly image: RadianceHdrImage;
    readonly backgroundImage?: RadianceHdrImage;
    readonly options?: HdrEnvironmentOptions;
  }) & { readonly reflectionProbes?: readonly PbrReflectionProbeSource[];
    /** Chain tail from DynamicIblStagePlan; omitted uploads/generates the complete source. */
    readonly keptMips?: number };

function assertSource(source: PbrEnvironmentSource | undefined): void {
  if (source === undefined) return;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("PBR environment source must be an object.");
  }
  if (source.kind !== "studio" && source.kind !== "radiance-hdr" && source.kind !== "prefiltered-ibl") {
    throw new RangeError("Unknown PBR environment source.");
  }
}

/** Resolves the renderer's initial IBL resources without introducing global environment state. */
export async function createPbrEnvironment(session: DeviceSession, source: PbrEnvironmentSource | undefined,
  signal: AbortSignal): Promise<StudioEnvironment> {
  assertSource(source);
  const probes = snapshotPbrReflectionProbeSources(source?.reflectionProbes);
  if (signal.aborted) throw cancelled(signal.reason);
  const base = !source || source.kind === "studio" ? await createStudioEnvironment(session, signal, source?.keptMips)
    : source.kind === "prefiltered-ibl" ? await createPrefilteredEnvironment(session, source.environment, signal, source.keptMips)
    : await createHdrEnvironment(session, source.image, { ...source.options,
      ...(source.keptMips === undefined ? {} : { keptMips: source.keptMips }) }, signal, source.backgroundImage);
  return await preparePbrReflectionProbes(session, base, probes, signal, source?.kind === "radiance-hdr" ? source.image : undefined);
}
