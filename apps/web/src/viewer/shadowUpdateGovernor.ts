export type ShadowUpdateMode = "disabled" | "cached" | "dynamic" | "backend-managed";

export interface ShadowUpdateDecision {
  mode: ShadowUpdateMode;
  autoUpdate: boolean;
  needsUpdate: boolean;
}

export interface ShadowUpdateSnapshot {
  mode: ShadowUpdateMode;
  requestedUpdates: number;
}

/**
 * 静态场景只在内容变化后刷新阴影贴图；动画、物理和时间线运行时恢复逐帧更新。
 * 该策略只减少重复深度绘制，不改变阴影分辨率、灯光或模型效果。
 */
export class ShadowUpdateGovernor {
  private dirty = true;
  private wasDynamic = false;
  private mode: ShadowUpdateMode = "disabled";
  private requestedUpdates = 0;

  markDirty(): void {
    this.dirty = true;
  }

  evaluate(shadowsEnabled: boolean, dynamicScene: boolean, manualCacheSupported = true): ShadowUpdateDecision {
    if (!shadowsEnabled) {
      this.mode = "disabled";
      this.wasDynamic = false;
      return { mode: this.mode, autoUpdate: false, needsUpdate: false };
    }
    if (!manualCacheSupported) {
      this.mode = "backend-managed";
      this.wasDynamic = false;
      return { mode: this.mode, autoUpdate: true, needsUpdate: false };
    }
    if (dynamicScene) {
      this.mode = "dynamic";
      this.wasDynamic = true;
      this.dirty = false;
      return { mode: this.mode, autoUpdate: true, needsUpdate: false };
    }

    if (this.wasDynamic) this.dirty = true;
    this.wasDynamic = false;
    const needsUpdate = this.dirty;
    this.dirty = false;
    this.mode = "cached";
    if (needsUpdate) this.requestedUpdates += 1;
    return { mode: this.mode, autoUpdate: false, needsUpdate };
  }

  snapshot(): ShadowUpdateSnapshot {
    return { mode: this.mode, requestedUpdates: this.requestedUpdates };
  }
}
