export interface GpuSubmissionQueue {
  onSubmittedWorkDone(): Promise<void>;
}

/**
 * WebGPU 资源退休队列：对象先从场景解绑，待此前已提交的 GPU 命令完成后再释放底层资源。
 * 同一事件循环内的批量删除只等待一次队列，避免大型场景逐对象创建 Promise。
 */
export class GpuResourceRetirementQueue {
  private pending: Array<() => void> = [];
  private flushScheduled = false;

  constructor(private readonly getQueue: () => GpuSubmissionQueue | undefined) {}

  retire(dispose: () => void): void {
    this.pending.push(dispose);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => void this.flush());
  }

  /**
   * 查看器销毁时不再等待旧 GPU 队列；同步释放尚未提交的 Three 资源，
   * 避免 renderer 重建期间闭包和待完成 Promise 长时间保留旧场景。
   */
  dispose(): void {
    this.flushScheduled = false;
    const batch = this.pending.splice(0);
    for (const release of batch) release();
  }

  private async flush(): Promise<void> {
    this.flushScheduled = false;
    const batch = this.pending.splice(0);
    if (batch.length === 0) return;
    try {
      await this.getQueue()?.onSubmittedWorkDone();
    } catch {
      // 设备丢失时队列可能拒绝；仍需释放 JS/Three 资源，恢复流程会重建渲染器。
    }
    for (const dispose of batch) dispose();
  }
}
