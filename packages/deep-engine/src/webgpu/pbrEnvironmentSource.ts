import type { RadianceHdrImage } from "../textures/radianceHdr.js";
import { createHdrEnvironment, type HdrEnvironmentOptions } from "./hdrEnvironment.js";
import type { DeviceSession } from "./deviceSession.js";
import { createStudioEnvironment, type StudioEnvironment } from "./studioEnvironment.js";

function cancelled(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error("GPU preparation cancelled"); error.name = "AbortError"; return error;
}

export type PbrEnvironmentSource =
  | { readonly kind: "studio" }
  | {
    readonly kind: "radiance-hdr";
    readonly image: RadianceHdrImage;
    readonly options?: HdrEnvironmentOptions;
  };

function assertSource(source: PbrEnvironmentSource | undefined): void {
  if (source === undefined) return;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("PBR environment source must be an object.");
  }
  if (source.kind !== "studio" && source.kind !== "radiance-hdr") {
    throw new RangeError("Unknown PBR environment source.");
  }
}

/** Resolves the renderer's initial IBL resources without introducing global environment state. */
export async function createPbrEnvironment(session: DeviceSession, source: PbrEnvironmentSource | undefined,
  signal: AbortSignal): Promise<StudioEnvironment> {
  assertSource(source);
  if (signal.aborted) throw cancelled(signal.reason);
  if (!source || source.kind === "studio") return await createStudioEnvironment(session, signal);
  return await createHdrEnvironment(session, source.image, source.options, signal);
}
