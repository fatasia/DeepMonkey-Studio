export interface PbrLodWorkMetrics {
  readonly authorFrustumPasses?: number;
  readonly authorFrustumDispatches?: number;
  readonly meshletPasses?: number;
  readonly meshletDispatches?: number;
  readonly meshletFallbackReasons?: readonly string[];
}

/** Counts actual compute work across main, refreshed CSM and refreshed local views. */
export class PbrLodWork {
  private authorPasses = 0;
  private authorDispatches = 0;
  private meshletPasses = 0;
  private meshletDispatches = 0;
  private readonly reasons = new Set<string>();
  constructor(initial: PbrLodWorkMetrics) { this.add(initial); }
  add(work: PbrLodWorkMetrics & { readonly drawCalls?: number }): void {
    this.authorPasses += work.authorFrustumPasses ?? 0;
    this.authorDispatches += work.authorFrustumDispatches ?? 0;
    this.meshletPasses += work.meshletPasses ?? 0;
    this.meshletDispatches += work.meshletDispatches ?? 0;
    work.meshletFallbackReasons?.forEach(reason => this.reasons.add(reason));
  }
  snapshot(): PbrLodWorkMetrics {
    return { authorFrustumPasses: this.authorPasses, authorFrustumDispatches: this.authorDispatches,
      meshletPasses: this.meshletPasses, meshletDispatches: this.meshletDispatches,
      meshletFallbackReasons: [...this.reasons].sort() };
  }
}
