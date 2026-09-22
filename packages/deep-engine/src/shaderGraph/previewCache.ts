import type { ShaderGraphAssetV1 } from "./graphTypes.js";
import type { ShaderGraphPreviewResult } from "./preview.js";
import { prepareShaderGraphPreview } from "./preview.js";
import { shaderGraphHash } from "./graphSerialization.js";

export interface ShaderGraphPreviewCacheSnapshot {
  readonly key: string;
  readonly generation: number;
  readonly result: ShaderGraphPreviewResult;
}

/**
 * 编辑器预览的最近可用结果缓存。
 * 新请求先做图降级；失败时保留上一份成功结果，不让预览黑屏。
 */
export class ShaderGraphPreviewCache {
  private generation = 0;
  private currentSnapshot: ShaderGraphPreviewCacheSnapshot | undefined;

  get current(): ShaderGraphPreviewCacheSnapshot | undefined { return this.currentSnapshot; }

  prepare(graph: ShaderGraphAssetV1): {
    readonly status: "committed" | "reused" | "failed";
    readonly candidate: ShaderGraphPreviewResult;
    readonly current?: ShaderGraphPreviewCacheSnapshot;
  } {
    const key = shaderGraphHash(graph);
    if (this.currentSnapshot?.key === key) return { status: "reused", candidate: this.currentSnapshot.result,
      current: this.currentSnapshot };
    let candidate: ShaderGraphPreviewResult;
    try {
      candidate = prepareShaderGraphPreview({ graph, capabilities: { features: [], limits: {
        maxBindGroups: 4, maxBindingsPerBindGroup: 16, maxInterStageShaderVariables: 16 } } });
    } catch (error) {
      candidate = { success: false, diagnostics: [{ severity: "error", code: "invalid-value",
        provider: "lowering", path: "$", message: error instanceof Error ? error.message : String(error) }] };
    }
    if (!candidate.success) return { status: "failed", candidate,
      ...(this.currentSnapshot ? { current: this.currentSnapshot } : {}) };
    const snapshot = Object.freeze({ key, generation: ++this.generation, result: candidate });
    this.currentSnapshot = snapshot;
    return { status: "committed", candidate, current: snapshot };
  }

  clear(): void { this.currentSnapshot = undefined; }
}
