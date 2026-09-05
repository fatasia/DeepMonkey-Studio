import { describe, expect, it } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import { resolveModelOptimizationOrigin } from "./modelOptimizationOrigin.js";

describe("optimized model provenance", () => {
  const origin = { itemId: "licensed", catalogVersion: 1 as const, contentHash: "hash", license: "CC-BY-4.0", attribution: { author: "author", text: "credit", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", sourceUrl: "https://example.com/model", modifications: "unchanged" } };
  const source = { id: "source", name: "source.glb", updatedAt: "2026-09-05", status: "ready", libraryOrigin: origin } as ModelRecord;
  it("retains a detached source-version and credit snapshot, not the dedup identity", () => {
    const result = resolveModelOptimizationOrigin("source", [source]);
    expect(result).toEqual({ sourceModelId: "source", sourceModelName: "source.glb", sourceUpdatedAt: "2026-09-05", libraryOrigin: origin });
    expect(result?.libraryOrigin).not.toBe(origin);
  });
  it("carries the original credit through repeated optimization", () => {
    const derivative = { ...source, id: "derivative", libraryOrigin: undefined, optimization: resolveModelOptimizationOrigin("source", [source]) } as unknown as ModelRecord;
    expect(resolveModelOptimizationOrigin("derivative", [derivative])?.libraryOrigin).toEqual(origin);
  });
  it.each(["missing", "", [], { id: "source" }])("rejects unknown or malformed source %j", id => {
    expect(() => resolveModelOptimizationOrigin(id, [source])).toThrow();
  });
  it("rejects unfinished source models", () => {
    expect(() => resolveModelOptimizationOrigin("source", [{ ...source, status: "failed" }])).toThrow();
    expect(resolveModelOptimizationOrigin(undefined, [])).toBeUndefined();
  });
});
