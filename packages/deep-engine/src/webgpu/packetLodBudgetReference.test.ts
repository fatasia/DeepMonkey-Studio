import { describe, expect, it } from "vitest";
import { applyPacketLodBudgetReference, type PacketLodBudgetCandidate } from "./packetLodBudgetReference.js";

function candidates(count: number): PacketLodBudgetCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    selectedLevel: index % 3,
    triangles: index % 7 + 1,
    drawable: index % 11 !== 0,
    inFrustum: index % 13 !== 0,
  }));
}

describe("packet LOD stable-prefix budget reference", () => {
  it.each([128, 1_024])("keeps deterministic order and both global budgets for %i objects", (count) => {
    const input = candidates(count), result = applyPacketLodBudgetReference(input, Math.floor(count * 0.7), count * 2);
    const flattened = result.compactedIndices.flat();
    expect(flattened.length).toBe([...result.accepted].filter(Boolean).length);
    expect(result.levelCounts.reduce((sum, value) => sum + value, 0)).toBe(flattened.length);
    result.compactedIndices.forEach((indices, level) => {
      expect(indices).toEqual(indices.toSorted((left, right) => left - right));
      expect(indices.every(index => input[index]!.selectedLevel === level && result.accepted[index] === 1)).toBe(true);
    });
    expect(applyPacketLodBudgetReference(input, Math.floor(count * 0.7), count * 2).accepted)
      .toEqual(result.accepted);
  });

  it("stops accepting after an included prefix exceeds either budget", () => {
    const input = [5, 20, 1, 1].map((triangles, index) => ({
      selectedLevel: index % 2, triangles, drawable: true, inFrustum: true,
    }));
    expect([...applyPacketLodBudgetReference(input, 4, 10).accepted]).toEqual([1, 0, 0, 0]);
    expect([...applyPacketLodBudgetReference(input, 2, 100).accepted]).toEqual([1, 1, 0, 0]);
  });

  it("rejects invalid budgets and records", () => {
    expect(() => applyPacketLodBudgetReference([], -1, 1)).toThrow("object budget");
    expect(() => applyPacketLodBudgetReference([{ selectedLevel: 8, triangles: 1, drawable: true, inFrustum: true }], 1, 1))
      .toThrow("level is invalid");
  });
});
