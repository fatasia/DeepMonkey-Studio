import {
  GpuResidencyExecutor,
  ResidencyStreamScheduler,
  ResourceResidencyController,
  type GpuResidencyExecutorOptions,
  type ResidencyBudgets,
  type ResidencyStreamFrameResult,
  type ResidencyRequest,
} from "../streaming/index.js";
import type { DeviceSession } from "./deviceSession.js";
import { GpuBufferResidencyUploader, type GpuBufferResidencySourceProvider } from "./gpuBufferResidencyUploader.js";

export interface GpuResidencyRuntimeOptions extends GpuResidencyExecutorOptions {
  readonly usage?: GPUBufferUsageFlags;
}

/** 将驻留计划、上传端和 DeviceSession 绑定成一个可随渲染设备销毁的运行时。 */
export class GpuResidencyRuntime {
  readonly controller: ResourceResidencyController;
  readonly executor: GpuResidencyExecutor<GPUBuffer>;
  readonly scheduler: ResidencyStreamScheduler<GPUBuffer>;

  constructor(session: DeviceSession, budgets: ResidencyBudgets,
    sourceFor: GpuBufferResidencySourceProvider, options: GpuResidencyRuntimeOptions = {}) {
    this.controller = new ResourceResidencyController(budgets);
    const uploader = new GpuBufferResidencyUploader(session, sourceFor, options.usage);
    this.executor = new GpuResidencyExecutor(this.controller, uploader, {
      ...(options.maxConcurrentUploads === undefined ? {} : { maxConcurrentUploads: options.maxConcurrentUploads }),
      deviceLost: options.deviceLost ?? session.device.lost,
    });
    this.scheduler = new ResidencyStreamScheduler(this.controller, this.executor);
  }

  submit(frame: number, requests: readonly ResidencyRequest[],
    signal?: AbortSignal): Promise<ResidencyStreamFrameResult> {
    return this.scheduler.submit(frame, requests, signal);
  }

  dispose(): void { this.scheduler.dispose(); }
}
