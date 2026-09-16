/// <reference types="@webgpu/types" />

const owners = new WeakMap<object, GPUDevice>();

/** Records the physical WebGPU device that owns an internal residency handle. */
export function bindGpuResidencyHandleDevice<T extends object>(handle: T, device: GPUDevice): T {
  owners.set(handle, device); return handle;
}

/** Unknown third-party handles retain the existing validation path; internal handles are device-exact. */
export function gpuResidencyHandleMatchesDevice(handle: object, device: GPUDevice): boolean {
  const owner = owners.get(handle);
  return owner === undefined || owner === device;
}
