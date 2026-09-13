export interface GpuValidatedStage<T> {
  readonly value: T;
  readonly checked: Promise<void>;
}

/** Opens and closes all WebGPU allocation scopes synchronously around one staging operation. */
export function gpuValidatedStage<T>(device: GPUDevice, operation: () => T,
  failureMessage: string): GpuValidatedStage<T> {
  const checks: Promise<GPUError | null>[] = [];
  let depth = 0, value: T | undefined, failed = false, failure: unknown;
  try {
    for (const filter of ["validation", "out-of-memory", "internal"] as const) {
      device.pushErrorScope(filter); depth++;
    }
    value = operation();
  } catch (error) { failed = true; failure = error; }
  finally {
    while (depth-- > 0) {
      try { checks.push(device.popErrorScope()); }
      catch (error) { checks.push(Promise.reject(error)); }
    }
  }
  const checked = Promise.all(checks).then(errors => {
    const error = errors.find(candidate => candidate !== null);
    if (error) throw new Error(`${failureMessage}: ${error.message}`);
  });
  if (failed) { void checked.catch(() => {}); throw failure; }
  return { value: value!, checked };
}
