import { beforeEach, describe, expect, it } from "vitest";
import { currentRendererRebuildOrdinal, recordRendererRebuild, rendererRebuildFrameMetrics,
  resetRendererRebuildLedgerForTests } from "./pbrRendererRebuildAccounting.js";

const entry = (atMs: number, releasedEstimateBytes: number) => ({
  atMs, releasedEstimateBytes, bufferBytes: 0, textureBytes: 0,
  transientAllocatedBytes: 0, transientPeakResidentBytes: 0, pipelineCompiles: 0,
});

describe("renderer rebuild accounting ledger", () => {
  beforeEach(() => { resetRendererRebuildLedgerForTests(); });

  it("assigns monotonic ordinals and records releases in order", () => {
    expect(currentRendererRebuildOrdinal()).toBe(0);
    const first = recordRendererRebuild(entry(1, 100));
    expect(currentRendererRebuildOrdinal()).toBe(1);
    const second = recordRendererRebuild(entry(2, 200));
    expect(first.index).toBe(0);
    expect(second.index).toBe(1);
    expect(rendererRebuildFrameMetrics(1)).toMatchObject({ ordinal: 1, total: 2,
      last: { index: 1, atMs: 2, releasedEstimateBytes: 200 } });
  });

  it("keeps a bounded ledger while the total counts evicted entries", () => {
    for (let index = 0; index < 20; index += 1) recordRendererRebuild(entry(index, index * 10));
    const metrics = rendererRebuildFrameMetrics(20);
    expect(metrics.total).toBe(20);
    expect(metrics.last).toMatchObject({ index: 19, releasedEstimateBytes: 190 });
  });

  it("reports an empty ledger before the first rebuild", () => {
    expect(rendererRebuildFrameMetrics(0)).toEqual({ ordinal: 0, total: 0 });
  });
});
