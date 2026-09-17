/** 只决定是否执行重型帧；RAF 保留为轻量调度，连续源绝不按相机静止推断。 */
export class ViewerRenderDemand {
  private dirty = true;
  private invalidationRevision = 0;
  private admittedRevision: number | undefined;
  private settleUntil = 0;
  private readonly continuous = new Set<string>();
  private rendered = 0;
  private skipped = 0;
  private frameWorkMs = 0;
  private schedulerWorkMs = 0;

  invalidate(now: number, settleMs = 120): void {
    this.dirty = true;
    this.invalidationRevision += 1;
    this.settleUntil = Math.max(this.settleUntil, now + settleMs);
  }
  setContinuous(reason: string, active: boolean, now: number): void {
    const had = this.continuous.has(reason);
    if (active) this.continuous.add(reason); else this.continuous.delete(reason);
    if (had !== active) this.invalidate(now);
  }
  shouldRender(now: number, intrinsicActive: boolean, visible: boolean, xr: boolean): boolean {
    const render = (visible || xr || this.continuous.has("cloud-capture"))
      && (xr || intrinsicActive || this.continuous.size > 0 || this.dirty || now < this.settleUntil);
    if (render) this.admittedRevision = this.invalidationRevision;
    else this.skipped += 1;
    return render;
  }
  didRender(cpuMs = 0): void {
    // 只消费本帧准入前的请求；相机/资源在帧内触发的失效属于下一帧。
    this.dirty = this.admittedRevision !== undefined && this.admittedRevision !== this.invalidationRevision;
    this.admittedRevision = undefined;
    this.rendered += 1;
    this.frameWorkMs += Math.max(0, cpuMs);
  }
  recordSkippedCost(cpuMs: number): void { this.schedulerWorkMs += Math.max(0, cpuMs); }
  snapshot() {
    return { renderedFrames: this.rendered, skippedFrames: this.skipped,
      cpuFrameWorkMs: this.frameWorkMs, cpuSchedulerWorkMs: this.schedulerWorkMs,
      continuousSources: [...this.continuous] };
  }
}

export function isCloudCaptureSearch(search: string): boolean {
  const params = new URLSearchParams(search);
  return ["cloudRender", "remoteRender"].some(key => params.has(key) && !["0", "false", "off"].includes(params.get(key)!.toLowerCase()));
}
