export interface EnvironmentMipSelection {
  readonly rawMips: number;
  readonly keptMips: number;
  readonly droppedMips: number;
}

/** Original roughness domain survives physical chain-head eviction. */
export function environmentMipSelection(rawMips: number, keptMips = rawMips): EnvironmentMipSelection {
  if (!Number.isInteger(rawMips) || rawMips < 1 || rawMips > 16
    || !Number.isInteger(keptMips) || keptMips < 1 || keptMips > rawMips) {
    throw new RangeError("IBL keptMips must be an integer within the source mip chain.");
  }
  return Object.freeze({ rawMips, keptMips, droppedMips: rawMips - keptMips });
}

export function environmentSpecularLod(selection: EnvironmentMipSelection, roughness: number): number {
  if (!Number.isFinite(roughness)) throw new RangeError("IBL roughness must be finite.");
  return Math.min(selection.keptMips - 1, Math.max(0,
    roughness * (selection.rawMips - 1) - selection.droppedMips));
}
